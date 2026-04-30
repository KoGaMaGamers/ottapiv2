"""Tiny shared helpers for the sport-events skill scripts.

Imports the project's `SessionLocal` so all three scripts use the same
DB connection pool and stay in sync with the live models. Keep this
file dependency-light — no FastAPI imports.
"""

from __future__ import annotations

import os
import re
import sys

# Add the project root to sys.path so `from src.database import …` works
# whether scripts are invoked from /home/ottapi/ or anywhere else.
_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.database import SessionLocal  # noqa: E402
from src.models import (                # noqa: E402
    KvSettings,
    LiveStream,
    LiveStreamAlias,
    SportEvent,
    SportEventsRun,
    XtreamProvider,
)

__all__ = [
    "SessionLocal",
    "KvSettings",
    "LiveStream",
    "LiveStreamAlias",
    "SportEvent",
    "SportEventsRun",
    "XtreamProvider",
    "normalize_channel_name",
]

# Trailing tokens to strip when normalizing channel / broadcaster names.
# Matches "ESPN US HD", "Sky Sports F1 +1", "BeIN Sports 1 FHD" → ESPN /
# Sky Sports F1 / BeIN Sports 1.
_TRAILING_QUALIFIERS = re.compile(
    r"\b(?:hd|fhd|uhd|4k|8k|sd|us|usa|uk|fr|de|es|it|"
    r"east|west|live|hevc|h265|\+\d+)\b",
    re.IGNORECASE,
)
_PUNCT_RUN = re.compile(r"[^a-z0-9\s]+")
_WHITESPACE_RUN = re.compile(r"\s+")


def normalize_channel_name(raw: str | None) -> str:
    """Lowercase, strip punctuation, drop trailing qualifier tokens
    (HD/UHD/region codes/channel-shift markers), collapse whitespace."""
    if not raw:
        return ""
    s = raw.lower()
    s = _PUNCT_RUN.sub(" ", s)
    s = _TRAILING_QUALIFIERS.sub(" ", s)
    s = _WHITESPACE_RUN.sub(" ", s).strip()
    return s
