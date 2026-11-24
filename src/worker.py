"""Background-job worker: runs the APScheduler jobs outside the API.

    python -m src.worker      (systemd: ottapi-v2-worker.service)

Keeping catalog sync / TMDB enrichment / GoldenOTT sync out of the API
process means a heavy job can't starve request threads or inflate the API's
memory, and the API can run several uvicorn workers without each one
starting its own scheduler (the API sets RUN_SCHEDULER=false).
"""

from __future__ import annotations

import logging
import signal
import sys
import threading

from . import log_redact

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stdout,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    force=True,
)
for _name in ("apscheduler.scheduler", "apscheduler.executors.default",
              "sqlalchemy.engine", "httpx"):
    logging.getLogger(_name).setLevel(logging.WARNING)
log_redact.install(("",))

from .services import memwatch  # noqa: E402
from .services.auth_service import assert_secret_configured  # noqa: E402
from .services.scheduler import start_scheduler, stop_scheduler  # noqa: E402

logger = logging.getLogger("src.worker")


def main() -> None:
    assert_secret_configured()
    stop = threading.Event()

    def _on_signal(signum, _frame):
        logger.info("worker: signal %s, shutting down", signum)
        stop.set()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    start_scheduler()
    memwatch.start_sampler()
    logger.info("worker: scheduler running")
    stop.wait()
    memwatch.stop_sampler()
    stop_scheduler()
    logger.info("worker: stopped")


if __name__ == "__main__":
    main()
