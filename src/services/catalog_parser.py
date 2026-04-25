"""Parsers for Xtream Codes catalog names.

Pure functions, no I/O — lifted verbatim from the legacy project's
xtream_sync.py:148-347. Used by the catalog sync service to extract
language/year/hierarchy hints from raw Xtream category and stream names.

Languages stay best-effort: when no prefix matches, language is None.
The TV app's curated rails filter on parsed `language`; categories with
language=None still surface via plain category browse.
"""

import re
from typing import List, Optional, Tuple


_COUNTRY_PREFIX_RE = re.compile(
    r"^[A-Z]{2,3}(?:-[A-Z]{2,3})?\s*[-|]\s*",
    re.IGNORECASE,
)
_ARCHIVE_INDICATOR = "◉"  # ◉

_LANG_PREFIX_RE = re.compile(r"^([A-Z]{2,3})\s*(?:-|\|)\s*(.+)$", re.IGNORECASE)
_VOD_PREFIX_RE = re.compile(r"^VOD\s*\|\s*", re.IGNORECASE)
_SRS_PREFIX_RE = re.compile(r"^SRS\s*\|\s*", re.IGNORECASE)
_LIVE_CATEGORY_SPLIT_RE = re.compile(r"\s*\|\s*")

_STREAM_LANG_RE = re.compile(r"^([A-Z]{2,3})\s*-\s*(.+)$", re.IGNORECASE)
_STREAM_YEAR_RE = re.compile(r"^(.+)\s*-\s*(\d{4})\s*$")


# ---------------------------------------------------------------------------
# Live stream name
# ---------------------------------------------------------------------------

def parse_live_stream_name(raw: str) -> str:
    """Strip country prefix + ◉, collapse whitespace.

    "FR - TF1 HD ◉" -> "TF1 HD"
    """
    name = (raw or "").strip()
    name = _COUNTRY_PREFIX_RE.sub("", name)
    name = name.replace(_ARCHIVE_INDICATOR, "")
    name = re.sub(r"\s+", " ", name).strip()
    return name or (raw or "").strip()


# ---------------------------------------------------------------------------
# Series stream + episode titles
# ---------------------------------------------------------------------------

def parse_series_stream_name(raw: str) -> Tuple[Optional[str], str]:
    """Extract optional 2-3 char language code; return (lang, cleaned_name)."""
    s = (raw or "").strip()
    m = _STREAM_LANG_RE.match(s)
    if m:
        return m.group(1).upper(), m.group(2).strip()
    return None, s or (raw or "").strip()


def parse_episode_title(raw: str) -> str:
    """Strip a redundant language prefix on episode titles, if present."""
    if not raw:
        return raw
    s = raw.strip()
    m = _STREAM_LANG_RE.match(s)
    if m:
        return m.group(2).strip()
    return s


# ---------------------------------------------------------------------------
# Category name parsers
# ---------------------------------------------------------------------------

def _parse_prefixed_category_name(prefix_re: "re.Pattern[str]", raw: str) -> Tuple[Optional[str], str]:
    stripped = prefix_re.sub("", (raw or "").strip()).strip()
    m = _LANG_PREFIX_RE.match(stripped)
    if m:
        return m.group(1).upper(), m.group(2).strip()
    return None, stripped or (raw or "").strip()


def parse_movie_category_name(raw: str) -> Tuple[Optional[str], str]:
    """Strip the "VOD | " prefix and extract optional language code."""
    return _parse_prefixed_category_name(_VOD_PREFIX_RE, raw)


def parse_serie_category_name(raw: str) -> Tuple[Optional[str], str]:
    """Strip the "SRS | " prefix and extract optional language code."""
    return _parse_prefixed_category_name(_SRS_PREFIX_RE, raw)


def parse_live_category_segments(raw: str) -> List[str]:
    """Split a hierarchical live category by '|', strip and dedupe whitespace."""
    text = (raw or "").strip()
    if not text:
        return []
    return [seg.strip() for seg in _LIVE_CATEGORY_SPLIT_RE.split(text) if seg.strip()]


# ---------------------------------------------------------------------------
# VOD movie stream name (language + title + year)
# ---------------------------------------------------------------------------

def parse_movie_stream_name(raw: str) -> Tuple[Optional[str], str, Optional[int]]:
    """Parse "(LANG -)? Title (- YYYY)?" into (language, title, year)."""
    s = (raw or "").strip()
    language: Optional[str] = None
    year: Optional[int] = None

    lang_m = _STREAM_LANG_RE.match(s)
    if lang_m:
        language = lang_m.group(1).upper()
        s = lang_m.group(2).strip()

    year_m = _STREAM_YEAR_RE.match(s)
    if year_m:
        name = year_m.group(1).strip()
        year = int(year_m.group(2))
    else:
        name = s

    return language, (name or (raw or "").strip()), year
