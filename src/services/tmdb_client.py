"""TMDB API v3 client.

Refactored from the legacy ``tmdb_client.py`` to fix four real issues
flagged during the inventory pass:

  1. Thread-safe rate limit (the legacy global ``_last_request_time`` was
     mutated without a lock, so scheduler threads + admin requests could
     bypass the budget).
  2. In-memory request cache (within one sync run, identical search
     queries dedupe to a single HTTP call — same movie title appearing on
     multiple lines no longer hits TMDB N times).
  3. Exponential backoff on 429 (legacy did one blind retry; we now
     retry up to three times with 2/4/8 second backoff or whatever
     ``Retry-After`` says, whichever is larger).
  4. Circuit breaker: after a small number of consecutive non-429
     failures (network errors, 5xx) the client stops issuing requests
     for the rest of this process lifetime — letting the catalog sync
     finish without hammering a dead API.

Auth: prefers ``TMDB_BEARER_TOKEN`` (v4 OAuth) when set, falls back to
``TMDB_API_KEY`` (v3 query-string). Raises at construction if neither
is configured — TMDB enrichment callers should catch this and skip
silently rather than crash the catalog sync.
"""

import logging
import threading
import time
from typing import Any, Dict, Optional

import requests

from ..config import TMDB_API_KEY, TMDB_BEARER_TOKEN

logger = logging.getLogger(__name__)


_TMDB_BASE_URL = "https://api.themoviedb.org/3"
_RATE_LIMIT_DELAY = 0.025  # 40 req/s
_MAX_RETRIES_429 = 3
_CIRCUIT_BREAKER_FAILS = 5


class TMDBNotConfigured(RuntimeError):
    """Raised when neither TMDB_BEARER_TOKEN nor TMDB_API_KEY is set."""


