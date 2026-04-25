"""
Xtream Codes API Client

Wraps all HTTP calls to the Xtream Codes player_api.php endpoint.

Credentials (base_url, username, password) are supplied per-instance by the
caller and are NEVER persisted.  The connect endpoint receives them from the
client app, uses them for a one-time data sync, then discards them.
"""

import logging
import requests
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class XtreamClient:
    """HTTP client for the Xtream Codes player API."""

    def __init__(
        self,
        base_url: str,
        username: str,
        password: str,
        timeout: int = 60,
    ):
        """
        Args:
            base_url:  Provider root URL, e.g. "http://example.com"
            username:  Xtream Codes username (NOT stored in the DB)
            password:  Xtream Codes password (NOT stored in the DB)
            timeout:   HTTP request timeout in seconds
        """
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _api_url(self) -> str:
        return f"{self.base_url}/player_api.php"

    def _base_params(self) -> Dict[str, str]:
        return {"username": self.username, "password": self.password}

    def _get(
        self, extra_params: Optional[Dict[str, Any]] = None
    ) -> Optional[Any]:
        """Perform a GET request to player_api.php and return the parsed JSON."""
        params = self._base_params()
        if extra_params:
            params.update(extra_params)
        url = self._api_url()
        _headers = {"User-Agent": "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1"}
        try:
            response = requests.get(url, params=params, timeout=self.timeout, headers=_headers)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.HTTPError as exc:
            logger.error("Xtream API HTTP error %s – %s", url, exc)
        except requests.exceptions.RequestException as exc:
            logger.error("Xtream API request error %s – %s", url, exc)
        except ValueError as exc:
            logger.error("Xtream API JSON decode error %s – %s", url, exc)
        return None

    # ------------------------------------------------------------------
    # Account / server info
    # ------------------------------------------------------------------

    def get_account_info(self) -> Optional[Dict[str, Any]]:
        """Return account + server info (no action param needed)."""
        return self._get()

    # ------------------------------------------------------------------
    # Live streams
    # ------------------------------------------------------------------

    def get_live_categories(self) -> Optional[List[Dict[str, Any]]]:
        """Return list of live stream categories."""
        return self._get({"action": "get_live_categories"})

    def get_live_streams(
        self, category_id: Optional[int] = None
    ) -> Optional[List[Dict[str, Any]]]:
        """Return all live streams, optionally filtered by category_id."""
        params: Dict[str, Any] = {"action": "get_live_streams"}
        if category_id is not None:
            params["category_id"] = category_id
        return self._get(params)

    def get_short_epg(
        self, stream_id: int, limit: int = 4
    ) -> Optional[Dict[str, Any]]:
        """Return short EPG data for a live channel."""
        return self._get(
            {"action": "get_short_epg", "stream_id": stream_id, "limit": limit}
        )

    def get_full_epg(self, stream_id: int) -> Optional[Dict[str, Any]]:
        """Return full EPG data (simple_data_table) for a live channel."""
        return self._get(
            {"action": "get_simple_data_table", "stream_id": stream_id}
        )

    # ------------------------------------------------------------------
    # VOD (movies)
    # ------------------------------------------------------------------

    def get_vod_categories(self) -> Optional[List[Dict[str, Any]]]:
        """Return list of VOD categories."""
        return self._get({"action": "get_vod_categories"})

    def get_vod_streams(
        self, category_id: Optional[int] = None
    ) -> Optional[List[Dict[str, Any]]]:
        """Return all VOD streams, optionally filtered by category_id."""
        params: Dict[str, Any] = {"action": "get_vod_streams"}
        if category_id is not None:
            params["category_id"] = category_id
        return self._get(params)

    def get_vod_info(self, vod_id: int) -> Optional[Dict[str, Any]]:
        """Return detailed info for a single VOD item."""
        return self._get({"action": "get_vod_info", "vod_id": vod_id})

    # ------------------------------------------------------------------
    # Series
    # ------------------------------------------------------------------

    def get_series_categories(self) -> Optional[List[Dict[str, Any]]]:
        """Return list of series categories."""
        return self._get({"action": "get_series_categories"})

    def get_series(
        self, category_id: Optional[int] = None
    ) -> Optional[List[Dict[str, Any]]]:
        """Return all series, optionally filtered by category_id."""
        params: Dict[str, Any] = {"action": "get_series"}
        if category_id is not None:
            params["category_id"] = category_id
        return self._get(params)

    def get_series_info(self, series_id: int) -> Optional[Dict[str, Any]]:
        """Return detailed info + episode list for a series."""
        return self._get({"action": "get_series_info", "series_id": series_id})

    def get_episode_info(self, episode_id: int) -> Optional[Dict[str, Any]]:
        """Return info for a single series episode (reuses vod_info endpoint)."""
        return self._get({"action": "get_vod_info", "vod_id": episode_id})

    # ------------------------------------------------------------------
    # Stream URL builders
    # ------------------------------------------------------------------

    def build_live_url(self, stream_id: int, ext: str = "m3u8") -> str:
        """Build the direct stream URL for a live channel."""
        return (
            f"{self.base_url}/live/{self.username}/{self.password}/{stream_id}.{ext}"
        )

    def build_vod_url(self, stream_id: int, container_extension: str = "mp4") -> str:
        """Build the direct stream URL for a VOD item."""
        return (
            f"{self.base_url}/movie/{self.username}/{self.password}"
            f"/{stream_id}.{container_extension}"
        )

    def build_series_url(
        self, episode_id: int, container_extension: str = "mkv"
    ) -> str:
        """Build the direct stream URL for a series episode."""
        return (
            f"{self.base_url}/series/{self.username}/{self.password}"
            f"/{episode_id}.{container_extension}"
        )

    def build_timeshift_url(
        self, stream_id: int, duration: int, start: str
    ) -> str:
        """Build the timeshift/catchup URL.
        
        Args:
            stream_id: Live stream ID
            duration: Duration in minutes
            start: Start timestamp in format YYYY-MM-DD:HH-MM
        """
        return (
            f"{self.base_url}/timeshift/{self.username}/{self.password}"
            f"/{duration}/{start}/{stream_id}.ts"
        )
