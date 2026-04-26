"""Slot allocation, heartbeat, release.

Each ``iptv_users`` row is a "slot" — a (dns_link, username, password) triple
serving content from one provider. State is tracked on the row itself via
the ``allocation_*`` columns inherited from the legacy schema. Allocation
strategy:

  1. If owner already has a valid lock, return it (idempotent /play resume).
  2. Try owner's own slot via atomic UPDATE.
  3. Fall back to the donor pool (same-provider slots, LRU on
     ``allocation_last_released_at``) — atomic claim per candidate.

Race-safety: atomic ``UPDATE … WHERE allocation_in_use=0 OR
allocation_lock_expires_at < now`` — if rowcount==1 we won the race; if 0 we
move on. No SELECT-FOR-UPDATE.

A periodic sweeper releases rows whose lock has expired. Belt-and-suspenders
against orphaned locks (app crash, network drop without explicit /release).
"""

import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import or_, update
from sqlalchemy.orm import Session

from ..config import ALLOCATION_TTL_SEC
from ..database import SessionLocal
from ..models import IPTVUser

logger = logging.getLogger(__name__)


@dataclass
class Allocation:
    slot: IPTVUser
    token: str
    expires_at: datetime


# ---------------------------------------------------------------------------
# Eligibility helpers
# ---------------------------------------------------------------------------

def get_effective_exp_date(user: IPTVUser) -> Optional[datetime]:
    if user.subscription_enforced and user.subscription_exp_date:
        return user.subscription_exp_date
    return user.provider_exp_date


def is_eligible(user: IPTVUser, now: Optional[datetime] = None) -> bool:
    """Slot/owner is eligible to serve / receive content?

    Excludes accounts that are removed or banned, or whose effective
    expiration has passed.
    """
    if user.status in {"Removed", "Banned"}:
        return False
    eff = get_effective_exp_date(user)
    if eff is None:
        return False
    return eff > (now or datetime.utcnow())


# ---------------------------------------------------------------------------
# Atomic claim
# ---------------------------------------------------------------------------

def _try_claim(db: Session, slot_id: int, owner_id: int, now: datetime) -> Optional[str]:
    token = secrets.token_urlsafe(16)
    expires = now + timedelta(seconds=ALLOCATION_TTL_SEC)
    result = db.execute(
        update(IPTVUser)
        .where(IPTVUser.id == slot_id)
        .where(or_(
            IPTVUser.allocation_in_use == False,  # noqa: E712
            IPTVUser.allocation_lock_expires_at < now,
        ))
        .values(
            allocation_in_use=True,
            allocation_locked_by_user_id=owner_id,
            allocation_lock_token=token,
            allocation_locked_at=now,
            allocation_lock_expires_at=expires,
        )
    )
    db.commit()
    return token if result.rowcount == 1 else None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def allocate_or_reuse(db: Session, owner: IPTVUser) -> Optional[Allocation]:
    """Return an Allocation for *owner* (prefer-own → donor LRU) or None.

    None is returned in two cases — caller should distinguish:
      - owner not eligible (subscription expired, account removed/banned)
      - pool exhausted (every eligible slot is currently busy)
    """
    now = datetime.utcnow()

    if not is_eligible(owner, now):
        return None

    # 0. Reuse: owner already has a valid lock? Idempotent /play resume.
    existing = (
        db.query(IPTVUser)
        .filter(IPTVUser.allocation_locked_by_user_id == owner.id)
        .filter(IPTVUser.allocation_in_use == True)  # noqa: E712
        .filter(IPTVUser.allocation_lock_expires_at > now)
        .first()
    )
    if existing is not None:
        new_expires = now + timedelta(seconds=ALLOCATION_TTL_SEC)
        existing.allocation_lock_expires_at = new_expires
        db.commit()
        return Allocation(slot=existing, token=existing.allocation_lock_token, expires_at=new_expires)

    # 1. Prefer-own.
    token = _try_claim(db, owner.id, owner.id, now)
    if token:
        db.refresh(owner)
        return Allocation(slot=owner, token=token, expires_at=owner.allocation_lock_expires_at)

    # 2. Donor pool (LRU).
    candidates = (
        db.query(IPTVUser)
        .filter(IPTVUser.provider_id == owner.provider_id)
        .filter(IPTVUser.id != owner.id)
        .filter(IPTVUser.status.in_(["Active", "Almost Expired"]))
        .filter(or_(
            IPTVUser.allocation_in_use == False,  # noqa: E712
            IPTVUser.allocation_lock_expires_at < now,
        ))
        .order_by(IPTVUser.allocation_last_released_at.asc())
        .all()
    )
    for slot in candidates:
        if not is_eligible(slot, now):
            continue
        token = _try_claim(db, slot.id, owner.id, now)
        if token:
            db.refresh(slot)
            return Allocation(slot=slot, token=token, expires_at=slot.allocation_lock_expires_at)

    return None  # pool exhausted


