"""Per-provider exclusivity for background catalog jobs — across processes.

Before this, nothing stopped a manual admin run from overlapping the
scheduled one; TMDB enrichment next to movie-details deadlocked on
movie_streams. Jobs run in the scheduler worker process AND (admin
triggers) in any API worker, so the lock is a MySQL named lock
(GET_LOCK) held on a dedicated connection for the job's duration — it is
released automatically if the process dies.

Groups:
  "catalog" — run_catalog_sync
  "enrich"  — run_movie_details_sync + run_tmdb_enrichment (both write
              movie_streams; details chains into TMDB in the same thread,
              so a thread already holding the lock re-enters freely)
"""

from __future__ import annotations

import functools
import logging
import threading
from typing import Callable

from sqlalchemy import text

from ..database import engine

logger = logging.getLogger(__name__)

_held = threading.local()   # names held by the current thread (re-entrancy)


def _name(group: str, provider_id: int) -> str:
    return f"ottapi:{group}:{provider_id}"


def _held_names() -> set:
    if not hasattr(_held, "names"):
        _held.names = set()
    return _held.names


def is_running(group: str, provider_id: int) -> bool:
    name = _name(group, provider_id)
    if name in _held_names():
        return False   # this thread owns it (chained call)
    with engine.connect() as conn:
        return conn.execute(text("SELECT IS_USED_LOCK(:n)"), {"n": name}).scalar() is not None


def exclusive(group: str) -> Callable:
    """Decorate ``fn(provider_id, ...)``: skip (return a summary dict) when
    the same group already runs for that provider in any process."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(provider_id: int, *args, **kwargs):
            name = _name(group, provider_id)
            held = _held_names()
            if name in held:
                return fn(provider_id, *args, **kwargs)
            conn = engine.connect()
            try:
                got = conn.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": name}).scalar()
                if got != 1:
                    logger.warning("%s: %s already running for provider %s; skipped",
                                   fn.__name__, group, provider_id)
                    return {"provider_id": provider_id, "skipped": f"{group} already running"}
                held.add(name)
                try:
                    return fn(provider_id, *args, **kwargs)
                finally:
                    held.discard(name)
                    try:
                        conn.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": name})
                    except Exception:
                        logger.exception("could not release %s (dropped with connection)", name)
            finally:
                conn.close()
        return wrapper
    return deco
