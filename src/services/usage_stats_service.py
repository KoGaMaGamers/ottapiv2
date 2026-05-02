"""Provider pressure-monitoring queries.

Live snapshot + historical aggregates over `provider_pressure_samples`.
The snapshot job (`scheduler.py`) writes one row per (provider_id,
minute) by calling `collect_provider_pressure_samples`. The admin
dashboard reads via `build_provider_pressure_snapshot` (real-time) and
`get_provider_pressure_summary` / `get_provider_pressure_history`
(historical).

Renter classification (plan §1):
  valid     — provider_exp_date IS NULL OR provider_exp_date > now
  enforced  — provider_exp_date <= now AND subscription_enforced=True
  expired   — provider_exp_date <= now AND subscription_enforced=False

Allocation-kind:
  own       — slot.id == slot.allocation_locked_by_user_id
  donor     — slot.id != slot.allocation_locked_by_user_id

The "enforced renter" count is the user's headline metric: how much of
the active stream load is coming from accounts whose upstream
credentials are dead but whose enforced-expiry keeps them in the app
(and thus needing a donor).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Dict, List, Literal, Optional

from sqlalchemy.orm import Session, aliased

from ..models import IPTVUser, ProviderPressureSample, XtreamProvider
from .donor_service import is_eligible


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_lock_stale(user: IPTVUser, now: datetime) -> bool:
    return bool(
        user.allocation_in_use
        and user.allocation_lock_expires_at is not None
        and user.allocation_lock_expires_at <= now
    )


def _renter_kind(user: IPTVUser, now: datetime) -> str:
    """valid | enforced | expired (see module doc)."""
    exp = user.provider_exp_date
    if exp is None or exp > now:
        return "valid"
    return "enforced" if bool(user.subscription_enforced) else "expired"


# ---------------------------------------------------------------------------
# Snapshot — pure read, no writes
# ---------------------------------------------------------------------------

def build_provider_pressure_snapshot(
    db: Session,
    *,
    provider_id: Optional[int] = None,
    now: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    ts = now or datetime.utcnow()

    providers_q = db.query(XtreamProvider).order_by(XtreamProvider.id.asc())
    if provider_id is not None:
        providers_q = providers_q.filter(XtreamProvider.id == provider_id)
    providers = providers_q.all()
    if not providers:
        return []

    provider_ids = [p.id for p in providers]
    users = (
        db.query(IPTVUser)
        .filter(IPTVUser.provider_id.in_(provider_ids))
        .all()
    )
    users_by_provider: Dict[int, List[IPTVUser]] = defaultdict(list)
    for u in users:
        if u.provider_id is None:
            continue
        users_by_provider[int(u.provider_id)].append(u)

    # Slot rows currently in use, joined with their renter row so we can
    # classify each allocation. A renter being on its own slot counts as
    # "own"; on someone else's, "donor".
    Renter = aliased(IPTVUser)
    slot_rows = (
        db.query(IPTVUser, Renter)
        .outerjoin(Renter, IPTVUser.allocation_locked_by_user_id == Renter.id)
        .filter(
            IPTVUser.allocation_in_use == True,  # noqa: E712
            IPTVUser.provider_id.in_(provider_ids),
            IPTVUser.allocation_lock_expires_at > ts,
        )
        .all()
    )

    slots_by_provider: Dict[int, List[tuple[IPTVUser, Optional[IPTVUser]]]] = defaultdict(list)
    for slot, renter in slot_rows:
        slots_by_provider[int(slot.provider_id)].append((slot, renter))

    snapshot: List[Dict[str, Any]] = []
    for provider in providers:
        prov_users = users_by_provider.get(provider.id, [])
        prov_slots = slots_by_provider.get(provider.id, [])

        total_accounts = len(prov_users)
        eligible_accounts = 0
        expired_accounts = 0
        enforced_accounts = 0   # accounts with the flag set, regardless of expiry state
        locked_accounts = 0
        stale_locks = 0
        streaming_accounts = 0

        for u in prov_users:
            if is_eligible(u, ts):
                eligible_accounts += 1
            if (u.provider_exp_date is not None) and (u.provider_exp_date <= ts):
                expired_accounts += 1
            if bool(u.subscription_enforced):
                enforced_accounts += 1
            if bool(u.allocation_in_use):
                locked_accounts += 1
            if _is_lock_stale(u, ts):
                stale_locks += 1
            if bool(u.is_streaming):
                streaming_accounts += 1

        in_use_allocations = len(prov_slots)
        own_allocations = 0
        donor_allocations = 0
        enforced_renter_allocations = 0
        valid_renter_allocations = 0

        for slot, renter in prov_slots:
            # Treat a missing renter row (orphaned lock) as "own" to
            # avoid mis-attributing pressure; the sweeper will clear
            # those quickly.
            if renter is None or slot.id == renter.id:
                own_allocations += 1
            else:
                donor_allocations += 1
            if renter is not None:
                kind = _renter_kind(renter, ts)
                if kind == "enforced":
                    enforced_renter_allocations += 1
                elif kind == "valid":
                    valid_renter_allocations += 1
                # expired renters are tracked via expired_accounts on the
                # account side; they shouldn't reach here in practice
                # because is_eligible blocks them at allocation time.

        free_eligible_accounts = max(0, eligible_accounts - locked_accounts)
        donor_pressure_pct = round(
            (in_use_allocations / max(1, eligible_accounts)) * 100, 2,
        )
        enforced_pressure_pct = round(
            (enforced_renter_allocations / max(1, eligible_accounts)) * 100, 2,
        )

        snapshot.append({
            "provider_id":                    provider.id,
            "provider_name":                  provider.name,
            "total_accounts":                 total_accounts,
            "eligible_accounts":              eligible_accounts,
            "free_eligible_accounts":         free_eligible_accounts,
            "expired_accounts":               expired_accounts,
            "subscription_enforced_accounts": enforced_accounts,
            "streaming_accounts":             streaming_accounts,
            "locked_accounts":                locked_accounts,
            "stale_locks":                    stale_locks,
            "in_use_allocations":             in_use_allocations,
            "own_allocations":                own_allocations,
            "donor_allocations":              donor_allocations,
            "enforced_renter_allocations":    enforced_renter_allocations,
            "valid_renter_allocations":       valid_renter_allocations,
            "donor_pressure_pct":             donor_pressure_pct,
            "enforced_pressure_pct":          enforced_pressure_pct,
        })
    return snapshot


# ---------------------------------------------------------------------------
# Periodic snapshot writer
# ---------------------------------------------------------------------------

def collect_provider_pressure_samples(
    db: Session,
    *,
    provider_id: Optional[int] = None,
    now: Optional[datetime] = None,
) -> int:
    """Write one row per provider for the current minute. Idempotent
    on `(provider_id, snapshot_at)` — a second call within the same
    minute is a no-op."""
    ts = (now or datetime.utcnow()).replace(second=0, microsecond=0)
    rows = build_provider_pressure_snapshot(db, provider_id=provider_id, now=ts)
    if not rows:
        return 0

    pids = [int(row["provider_id"]) for row in rows]
    existing = {
        pid for (pid,) in (
            db.query(ProviderPressureSample.provider_id)
            .filter(
                ProviderPressureSample.snapshot_at == ts,
                ProviderPressureSample.provider_id.in_(pids),
            )
            .all()
        )
    }

    inserted = 0
    for row in rows:
        pid = int(row["provider_id"])
        if pid in existing:
            continue
        db.add(ProviderPressureSample(
            provider_id=pid,
            snapshot_at=ts,
            total_accounts=int(row["total_accounts"]),
            eligible_accounts=int(row["eligible_accounts"]),
            free_eligible_accounts=int(row["free_eligible_accounts"]),
            expired_accounts=int(row["expired_accounts"]),
            subscription_enforced_accounts=int(row["subscription_enforced_accounts"]),
            streaming_accounts=int(row["streaming_accounts"]),
            locked_accounts=int(row["locked_accounts"]),
            stale_locks=int(row["stale_locks"]),
            in_use_allocations=int(row["in_use_allocations"]),
            own_allocations=int(row["own_allocations"]),
            donor_allocations=int(row["donor_allocations"]),
            enforced_renter_allocations=int(row["enforced_renter_allocations"]),
            valid_renter_allocations=int(row["valid_renter_allocations"]),
            donor_pressure_pct=float(row["donor_pressure_pct"]),
            enforced_pressure_pct=float(row["enforced_pressure_pct"]),
        ))
        inserted += 1
    return inserted


def prune_old_pressure_samples(db: Session, *, days: int = 30) -> int:
    """Drop samples older than `days`. Run once daily."""
    cutoff = datetime.utcnow() - timedelta(days=days)
    n = (
        db.query(ProviderPressureSample)
        .filter(ProviderPressureSample.snapshot_at < cutoff)
        .delete(synchronize_session=False)
    )
    return int(n)


# ---------------------------------------------------------------------------
# Aggregates for the dashboard
# ---------------------------------------------------------------------------

def _summarize(rows: List[ProviderPressureSample]) -> Dict[str, Any]:
    if not rows:
        return {
            "sample_count":              0,
            "avg_donor_pressure_pct":    0.0,
            "peak_donor_pressure_pct":   0.0,
            "avg_enforced_pressure_pct": 0.0,
            "peak_enforced_pressure_pct": 0.0,
            "avg_in_use_allocations":    0.0,
            "peak_in_use_allocations":   0,
            "avg_enforced_renter_allocations": 0.0,
            "peak_enforced_renter_allocations": 0,
        }
    n = len(rows)
    return {
        "sample_count":              n,
        "avg_donor_pressure_pct":    round(sum(float(r.donor_pressure_pct or 0) for r in rows) / n, 2),
        "peak_donor_pressure_pct":   round(max(float(r.donor_pressure_pct or 0) for r in rows), 2),
        "avg_enforced_pressure_pct": round(sum(float(r.enforced_pressure_pct or 0) for r in rows) / n, 2),
        "peak_enforced_pressure_pct": round(max(float(r.enforced_pressure_pct or 0) for r in rows), 2),
        "avg_in_use_allocations":    round(sum(int(r.in_use_allocations or 0) for r in rows) / n, 2),
        "peak_in_use_allocations":   max(int(r.in_use_allocations or 0) for r in rows),
        "avg_enforced_renter_allocations":  round(sum(int(r.enforced_renter_allocations or 0) for r in rows) / n, 2),
        "peak_enforced_renter_allocations": max(int(r.enforced_renter_allocations or 0) for r in rows),
    }


def get_provider_pressure_summary(
    db: Session,
    *,
    provider_id: Optional[int] = None,
    now: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    ts = now or datetime.utcnow()
    providers_q = db.query(XtreamProvider).order_by(XtreamProvider.id.asc())
    if provider_id is not None:
        providers_q = providers_q.filter(XtreamProvider.id == provider_id)
    providers = providers_q.all()
    if not providers:
        return []

    pids = [p.id for p in providers]
    day_start = ts - timedelta(days=1)
    hour_start = ts - timedelta(hours=1)

    rows = (
        db.query(ProviderPressureSample)
        .filter(
            ProviderPressureSample.provider_id.in_(pids),
            ProviderPressureSample.snapshot_at >= day_start,
            ProviderPressureSample.snapshot_at <= ts,
        )
        .order_by(
            ProviderPressureSample.provider_id.asc(),
            ProviderPressureSample.snapshot_at.asc(),
        )
        .all()
    )
    by_provider: Dict[int, List[ProviderPressureSample]] = defaultdict(list)
    for r in rows:
        by_provider[int(r.provider_id)].append(r)

    out: List[Dict[str, Any]] = []
    for p in providers:
        prov_rows = by_provider.get(p.id, [])
        hour_rows = [r for r in prov_rows if r.snapshot_at >= hour_start]
        latest = prov_rows[-1].snapshot_at if prov_rows else None
        out.append({
            "provider_id":         p.id,
            "provider_name":       p.name,
            "latest_snapshot_at":  latest.isoformat() if latest else None,
            "last_hour":           _summarize(hour_rows),
            "last_day":            _summarize(prov_rows),
        })
    return out


def get_provider_pressure_history(
    db: Session,
    *,
    provider_id: Optional[int] = None,
    range_name: Literal["hour", "day"] = "hour",
    interval_minutes: int = 1,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    ts = now or datetime.utcnow()
    if range_name == "day":
        window_start = ts - timedelta(days=1)
    else:
        window_start = ts - timedelta(hours=1)

    providers_q = db.query(XtreamProvider).order_by(XtreamProvider.id.asc())
    if provider_id is not None:
        providers_q = providers_q.filter(XtreamProvider.id == provider_id)
    providers = providers_q.all()
    if not providers:
        return {
            "window_start": window_start.isoformat(),
            "window_end":   ts.isoformat(),
            "providers":    [],
        }

    pids = [p.id for p in providers]
    rows = (
        db.query(ProviderPressureSample)
        .filter(
            ProviderPressureSample.provider_id.in_(pids),
            ProviderPressureSample.snapshot_at >= window_start,
            ProviderPressureSample.snapshot_at <= ts,
        )
        .order_by(
            ProviderPressureSample.provider_id.asc(),
            ProviderPressureSample.snapshot_at.asc(),
        )
        .all()
    )

    interval_minutes = max(1, int(interval_minutes))
    buckets: Dict[int, Dict[datetime, List[ProviderPressureSample]]] = defaultdict(lambda: defaultdict(list))
    for r in rows:
        bucket = r.snapshot_at.replace(second=0, microsecond=0)
        bucket = bucket.replace(minute=(bucket.minute // interval_minutes) * interval_minutes)
        buckets[int(r.provider_id)][bucket].append(r)

    payload: List[Dict[str, Any]] = []
    for p in providers:
        provb = buckets.get(p.id, {})
        points: List[Dict[str, Any]] = []
        for bucket_at in sorted(provb.keys()):
            chunk = provb[bucket_at]
            n = len(chunk)
            points.append({
                "bucket_at":                  bucket_at.isoformat(),
                "sample_count":               n,
                "avg_donor_pressure_pct":     round(sum(float(r.donor_pressure_pct or 0) for r in chunk) / n, 2),
                "peak_donor_pressure_pct":    round(max(float(r.donor_pressure_pct or 0) for r in chunk), 2),
                "avg_enforced_pressure_pct":  round(sum(float(r.enforced_pressure_pct or 0) for r in chunk) / n, 2),
                "peak_enforced_pressure_pct": round(max(float(r.enforced_pressure_pct or 0) for r in chunk), 2),
                "avg_in_use_allocations":     round(sum(int(r.in_use_allocations or 0) for r in chunk) / n, 2),
                "peak_in_use_allocations":    max(int(r.in_use_allocations or 0) for r in chunk),
                "avg_enforced_renter_allocations":  round(sum(int(r.enforced_renter_allocations or 0) for r in chunk) / n, 2),
                "peak_enforced_renter_allocations": max(int(r.enforced_renter_allocations or 0) for r in chunk),
            })
        payload.append({
            "provider_id":   p.id,
            "provider_name": p.name,
            "points":        points,
        })

    return {
        "window_start": window_start.isoformat(),
        "window_end":   ts.isoformat(),
        "providers":    payload,
    }