def heartbeat(
    db: Session,
    owner: IPTVUser,
    allocation_token: str,
    is_streaming: bool,
    *,
    stream_kind: Optional[str] = None,
    stream_ref: Optional[str] = None,
) -> Optional[Allocation]:
    """Extend lock when ``is_streaming=True``; record telemetry either way.

    Returns the (refreshed) Allocation, or None if the token is invalid or
    has already been released.
    """
    now = datetime.utcnow()
    slot = (
        db.query(IPTVUser)
        .filter(IPTVUser.allocation_locked_by_user_id == owner.id)
        .filter(IPTVUser.allocation_lock_token == allocation_token)
        .filter(IPTVUser.allocation_in_use == True)  # noqa: E712
        .first()
    )
    if slot is None:
        return None

    slot.last_heartbeat_at = now
    slot.is_streaming = bool(is_streaming)
    if stream_kind is not None:
        slot.current_stream_kind = stream_kind[:20]
    if stream_ref is not None:
        slot.current_stream_ref = str(stream_ref)[:255]

    if is_streaming:
        slot.allocation_lock_expires_at = now + timedelta(seconds=ALLOCATION_TTL_SEC)
        slot.last_activity_at = now

    db.commit()
    return Allocation(slot=slot, token=allocation_token, expires_at=slot.allocation_lock_expires_at)


def release(db: Session, owner: IPTVUser, allocation_token: str) -> bool:
    """Free a slot held by ``owner``. Returns True on success, False if no
    matching active lock was found."""
    now = datetime.utcnow()
    slot = (
        db.query(IPTVUser)
        .filter(IPTVUser.allocation_locked_by_user_id == owner.id)
        .filter(IPTVUser.allocation_lock_token == allocation_token)
        .filter(IPTVUser.allocation_in_use == True)  # noqa: E712
        .first()
    )
    if slot is None:
        return False
    slot.allocation_in_use = False
    slot.allocation_locked_by_user_id = None
    slot.allocation_lock_token = None
    slot.allocation_lock_expires_at = None
    slot.allocation_last_released_at = now
    slot.is_streaming = False
    slot.current_stream_kind = None
    slot.current_stream_ref = None
    db.commit()
    return True


def sweep_expired_locks() -> int:
    """Periodic sweeper: forcibly release rows whose lock has expired.

    Called by APScheduler. Returns the number of rows reclaimed.
    """
    db: Session = SessionLocal()
    try:
        now = datetime.utcnow()
        result = db.execute(
            update(IPTVUser)
            .where(IPTVUser.allocation_in_use == True)  # noqa: E712
            .where(IPTVUser.allocation_lock_expires_at < now)
            .values(
                allocation_in_use=False,
                allocation_locked_by_user_id=None,
                allocation_lock_token=None,
                allocation_lock_expires_at=None,
                allocation_last_released_at=now,
                is_streaming=False,
                current_stream_kind=None,
                current_stream_ref=None,
            )
        )
        db.commit()
        n = result.rowcount or 0
        if n:
            logger.info("allocation sweeper: released %d expired lock(s)", n)
        return n
    except Exception:
        logger.exception("allocation sweeper failed")
        db.rollback()
        return 0
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Stream URL builder
# ---------------------------------------------------------------------------

def build_stream_url(slot: IPTVUser, kind: str, xtream_id: int, ext: str) -> str:
    """Construct a playback URL using the chosen slot's creds.

    kind: "live" | "movie" | "series"
    """
    base = (slot.base_url or "").rstrip("/")
    return f"{base}/{kind}/{slot.username}/{slot.password}/{xtream_id}.{ext}"
