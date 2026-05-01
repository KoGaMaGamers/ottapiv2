"""User-facing sport events feed for the Home hero rail.

Reads the current batch (pointer in `kv_settings`), filters for events
that are still relevant (not yet finished, within 14 days), and
resolves each event's broadcaster against the requesting user's
provider catalog. Events without a resolved live channel are dropped
so the client only ever surfaces something it can play.

Always 200, always `{"items": [...]}`. Empty array when the table is
empty / pointer is unset / no events resolve for this provider — the
frontend's hero-fallback path depends on that.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    KvSettings,
    LiveStream,
    LiveStreamAlias,
    SportEvent,
    SportEventBroadcaster,
)
from .auth import get_current_user
from ..models import IPTVUser


router = APIRouter(prefix="/api/v1", tags=["sport-events"])

POINTER_KEY = "sport_events_current_batch"
WINDOW_MAX = timedelta(days=14)
WINDOW_GRACE = timedelta(hours=1)   # keep visible briefly after end_utc


# ---------------------------------------------------------------------------
# Response shape
# ---------------------------------------------------------------------------

class ChannelOut(BaseModel):
    live_id:           int
    channel_name:      str
    channel_logo:      Optional[str]
    broadcaster_name:  str
    broadcaster_country: Optional[str]
    language:          Optional[str]


class SportEventOut(BaseModel):
    id:                  int
    title:               str
    description:         Optional[str]
    sport:               str
    league:              Optional[str]
    home_team:           Optional[str]
    away_team:           Optional[str]
    start_utc:           datetime
    end_utc:             datetime
    cover_url:           Optional[str]
    # All channels under the requesting user's provider that broadcast
    # this event. The client renders a picker when len > 1; clicking
    # a channel calls /play/live/{live_id}. Always non-empty (events
    # with zero matches are dropped server-side).
    channels:            List[ChannelOut]


class SportEventsResponse(BaseModel):
    items: List[SportEventOut]


# ---------------------------------------------------------------------------
# Broadcaster matching — same shape as ingest.py (plan §5)
# ---------------------------------------------------------------------------

import re

_TRAILING_QUALIFIERS = re.compile(
    r"\b(?:hd|fhd|uhd|4k|8k|sd|us|usa|uk|fr|de|es|it|"
    r"east|west|live|hevc|h265|\+\d+)\b",
    re.IGNORECASE,
)
_PUNCT_RUN = re.compile(r"[^a-z0-9\s]+")
_WHITESPACE_RUN = re.compile(r"\s+")


def _normalize(raw: Optional[str]) -> str:
    if not raw:
        return ""
    s = raw.lower()
    s = _PUNCT_RUN.sub(" ", s)
    s = _TRAILING_QUALIFIERS.sub(" ", s)
    s = _WHITESPACE_RUN.sub(" ", s).strip()
    return s


def _resolve_for_provider(
    db: Session, provider_id: int, broadcaster: str,
    channel_cache: dict[int, list[LiveStream]],
) -> Optional[LiveStream]:
    """Return the best LiveStream for `broadcaster` under `provider_id`,
    or None. Mirrors ingest.py's resolver but without seeding aliases —
    the read path is hot, no writes."""
    norm = _normalize(broadcaster)
    if not norm:
        return None

    # Layer 3 first (fast index hit) — alias table.
    alias = (
        db.query(LiveStreamAlias)
        .filter(LiveStreamAlias.provider_id == provider_id)
        .filter(LiveStreamAlias.alias == norm)
        .first()
    )
    if alias is not None:
        chan = db.get(LiveStream, alias.live_stream_id)
        if chan is not None:
            return chan

    # Layer 2 / 4 — walk the provider's channels in memory (cached
    # per-request).
    if provider_id not in channel_cache:
        channel_cache[provider_id] = (
            db.query(LiveStream)
            .filter(LiveStream.provider_id == provider_id)
            .all()
        )
    rows = channel_cache[provider_id]
    if not rows:
        return None

    # Exact normalized match.
    for r in rows:
        if _normalize(r.name) == norm:
            return r

    # Token containment.
    tokens = norm.split()
    if not tokens:
        return None
    candidates: list[tuple[int, str, LiveStream]] = []
    for r in rows:
        rn = _normalize(r.name)
        rn_tokens = set(rn.split())
        if all(t in rn_tokens for t in tokens):
            candidates.append((len(rn), rn, r))
    if not candidates:
        return None
    candidates.sort(key=lambda x: (x[0], x[1]))
    return candidates[0][2]


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.get("/sport-events", response_model=SportEventsResponse)
def list_sport_events(
    limit: int = Query(8, ge=1, le=20),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # 1. Read pointer.
    pointer_row = (
        db.query(KvSettings).filter(KvSettings.key == POINTER_KEY).first()
    )
    if pointer_row is None:
        return SportEventsResponse(items=[])
    try:
        current_batch = int(pointer_row.value)
    except (TypeError, ValueError):
        return SportEventsResponse(items=[])

    # 2. Live + future events from current batch.
    now = datetime.utcnow()
    rows = (
        db.query(SportEvent)
        .filter(SportEvent.batch_id == current_batch)
        .filter(SportEvent.end_utc > now - WINDOW_GRACE)
        .filter(SportEvent.start_utc < now + WINDOW_MAX)
        .order_by(SportEvent.start_utc.asc())
        .all()
    )

    # 3. For every broadcaster on every event, resolve against the
    # requesting user's provider. Build the channels[] list. Drop
    # events with zero resolutions.
    channel_cache: dict[int, list[LiveStream]] = {}
    out: list[SportEventOut] = []
    seen_live_ids: set[int]
    for ev in rows:
        # Pull broadcasters via the relationship (eager-load to avoid
        # N+1 — small N here, cheap to do in Python).
        broadcasters = (
            db.query(SportEventBroadcaster)
            .filter(SportEventBroadcaster.event_id == ev.id)
            .all()
        )
        # Fall back to denormalized primary if no broadcaster rows
        # exist (events ingested before the multi-broadcaster schema).
        if not broadcasters and ev.broadcaster_name:
            broadcasters = [
                SportEventBroadcaster(
                    event_id=ev.id,
                    broadcaster_name=ev.broadcaster_name,
                    country=ev.broadcaster_country,
                )
            ]

        channels: list[ChannelOut] = []
        seen_live_ids = set()
        for b in broadcasters:
            chan = _resolve_for_provider(
                db, user.provider_id, b.broadcaster_name, channel_cache,
            )
            if chan is None or chan.id in seen_live_ids:
                continue
            seen_live_ids.add(chan.id)
            channels.append(ChannelOut(
                live_id=chan.id,
                channel_name=chan.name,
                channel_logo=chan.stream_icon,
                broadcaster_name=b.broadcaster_name,
                broadcaster_country=b.country,
                language=b.language,
            ))

        if not channels:
            continue   # no playable channel for this user — drop

        out.append(SportEventOut(
            id=ev.id,
            title=ev.title,
            description=ev.description,
            sport=ev.sport,
            league=ev.league,
            home_team=ev.home_team,
            away_team=ev.away_team,
            start_utc=ev.start_utc,
            end_utc=ev.end_utc,
            cover_url=ev.cover_url,
            channels=channels,
        ))
        if len(out) >= limit:
            break

    return SportEventsResponse(items=out)
