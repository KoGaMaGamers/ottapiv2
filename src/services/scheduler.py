import logging

from apscheduler.schedulers.background import BackgroundScheduler

from ..config import GOLDENOTT_SYNC_INTERVAL_HOURS
from .goldenott_sync import run_sync

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(timezone="UTC")
    _scheduler.add_job(
        run_sync,
        trigger="interval",
        hours=GOLDENOTT_SYNC_INTERVAL_HOURS,
        id="goldenott_sync",
        name="GoldenOTT users + brand domain sync",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    _scheduler.start()
    logger.info(
        "Scheduler started: goldenott_sync every %d hours",
        GOLDENOTT_SYNC_INTERVAL_HOURS,
    )


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
    logger.info("Scheduler stopped")
