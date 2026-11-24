"""Lightweight in-process memory watch, to find what grows the worker's RSS.

Three signals, all logged under ``src.services.memwatch``:

1. Request jumps — pure ASGI middleware reads RSS before a request and when
   its response finishes; logs a WARNING if RSS grew by >= MEMWATCH_JUMP_MB.
   (Concurrent requests can share the blame; repeated hits on one path are
   what matters.)
2. Scheduler-job jumps — same check around every APScheduler job run.
3. Periodic sample — every MEMWATCH_SAMPLE_SEC: RSS, thread count, live
   Python object count and the object types that grew most since the last
   sample. RSS rising while object counts stay flat = allocator
   fragmentation; both rising = a real Python-level leak (and the type
   names point at it).

Cheap: RSS is one read of /proc/self/statm. The periodic sample walks
gc.get_objects() once per interval (~0.5s at ~1M objects).

Env: MEMWATCH_ENABLED (default true), MEMWATCH_JUMP_MB (default 64),
MEMWATCH_SAMPLE_SEC (default 600).
"""

from __future__ import annotations

import gc
import logging
import os
import threading
import time
from collections import Counter
from typing import Optional

logger = logging.getLogger(__name__)

ENABLED = os.getenv("MEMWATCH_ENABLED", "true").strip().lower() != "false"
JUMP_MB = int(os.getenv("MEMWATCH_JUMP_MB", "64"))
SAMPLE_SEC = int(os.getenv("MEMWATCH_SAMPLE_SEC", "600"))

_PAGE = os.sysconf("SC_PAGE_SIZE")


def rss_mb() -> int:
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * _PAGE // (1024 * 1024)
    except Exception:
        return -1


# ── 1. Request middleware ───────────────────────────────────────────────────

class MemWatchMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        before = rss_mb()
        started = time.monotonic()
        logged = False

        def _check(status: str) -> None:
            nonlocal logged
            if logged:
                return
            logged = True
            after = rss_mb()
            if before >= 0 and after - before >= JUMP_MB:
                logger.warning(
                    "memwatch request +%dMB (%d -> %d) %s %s %s in %.1fs",
                    after - before, before, after,
                    scope.get("method"), scope.get("path"), status,
                    time.monotonic() - started,
                )

        async def _send(message):
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body"):
                _check("done")

        try:
            await self.app(scope, receive, _send)
        finally:
            _check("aborted")   # no-op if already checked on completion


# ── 2. Scheduler job hooks ──────────────────────────────────────────────────

def _watch_job(job_id: str, fn):
    def _wrapped(*args, **kwargs):
        before = rss_mb()
        try:
            return fn(*args, **kwargs)
        finally:
            after = rss_mb()
            if before >= 0 and after - before >= JUMP_MB:
                logger.warning("memwatch job +%dMB (%d -> %d) job=%s",
                               after - before, before, after, job_id)
    _wrapped.__name__ = getattr(fn, "__name__", job_id)
    return _wrapped


def install_scheduler_hooks(scheduler) -> None:
    """Wrap every job already added to ``scheduler``. Call after all
    add_job() calls. (Job events can't be used: APScheduler may fire
    EXECUTED before SUBMITTED for fast jobs.)"""
    if not ENABLED:
        return
    for job in scheduler.get_jobs():
        job.modify(func=_watch_job(job.id, job.func))


# ── 3. Periodic sampler ─────────────────────────────────────────────────────

_sampler: Optional[threading.Thread] = None
_stop = threading.Event()


def _sample_loop() -> None:
    prev: Counter = Counter()
    while not _stop.wait(SAMPLE_SEC):
        try:
            counts = Counter(type(o).__name__ for o in gc.get_objects())
            total = sum(counts.values())
            grew = (counts - prev).most_common(8) if prev else []
            prev = counts
            logger.info(
                "memwatch sample rss=%dMB threads=%d gc_objects=%d grew=%s",
                rss_mb(), threading.active_count(), total,
                ", ".join(f"{n}+{c}" for n, c in grew) or "-",
            )
            del counts
        except Exception:
            logger.exception("memwatch sample failed")


def start_sampler() -> None:
    global _sampler
    if not ENABLED or _sampler is not None:
        return
    _stop.clear()
    _sampler = threading.Thread(target=_sample_loop, name="memwatch", daemon=True)
    _sampler.start()
    logger.info("memwatch on: jump>=%dMB, sample every %ds, rss=%dMB",
                JUMP_MB, SAMPLE_SEC, rss_mb())


def stop_sampler() -> None:
    global _sampler
    _stop.set()
    _sampler = None
