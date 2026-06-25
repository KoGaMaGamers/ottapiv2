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

import requests
from sqlalchemy import or_, update
from sqlalchemy.orm import Session

from ..config import ALLOCATION_TTL_SEC
from ..database import SessionLocal
from ..models import IPTVUser

logger = logging.getLogger(__name__)

# How long to quarantine a donor whose creds returned 401 (or whose probe
# said `auth=0`). Long enough that a transient upstream blip doesn't churn
# the pool, short enough that a reactivated sub recovers within an hour.
DONOR_UNHEALTHY_TTL_SEC = 1800           # 30 min
# Skip the pre-flight probe if a donor's creds were verified within this
# window — keeps cold-path latency tolerable when the same few donors
# absorb most traffic.
DONOR_HEALTH_FRESH_SEC = 600             # 10 min
DONOR_PROBE_TIMEOUT_SEC = 3.5


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


def _is_donor_healthy(user: IPTVUser, now: datetime) -> bool:
    """False when this slot is currently quarantined (recent 401 / failed
    probe). Quarantine expires automatically — no manual unblock needed."""
    return user.donor_unhealthy_until is None or user.donor_unhealthy_until <= now


def _mark_donor_unhealthy(db: Session, slot: IPTVUser, now: datetime, *, reason: str) -> None:
    until = now + timedelta(seconds=DONOR_UNHEALTHY_TTL_SEC)
    db.execute(
        update(IPTVUser)
        .where(IPTVUser.id == slot.id)
        .values(donor_unhealthy_until=until)
    )
    db.commit()
    logger.warning("donor unhealthy: slot=%s(id=%d) until=%s reason=%s",
                   slot.username, slot.id, until.isoformat(), reason)


def _probe_donor_creds(slot: IPTVUser) -> Optional[bool]:
    """Hit the donor's player_api.php and read user_info.auth.

    Returns True when creds are accepted, False when explicitly rejected
    (HTTP 4xx or `auth=0`), None on timeout / network failure (so the
    caller can decide whether to retry vs. trust prior state).
    """
    base = (slot.base_url or "").rstrip("/")
    if not base:
        return None
    url = f"{base}/player_api.php"
    try:
        r = requests.get(
            url,
            params={"username": slot.username, "password": slot.password},
            timeout=DONOR_PROBE_TIMEOUT_SEC,
            headers={"User-Agent": "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1"},
        )
    except requests.exceptions.RequestException as exc:
        logger.info("donor probe network error: slot=%s err=%s", slot.username, exc)
        return None
    if r.status_code in (401, 403):
        return False
    if r.status_code >= 500:
        return None  # upstream hiccup — don't penalize the donor
    if not r.ok:
        return False
    try:
        body = r.json()
    except ValueError:
        return None
    info = body.get("user_info") if isinstance(body, dict) else None
    if not isinstance(info, dict):
        return None
    auth = info.get("auth")
    # Xtream returns auth=1 for OK, auth=0 for failed; treat anything else
    # as inconclusive rather than fabricating a verdict.
    if auth in (1, "1", True):
        return True
    if auth in (0, "0", False):
        return False
    return None


def verify_donor(db: Session, slot: IPTVUser, now: Optional[datetime] = None,
                 *, force: bool = False) -> bool:
    """Return True when *slot* is currently usable as a donor; False to skip.

    Skips the probe if a recent verification already succeeded; otherwise
    runs it. On a definitive failure marks the donor unhealthy so future
    selections skip it without re-probing.
    """
    now = now or datetime.utcnow()
    if not _is_donor_healthy(slot, now):
        return False
    if (
        not force
        and slot.donor_health_verified_at is not None
        and slot.donor_health_verified_at >= now - timedelta(seconds=DONOR_HEALTH_FRESH_SEC)
    ):
        return True
    verdict = _probe_donor_creds(slot)
    if verdict is True:
        db.execute(
            update(IPTVUser)
            .where(IPTVUser.id == slot.id)
            .values(donor_health_verified_at=now)
        )
        db.commit()
        return True
    if verdict is False:
        _mark_donor_unhealthy(db, slot, now, reason="probe auth=0/4xx")
        return False
    # verdict is None — inconclusive. Use cached state: if previously
    # verified, trust it; otherwise be conservative and skip without
    # quarantining (a network blip shouldn't burn an unproven donor).
    return slot.donor_health_verified_at is not None


def report_bad_donor(db: Session, slot: IPTVUser, *, reason: str = "client 401") -> None:
    """Public wrapper used by the play router when a client reports that
    a donor URL returned 401 mid-stream."""
    _mark_donor_unhealthy(db, slot, datetime.utcnow(), reason=reason)


def _needs_donor(user: IPTVUser, now: datetime) -> bool:
    """True when this user MUST play through someone else's slot — their
    own upstream credentials are dead but the app keeps them active via
    `subscription_enforced`. Letting these users play on their own slot
    would build a stream URL with expired creds and the upstream returns
    401, even though the user is "eligible" from the app's perspective.
    """
    if not user.subscription_enforced:
        return False
    if user.provider_exp_date is None:
        return False   # no upstream signal — assume own creds work
    return user.provider_exp_date <= now


