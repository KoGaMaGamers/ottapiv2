"""Tiny in-process sliding-window rate limiter (single uvicorn worker).

Bounded memory: keys idle longer than the window are dropped on access,
and the key table is capped.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Deque, Dict


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_sec: float, max_keys: int = 10_000):
        self.limit = limit
        self.window = window_sec
        self.max_keys = max_keys
        self._hits: Dict[str, Deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window
        with self._lock:
            q = self._hits.get(key)
            if q is None:
                if len(self._hits) >= self.max_keys:
                    self._evict_idle(cutoff)
                q = self._hits[key] = deque()
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True

    def _evict_idle(self, cutoff: float) -> None:
        for k in [k for k, q in self._hits.items() if not q or q[-1] <= cutoff]:
            del self._hits[k]
        if len(self._hits) >= self.max_keys:   # still full: drop oldest-touched
            for k in sorted(self._hits, key=lambda k: self._hits[k][-1])[: self.max_keys // 10]:
                del self._hits[k]
