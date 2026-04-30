import logging

from apscheduler.schedulers.background import BackgroundScheduler

from ..config import (
    ALLOCATION_SWEEP_INTERVAL_SEC,
    CATALOG_SYNC_INTERVAL_HOURS,
    GOLDENOTT_SYNC_INTERVAL_HOURS,
    SPORT_EVENTS_REFRESH_INTERVAL_HOURS,
)
from ..database import SessionLocal
from ..models import XtreamProvider
from .catalog_sync import run_catalog_sync
from .donor_service import sweep_expired_locks
from .goldenott_sync import run_sync as run_goldenott_sync
from .sport_events_runner import run_sport_events_refresh

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def _run_all_provider_catalog_syncs() -> None:
    """Iterate every populated provider and run a catalog sync for each.

    Sequential so we don't hammer multiple upstreams or overrun rate limits
    on shared infrastructure. Skips providers without a master account or
    with a sync already in progress.
    """
    db = SessionLocal()
    try:
        providers = (
            db.query(XtreamProvider)
            .filter(XtreamProvider.is_populated == True)  # noqa: E712
            .all()
        )
        provider_ids = [p.id for p in providers]
    finally:
        db.close()

    logger.info("scheduled catalog sync starting for %d provider(s)", len(provider_ids))
    for pid in provider_ids:
        try:
            run_catalog_sync(pid)
        except Exception:
            logger.exception("scheduled catalog sync failed for provider id=%s", pid)


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(timezone="UTC")

    _scheduler.add_job(
        run_goldenott_sync,
        trigger="interval",
        hours=GOLDENOTT_SYNC_INTERVAL_HOURS,
        id="goldenott_sync",
        name="GoldenOTT users + brand domain sync",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    _scheduler.add_job(
        _run_all_provider_catalog_syncs,
        trigger="interval",
        hours=CATALOG_SYNC_INTERVAL_HOURS,
        id="catalog_sync_all",
        name="Per-provider catalog sync (all populated providers)",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    _scheduler.add_job(
        sweep_expired_locks,
        trigger="interval",
        seconds=ALLOCATION_SWEEP_INTERVAL_SEC,
        id="allocation_sweeper",
        name="Reclaim allocation locks past their TTL",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    _scheduler.add_job(
        run_sport_events_refresh,
        trigger="interval",
        hours=SPORT_EVENTS_REFRESH_INTERVAL_HOURS,
        id="sport_events_refresh",
        name="Sport events curation (Claude skill)",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
        kwargs={"triggered_by": "schedule", "dry_run": False},
    )

    _scheduler.start()
    logger.info(
        "Scheduler started: goldenott_sync every %dh, catalog_sync_all every %dh, "
        "sport_events_refresh every %dh, "
        "allocation_sweeper every %ds",
        GOLDENOTT_SYNC_INTERVAL_HOURS, CATALOG_SYNC_INTERVAL_HOURS,
        SPORT_EVENTS_REFRESH_INTERVAL_HOURS,
        ALLOCATION_SWEEP_INTERVAL_SEC,
    )


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
    logger.info("Scheduler stopped")