class TMDBClient:
    """Thread-safe TMDB API client with caching, backoff, and circuit breaker."""

    def __init__(self) -> None:
        self._bearer = TMDB_BEARER_TOKEN or None
        self._api_key = TMDB_API_KEY or None
        if not self._bearer and not self._api_key:
            raise TMDBNotConfigured(
                "neither TMDB_BEARER_TOKEN nor TMDB_API_KEY is set"
            )

        self._session = requests.Session()
        if self._bearer:
            self._session.headers.update({
                "Authorization": f"Bearer {self._bearer}",
                "Content-Type": "application/json;charset=utf-8",
            })

        self._rate_lock = threading.Lock()
        self._last_call_at = 0.0
        self._cache_lock = threading.Lock()
        self._cache: Dict[str, Optional[Dict[str, Any]]] = {}
        self._consecutive_failures = 0
        self._circuit_open = False

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _wait_rate(self) -> None:
        with self._rate_lock:
            now = time.time()
            elapsed = now - self._last_call_at
            if elapsed < _RATE_LIMIT_DELAY:
                time.sleep(_RATE_LIMIT_DELAY - elapsed)
            self._last_call_at = time.time()

    def _cache_key(self, endpoint: str, params: Optional[Dict[str, Any]]) -> str:
        if not params:
            return endpoint
        items = sorted((k, str(v)) for k, v in params.items() if k != "api_key")
        return endpoint + "?" + "&".join(f"{k}={v}" for k, v in items)

    def _record_success(self) -> None:
        if self._consecutive_failures:
            self._consecutive_failures = 0

    def _record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= _CIRCUIT_BREAKER_FAILS and not self._circuit_open:
            self._circuit_open = True
            logger.warning(
                "TMDB circuit breaker tripped after %d consecutive failures; "
                "remaining calls in this process will short-circuit",
                _CIRCUIT_BREAKER_FAILS,
            )

    def get(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        if self._circuit_open:
            return None

        cache_key = self._cache_key(endpoint, params)
        with self._cache_lock:
            if cache_key in self._cache:
                return self._cache[cache_key]

        request_params: Dict[str, Any] = dict(params or {})
        if self._api_key and not self._bearer:
            request_params["api_key"] = self._api_key

        url = f"{_TMDB_BASE_URL}/{endpoint.lstrip('/')}"

        for attempt in range(_MAX_RETRIES_429 + 1):
            self._wait_rate()
            try:
                resp = self._session.get(url, params=request_params, timeout=15)
            except requests.RequestException as exc:
                logger.warning("TMDB GET %s network error: %s", endpoint, exc)
                self._record_failure()
                with self._cache_lock:
                    self._cache[cache_key] = None
                return None

            if resp.status_code == 429:
                if attempt >= _MAX_RETRIES_429:
                    logger.warning("TMDB GET %s exhausted 429 retries", endpoint)
                    self._record_failure()
                    with self._cache_lock:
                        self._cache[cache_key] = None
                    return None
                retry_after = resp.headers.get("Retry-After")
                try:
                    backoff = float(retry_after) if retry_after else 0.0
                except ValueError:
                    backoff = 0.0
                backoff = max(backoff, 2 ** attempt)
                logger.info("TMDB 429 on %s; sleeping %.1fs then retrying", endpoint, backoff)
                time.sleep(backoff)
                continue

            if not resp.ok:
                logger.warning("TMDB GET %s HTTP %s: %s", endpoint, resp.status_code, resp.text[:200])
                # 404 means the requested resource doesn't exist on TMDB (stale id,
                # private/deleted entry) — not a sign that TMDB is unhealthy. Don't
                # count it toward the circuit breaker; just cache the None and move on.
                if resp.status_code != 404:
                    self._record_failure()
                with self._cache_lock:
                    self._cache[cache_key] = None
                return None

            try:
                body = resp.json()
            except ValueError:
                logger.warning("TMDB GET %s: invalid JSON", endpoint)
                self._record_failure()
                with self._cache_lock:
                    self._cache[cache_key] = None
                return None

            self._record_success()
            with self._cache_lock:
                self._cache[cache_key] = body
            return body

        return None

    # ------------------------------------------------------------------
    # Public typed wrappers
    # ------------------------------------------------------------------

    def get_movie_details(self, tmdb_id: int) -> Optional[Dict[str, Any]]:
        return self.get(f"movie/{tmdb_id}")

    def get_tv_details(self, tmdb_id: int) -> Optional[Dict[str, Any]]:
        return self.get(f"tv/{tmdb_id}")

    def search_movie(self, query: str, year: Optional[int] = None) -> Optional[Dict[str, Any]]:
        params: Dict[str, Any] = {"query": query, "page": 1}
        if year:
            params["year"] = year
        return self.get("search/movie", params=params)

    def search_tv(self, query: str, year: Optional[int] = None) -> Optional[Dict[str, Any]]:
        params: Dict[str, Any] = {"query": query, "page": 1}
        if year:
            params["first_air_date_year"] = year
        return self.get("search/tv", params=params)

    def get_movie_genre_list(self) -> Optional[Dict[str, Any]]:
        return self.get("genre/movie/list")

    def get_tv_genre_list(self) -> Optional[Dict[str, Any]]:
        return self.get("genre/tv/list")

    def get_movie_similar(self, tmdb_id: int) -> Optional[Dict[str, Any]]:
        return self.get(f"movie/{tmdb_id}/similar", params={"page": 1})

    def get_tv_similar(self, tmdb_id: int) -> Optional[Dict[str, Any]]:
        return self.get(f"tv/{tmdb_id}/similar", params={"page": 1})

    def get_movie_recommendations(self, tmdb_id: int) -> Optional[Dict[str, Any]]:
        return self.get(f"movie/{tmdb_id}/recommendations", params={"page": 1})

    def get_tv_recommendations(self, tmdb_id: int) -> Optional[Dict[str, Any]]:
        return self.get(f"tv/{tmdb_id}/recommendations", params={"page": 1})
