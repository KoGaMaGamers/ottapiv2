"""Per-provider exclusivity for background catalog jobs.

Before this, nothing stopped a manual admin run from overlapping the
scheduled one (or two manual clicks from overlapping each other); TMDB
enrichment running next to movie-details deadlocked on movie_streams.

Groups:
  "catalog" — run_catalog_sync
  "enrich"  — run_movie_details_sync + run_tmdb_enrichment (both write
              movie_streams; details chains into TMDB in the same thread,
              hence a re-entrant lock)
Single uvicorn worker -> in-process locks are sufficient.
"""

from __future__ import annotations

import functools
import logging
import threading
from typing import Callable, Dict, Tuple

logger = logging.getLogger(__name__)

_locks: Dict[Tuple[str, int], threading.RLock] = {}
_guard = threading.Lock()


def _lock(group: str, provider_id: int) -> threading.RLock:
    with _guard:
        return _locks.setdefault((group, provider_id), threading.RLock())


def is_running(group: str, provider_id: int) -> bool:
    lk = _lock(group, provider_id)
    if lk.acquire(blocking=False):   # re-entrant: true for the owning thread too
        lk.release()
        return False
    return True


def exclusive(group: str) -> Callable:
    """Decorate ``fn(provider_id, ...)``: skip (return a summary dict) when
    the same group already runs for that provider."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(provider_id: int, *args, **kwargs):
            lk = _lock(group, provider_id)
            if not lk.acquire(blocking=False):
                logger.warning("%s: %s already running for provider %s; skipped",
                               fn.__name__, group, provider_id)
                return {"provider_id": provider_id, "skipped": f"{group} already running"}
            try:
                return fn(provider_id, *args, **kwargs)
            finally:
                lk.release()
        return wrapper
    return deco
