import logging

from apscheduler.schedulers.background import BackgroundScheduler

from ..config import (
    ALLOCATION_SWEEP_INTERVAL_SEC,
    CATALOG_SYNC_INTERVAL_HOURS,
    GOLDENOTT_SYNC_INTERVAL_HOURS,
)
from ..database import SessionLocal
from ..models import XtreamProvider
from .catalog_sync import run_catalog_sync
from .donor_service import sweep_expired_locks
from .goldenott_sync import run_sync as run_goldenott_sync
from .dns_health_service import check_all_dns_health, seed_from_users
from .usage_stats_service import (
    collect_provider_pressure_samples,
    prune_old_pressure_samples,
)

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


def _run_pressure_sample() -> None:
    db = SessionLocal()
    try:
        n = collect_provider_pressure_samples(db)
        db.commit()
        # Logged at INFO so the journal shows minute-by-minute heartbeat
        # during live events — the sampler is the dashboard's source of
        # truth, and silence there has been mistaken for "the page is
        # broken" before.
        if n:
            logger.info("pressure_sample wrote %d row(s)", n)
    except Exception:
        db.rollback()
        logger.exception("pressure_sample failed")
    finally:
        db.close()


def _run_dns_health_check() -> None:
    results = check_all_dns_health()
    if results.get("changed"):
        logger.info("dns_health_check: %s", results)


def _run_dns_seed() -> None:
    """One-shot on startup: make sure every parent domain in iptv_users
    is tracked in provider_dns_entries."""
    db = SessionLocal()
    try:
        seed_from_users(db)
    except Exception:
        logger.exception("dns_seed failed")
    finally:
        db.close()


def _run_pressure_prune() -> None:
    db = SessionLocal()
    try:
        n = prune_old_pressure_samples(db, days=30)
        db.commit()
        if n:
            logger.info("pressure_prune deleted %d sample(s) older than 30d", n)
    except Exception:
        db.rollback()
        logger.exception("pressure_prune failed")
    finally:
        db.close()


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
        _run_pressure_sample,
        trigger="interval",
        minutes=1,
        id="pressure_sample",
        name="Provider pressure sampler (1-min cadence)",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    _scheduler.add_job(
        _run_pressure_prune,
        trigger="cron",
        hour=4, minute=15,
        id="pressure_prune",
        name="Pressure-sample 30-day retention prune",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    _scheduler.add_job(
        _run_dns_health_check,
        trigger="interval",
        minutes=5,
        id="dns_health_check",
        name="Provider DNS health probe (5-min cadence)",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    # Seed DNS entries from user base_urls on first tick (10s after boot)
    _scheduler.add_job(
        _run_dns_seed,
        trigger="date",
        run_date=None,  # run immediately
        id="dns_seed",
        name="Seed provider_dns_entries from iptv_users (one-shot)",
    )
    # Sport-events curation runs as a separate systemd timer (see
    # deploy/ottapi-sport-events.timer) so it can fire as root and
    # access /root/.claude/. It deliberately is NOT an APScheduler job
    # in this uvicorn process — uvicorn runs as www-data and can't
    # read the Max-plan OAuth file.

    _scheduler.start()
    logger.info(
        "Scheduler started: goldenott_sync every %dh, catalog_sync_all every %dh, "
        "allocation_sweeper every %ds, pressure_sample every 60s, "
        "dns_health_check every 5m, pressure_prune daily at 04:15 UTC",
        GOLDENOTT_SYNC_INTERVAL_HOURS, CATALOG_SYNC_INTERVAL_HOURS,
        ALLOCATION_SWEEP_INTERVAL_SEC,
    )


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
    logger.info("Scheduler stopped")
