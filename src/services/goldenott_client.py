import logging
import time
from typing import Optional

import requests

from ..config import GOLDENOTT_API_KEY, GOLDENOTT_API_URL

logger = logging.getLogger(__name__)

_TIMEOUT = 30
_INTER_CALL_DELAY = 1.0   # ~60 req/min; 0.4s tripped GoldenOTT's 429 limit
_MAX_429_RETRIES = 4


class GoldenOTTClient:
    def __init__(self, api_url: Optional[str] = None, api_key: Optional[str] = None,
                 timeout: Optional[float] = None):
        self.api_url = (api_url or GOLDENOTT_API_URL).rstrip("/")
        self.api_key = api_key or GOLDENOTT_API_KEY
        # Override the default (long) timeout for hot-path on-demand calls so a
        # slow GoldenOTT never hangs a play request.
        self.timeout = timeout if timeout is not None else _TIMEOUT
        self._session = requests.Session()
        self._session.headers.update({
            "X-API-Key": self.api_key,
            "Accept": "application/json",
            "User-Agent": "ottapi/1.0",
        })

    def _get(self, path: str, params: Optional[dict] = None) -> Optional[dict]:
        url = f"{self.api_url}{path}"
        for attempt in range(_MAX_429_RETRIES + 1):
            try:
                resp = self._session.get(url, params=params, timeout=self.timeout)
                if resp.status_code == 429 and attempt < _MAX_429_RETRIES:
                    # GoldenOTT sends "Retry-After: 0" at the window edge and then 429s
                    # the instant retry, so never wait less than an exponential floor.
                    try:
                        hinted = float(resp.headers.get("Retry-After") or 0)
                    except ValueError:
                        hinted = 0.0
                    retry_after = min(120.0, max(hinted, 5.0 * 2 ** attempt))
                    logger.info("GoldenOTT 429 on %s; sleeping %.1fs before retry", path, retry_after)
                    time.sleep(retry_after)
                    continue
                resp.raise_for_status()
                time.sleep(_INTER_CALL_DELAY)
                return resp.json()
            except Exception as exc:
                logger.warning("GoldenOTT GET %s failed: %s", path, exc)
                return None
        return None

    def get_profile(self) -> Optional[dict]:
        body = self._get("/v1/account/profile")
        return body.get("data") if body and body.get("success") else None

    def get_domains(self) -> list[dict]:
        body = self._get("/v1/account/domains")
        if not body or not body.get("success"):
            return []
        return body.get("data") or []

    def get_line(self, line_id: int) -> Optional[dict]:
        body = self._get(f"/v1/lines/{line_id}")
        return body.get("data") if body and body.get("success") else None

    def list_lines_page(self, page: int = 1, per_page: int = 100) -> Optional[dict]:
        return self._get("/v1/lines", params={"page": page, "per_page": per_page})
