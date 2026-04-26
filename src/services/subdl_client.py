"""
SUBDL Subtitle API Client

Fetches subtitle metadata from subdl.com.
Download base URL: https://dl.subdl.com
API docs: https://subdl.com/api-doc
Rate limit: generous, no explicit limit documented.
"""

import logging
from typing import Any, Dict, List, Optional

import httpx

from ..config import SUBDL_API_KEY

logger = logging.getLogger(__name__)

SUBDL_API_BASE = "https://api.subdl.com/api/v1/subtitles"
SUBDL_DL_BASE = "https://dl.subdl.com"

# Map SUBDL 2-letter language codes → human-readable labels
LANG_LABELS: Dict[str, str] = {
    "EN": "English",
    "FR": "French",
    "ES": "Spanish",
    "DE": "German",
    "IT": "Italian",
    "PT": "Portuguese",
    "RU": "Russian",
    "AR": "Arabic",
    "ZH": "Chinese",
    "JA": "Japanese",
    "KO": "Korean",
    "NL": "Dutch",
    "PL": "Polish",
    "SV": "Swedish",
    "NO": "Norwegian",
    "DA": "Danish",
    "FI": "Finnish",
    "TR": "Turkish",
    "HE": "Hebrew",
    "FA": "Persian",
    "CS": "Czech",
    "SK": "Slovak",
    "HU": "Hungarian",
    "RO": "Romanian",
    "UK": "Ukrainian",
    "HR": "Croatian",
    "BG": "Bulgarian",
    "EL": "Greek",
    "TH": "Thai",
    "VI": "Vietnamese",
    "ID": "Indonesian",
    "MS": "Malay",
    "HI": "Hindi",
    "BN": "Bengali",
    "UR": "Urdu",
}


def search_subtitles(
    tmdb_id: int,
    languages: Optional[List[str]] = None,
    season: int = 0,
    episode: int = 0,
    subs_per_page: int = 30,
) -> List[Dict[str, Any]]:
    """
    Search SUBDL for subtitles by TMDB ID, optionally filtered by season/episode.

    Args:
        tmdb_id:       TMDB ID (integer), e.g. 550 (Fight Club) or 1399 (Game of Thrones)
        languages:     List of 2-letter codes (case-insensitive), e.g. ["en","fr"].
                       None means no language filter.
        season:        Season number (0 = movie or no filter).
        episode:       Episode number (0 = no filter).
        subs_per_page: How many subtitles to fetch from SUBDL (max useful ~30).

    Returns:
        List of raw subtitle dicts from SUBDL, each having at minimum:
          { "language": "EN", "lang": "english", "url": "/subtitle/xxx.zip", ... }
    """
    if not SUBDL_API_KEY:
        raise RuntimeError("SUBDL_API_KEY is not configured")

    # Infer content type: TV if a season is specified, otherwise movie.
    content_type = "tv" if season > 0 else "movie"

    params: Dict[str, Any] = {
        "api_key": SUBDL_API_KEY,
        "tmdb_id": tmdb_id,
        "type": content_type,
        "subs_per_page": subs_per_page,
    }

    # Pass season/episode to SUBDL when requesting a specific episode
    if season > 0:
        params["season_number"] = season
    if episode > 0:
        params["episode_number"] = episode

    if languages:
        # SUBDL expects comma-separated uppercase codes, e.g. "EN,FR"
        params["languages"] = ",".join(c.upper() for c in languages)

    logger.info(
        "SUBDL search: tmdb_id=%d type=%s season=%s episode=%s languages=%s",
        tmdb_id, content_type,
        params.get("season_number", "-"),
        params.get("episode_number", "-"),
        params.get("languages", "all"),
    )

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(SUBDL_API_BASE, params=params)
            logger.info("SUBDL response: status=%d url=%s", resp.status_code, resp.url)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        logger.error("SUBDL HTTP error for tmdb_id=%d: %s", tmdb_id, exc)
        raise

    if not data.get("status"):
        logger.warning(
            "SUBDL returned status=false for tmdb_id=%d — response: %s",
            tmdb_id, data,
        )
        return []

    subtitles = data.get("subtitles", [])
    logger.info(
        "SUBDL found %d subtitle(s) for tmdb_id=%d: %s",
        len(subtitles),
        tmdb_id,
        [{"lang": s.get("language"), "url": s.get("url")} for s in subtitles],
    )
    return subtitles


def best_per_language(
    subtitles: List[Dict[str, Any]],
    episode: int = 0,
) -> List[Dict[str, Any]]:
    """
    Deduplicate: keep only the best subtitle per language code.

    When *episode* > 0, entries whose ``episode`` field is set to a
    **different** episode number are discarded — SUBDL's filtering is loose
    and can return mis-labelled results (e.g. episode=7 when episode=4 was
    requested).

    Preference order (per language, after filtering):
      1. Entry where ``episode`` matches exactly (most reliable)
      2. Entry where ``episode`` is None/unset (unknown, but not wrong)
      3. Full-season pack (full_season=True) — last resort
    """
    # Drop entries that are explicitly for the wrong episode
    if episode > 0:
        subtitles = [
            s for s in subtitles
            if s.get("episode") is None or s.get("episode") == episode
        ]

    def _sort_key(sub: Dict[str, Any]) -> int:
        if sub.get("full_season"):
            return 2          # season pack — lowest priority
        ep = sub.get("episode")
        if ep is not None and ep == episode:
            return 0          # exact episode match — highest priority
        return 1              # episode unknown — middle priority

    seen: set = set()
    result = []
    for sub in sorted(subtitles, key=_sort_key):
        lang_code = (sub.get("language") or "").upper()
        if lang_code and lang_code not in seen:
            seen.add(lang_code)
            result.append(sub)
    return result


def subtitle_download_url(url_path: str) -> str:
    """Return the full download URL for a SUBDL subtitle zip path."""
    return f"{SUBDL_DL_BASE}{url_path}"