def pick_url_owner(
    db: Session, requester: IPTVUser, now: Optional[datetime] = None,
) -> Optional[IPTVUser]:
    """Return the IPTVUser whose creds should appear in a stream URL
    built for `requester`. Same as `requester` when their own upstream
    works; otherwise an LRU same-provider valid donor.

    This is the *non-locking* counterpart of allocate_or_reuse — used by
    the preview endpoints, where we need a working URL but don't want
    to claim a slot. Called per-request from a cold path; no caching.
    """
    now = now or datetime.utcnow()
    if not _needs_donor(requester, now):
        return requester

    candidates = (
        db.query(IPTVUser)
        .filter(IPTVUser.provider_id == requester.provider_id)
        .filter(IPTVUser.id != requester.id)
        .filter(IPTVUser.status.in_(["Active", "Almost Expired"]))
        .filter(or_(
            IPTVUser.donor_unhealthy_until.is_(None),
            IPTVUser.donor_unhealthy_until <= now,
        ))
        .order_by(IPTVUser.allocation_last_released_at.asc())
        .all()
    )
    for cand in candidates:
        if not is_eligible(cand, now):
            continue
        if not verify_donor(db, cand, now):
            continue
        return cand
    return None


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

    must_use_donor = _needs_donor(owner, now)

    # 0. Reuse: owner already has a valid lock? Idempotent /play resume.
    existing = (
        db.query(IPTVUser)
        .filter(IPTVUser.allocation_locked_by_user_id == owner.id)
        .filter(IPTVUser.allocation_in_use == True)  # noqa: E712
        .filter(IPTVUser.allocation_lock_expires_at > now)
        .first()
    )
    if existing is not None:
        # An enforced user pinned to their OWN row is a bug-from-before:
        # their upstream creds are dead, so the stream URL won't play.
        # Release the bogus lock and fall through to the donor pool.
        if must_use_donor and existing.id == owner.id:
            existing.allocation_in_use = False
            existing.allocation_locked_by_user_id = None
            existing.allocation_lock_token = None
            existing.allocation_lock_expires_at = None
            existing.allocation_last_released_at = now
            existing.is_streaming = False
            existing.current_stream_kind = None
            existing.current_stream_ref = None
            db.commit()
        else:
            new_expires = now + timedelta(seconds=ALLOCATION_TTL_SEC)
            existing.allocation_lock_expires_at = new_expires
            db.commit()
            return Allocation(slot=existing, token=existing.allocation_lock_token, expires_at=new_expires)

    # 1. Prefer-own — only when the owner's own upstream creds still work.
    if not must_use_donor:
        token = _try_claim(db, owner.id, owner.id, now)
        if token:
            db.refresh(owner)
            return Allocation(slot=owner, token=token, expires_at=owner.allocation_lock_expires_at)

    # 2. Donor pool (LRU). Filter out quarantined donors at SQL time so
    # the loop doesn't iterate over slots we already know are dead.
    candidates = (
        db.query(IPTVUser)
        .filter(IPTVUser.provider_id == owner.provider_id)
        .filter(IPTVUser.id != owner.id)
        .filter(IPTVUser.status.in_(["Active", "Almost Expired"]))
        .filter(or_(
            IPTVUser.allocation_in_use == False,  # noqa: E712
            IPTVUser.allocation_lock_expires_at < now,
        ))
        .filter(or_(
            IPTVUser.donor_unhealthy_until.is_(None),
            IPTVUser.donor_unhealthy_until <= now,
        ))
        .order_by(IPTVUser.allocation_last_released_at.asc())
        .all()
    )
    for slot in candidates:
        if not is_eligible(slot, now):
            continue
        # Pre-flight: don't claim a slot whose creds the upstream is
        # currently rejecting. verify_donor() short-circuits on a recent
        # success so most allocations skip the network probe entirely.
        if not verify_donor(db, slot, now):
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

def build_stream_url(
    slot: IPTVUser, kind: str, xtream_id: int, ext: str,
    db: Optional[Session] = None,
) -> str:
    """Construct a playback URL using the chosen slot's creds.

    kind: "live" | "movie" | "series"

    When *db* is provided the base URL is rewritten through
    ``dns_health_service.rewrite_to_healthy`` so a slot whose stored
    ``base_url`` points at dead infrastructure transparently swaps to a
    live domain from the same provider.
    """
    base = (slot.base_url or "").rstrip("/")
    if db is not None and slot.provider_id is not None:
        from .dns_health_service import rewrite_to_healthy
        base = rewrite_to_healthy(db, slot.provider_id, base)
    return f"{base}/{kind}/{slot.username}/{slot.password}/{xtream_id}.{ext}"
