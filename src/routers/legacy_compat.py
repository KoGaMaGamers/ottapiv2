"""Legacy API compatibility shim — keeps the old React/Capacitor app
(/var/www/ottapi/tv_app_v2/) working against this new backend without
touching its frontend code.

Strategy
========
Every URL the legacy app calls is re-exposed here at its original path
(`/api/v1/auth/*`, `/api/v1/user/streams/*`, `/api/v1/titles*`, etc.)
returning data in the legacy field-shape (Xtream-flavored field names,
bare arrays instead of paginated wrappers, etc.). The handlers reuse
the new backend's internal logic — DB queries via the same helpers
catalog.py / play.py use, then project results to the legacy shape.

This file is the ONLY place legacy-shape projection logic lives.
The rest of the backend stays clean and serves the new (Tauri) app.

When legacy is finally retired, delete this file + its include_router.

Field translation cheatsheet
============================
- New `id` → legacy `id` (internal DB id, used for new-API ID resolution)
- New `stream_id` (LiveStream) → legacy `stream_id` (Xtream provider id)
- New `xtream_id` (MovieStream/SeriesStream/SeriesEpisode) → legacy `xtream_id`
- New `name` (categories) → legacy `category_name`
- New `live_category_id` → legacy `category_id`
- New `release_date: date` → legacy `release_date: "YYYY-MM-DD"`
- New `genres: list[str]` → legacy `genre: "g1, g2, g3"`
- New paginated `{items, total, ...}` → legacy bare array
- New live tree → legacy flat list with parent_id pointers
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import urlparse, parse_qs

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import (
    IPTVUser,
    LiveCategory,
    LiveStream,
    MovieCategory,
    MovieStream,
    SerieCategory,
    SeriesEpisode,
    SeriesSeason,
    SeriesStream,
    XtreamProvider,
)
from ..services.donor_service import (
    allocate_or_reuse,
    build_stream_url,
    heartbeat as do_heartbeat,
    is_eligible,
    release as do_release,
)
from . import auth as auth_module
from . import catalog as catalog_module
from . import recommendations as recommendations_module
from .recommendations import RecommendationsRequest
from .auth import LoginRequest, LoginResponse, get_current_user, login as new_login
from .catalog import (
    EpisodeOut,
    SeasonOut,
    _build_live_tree,
    _genre_counts_for,
    _movie_to_list_item,
    _series_to_list_item,
)
from .me import CredentialsResponse, MeResponse, me as new_me, me_credentials as new_me_credentials
from ..services.adult import (
    adult_live_category_ids,
    adult_movie_category_ids,
    adult_serie_category_ids,
    apply_adult_filter,
)

logger = logging.getLogger(__name__)

# No prefix — every route below declares its full legacy URL explicitly.
router = APIRouter(tags=["legacy-compat"])


# ═══════════════════════════════════════════════════════════════════════
# Shared helpers
# ═══════════════════════════════════════════════════════════════════════

def _date_iso(d) -> Optional[str]:
    """date | datetime → 'YYYY-MM-DD'; None → None."""
    if d is None:
        return None
    if hasattr(d, "isoformat"):
        s = d.isoformat()
        return s[:10]
    return str(d)[:10]


def _resolve_live_internal_id(db: Session, provider_id: int, xtream_stream_id: int) -> Optional[int]:
    """Legacy passes Xtream stream_id; new endpoints take internal LiveStream.id."""
    row = (
        db.query(LiveStream.id)
        .filter(LiveStream.provider_id == provider_id)
        .filter(LiveStream.stream_id == xtream_stream_id)
        .one_or_none()
    )
    return row[0] if row else None


def _resolve_movie_internal_id(db: Session, provider_id: int, xtream_id: int) -> Optional[int]:
    row = (
        db.query(MovieStream.id)
        .filter(MovieStream.provider_id == provider_id)
        .filter(MovieStream.xtream_id == xtream_id)
        .one_or_none()
    )
    return row[0] if row else None


def _resolve_episode_internal_id(db: Session, provider_id: int, xtream_id: int) -> Optional[int]:
    row = (
        db.query(SeriesEpisode.id)
        .filter(SeriesEpisode.provider_id == provider_id)
        .filter(SeriesEpisode.xtream_id == xtream_id)
        .one_or_none()
    )
    return row[0] if row else None


def _movie_legacy_shape(m: MovieStream) -> Dict[str, Any]:
    """Project a MovieStream row to legacy VOD shape (Xtream-flavored)."""
    genres_list = [g.name for g in (m.genres or [])]
    return {
        "id": m.id,
        "xtream_id": m.xtream_id,
        "name": m.name,
        "o_name": m.o_name,
        "stream_type": "movie",
        "container_extension": m.container_extension,
        "tmdb_id": m.tmdb_id,
        "imdb_id": None,  # not stored in new schema
        "rating": m.rating_5based,  # legacy normalizes both 1-10 and 5-based
        "plot": m.description,
        "cast": m.actors,
        "genre": ", ".join(genres_list) if genres_list else None,
        # Also expose the list form so the legacy normalizer can fill
        # `genres` on cards / playback-history entries — used as
        # recommendation seeds via the genre-overlap signal.
        "genres": genres_list,
        "language": m.language,
        "release_date": _date_iso(m.releasedate) or (str(m.year) if m.year else None),
        "stream_icon": m.stream_icon or m.cover_big,
        "cover_big": m.cover_big,
        "backdrop_path": m.backdrop_path,
        "added": m.added.isoformat() if m.added else None,
        # Extras useful to legacy detail page:
        "director": m.director,
        "country": m.country,
        "youtube_trailer": m.youtube_trailer,
        "category_id": m.category_id,
        "movie_category_id": m.movie_category_id,
    }


def _series_legacy_shape(s: SeriesStream) -> Dict[str, Any]:
    genres_list = [g.name for g in (s.genres or [])]
    return {
        "id": s.id,
        "xtream_id": s.xtream_id,
        "name": s.name,
        "cover": s.cover,
        "stream_icon": s.cover,
        "plot": s.plot,
        "cast": s.cast,
        "director": s.director,
        "release_date": _date_iso(s.release_date),
        "rating": s.rating_5based,
        "language": s.language,
        "genres": genres_list,
        "genre": ", ".join(genres_list) if genres_list else None,
        "tmdb_id": s.tmdb_id,
        "episode_run_time": s.episode_run_time,
        "category_id": s.category_id,
        "series_category_id": s.series_category_id,
        "backdrop_path": s.backdrop_path,
    }


def _live_legacy_shape(l: LiveStream) -> Dict[str, Any]:
    return {
        "id": l.id,
        "stream_id": l.stream_id,
        "name": l.name,
        "stream_icon": l.stream_icon,
        "stream_type": "live",
        # Legacy "category_id" expects the LIVE_CATEGORY foreign key (DB id),
        # which is what its filtering UI passes back to fetchLiveChannels().
        "category_id": l.live_category_id,
        "tv_archive": 1 if l.tv_archive else 0,
        "tv_archive_duration": l.tv_archive_duration or 0,
        "epg_channel_id": l.epg_channel_id,
        "added": l.added.isoformat() if l.added else None,
    }


def _episode_legacy_shape(ep: SeriesEpisode) -> Dict[str, Any]:
    return {
        "id": ep.id,
        "xtream_id": ep.xtream_id,
        "title": ep.title,
        "season": ep.season_number,
        "episode_num": ep.episode_num,
        "container_extension": ep.container_extension,
        "air_date": _date_iso(ep.release_date),
        "plot": ep.plot,
        "rating": ep.rating,
        "stream_type": "series",
        "movie_image": ep.movie_image,
        "tmdb_id": ep.tmdb_id,
        "duration_secs": ep.duration_secs,
    }


def _season_legacy_shape(se: SeriesSeason) -> Dict[str, Any]:
    return {
        "id": se.id,
        "season_number": se.season_number,
        "name": se.name,
        "overview": se.overview,
        "episode_count": se.episode_count,
        "air_date": _date_iso(se.air_date),
        "cover": se.cover or se.cover_big,
        "cover_big": se.cover_big,
    }


# ═══════════════════════════════════════════════════════════════════════
# Auth shims — /api/v1/auth/*
# ═══════════════════════════════════════════════════════════════════════
#
# The new auth router lives at /auth/* (no /api/v1 prefix), so legacy URLs
# don't reach it. These shims expose the same handlers under the legacy
# /api/v1/auth/* paths.

@router.post("/api/v1/auth/login", response_model=LoginResponse)
def legacy_login(req: LoginRequest, db: Session = Depends(get_db)):
    return new_login(req, db)


class LegacyMeResponse(BaseModel):
    """Combined shape /auth/me returned in the legacy app, merging fields
    from the new /me + /me/credentials responses. Field names match
    what authService.js setSession() expects.
    """
    user_id: int
    username: str
    password: str
    base_stream_url: str
    preferred_output: str
    provider_id: int
    provider_name: Optional[str]
    is_populated: bool
    view_mode: Literal["fallback", "curated"]
    status: Optional[str]
    is_trial: Optional[bool]
    max_connections: Optional[int]
    subscription_enforced: bool
    subscription_exp_date: Optional[datetime]
    provider_exp_date: Optional[datetime]
    effective_exp_date: Optional[datetime]


@router.get("/api/v1/auth/me", response_model=LegacyMeResponse)
def legacy_auth_me(
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    me = new_me(user=user, db=db)
    creds = new_me_credentials(user=user, db=db)
    return LegacyMeResponse(
        user_id=me.user_id,
        username=creds.username,
        password=creds.password,
        base_stream_url=creds.base_stream_url,
        preferred_output=creds.preferred_output,
        provider_id=me.provider_id,
        provider_name=me.provider_name,
        is_populated=me.is_populated,
        view_mode=me.view_mode,
        status=me.status,
        is_trial=me.is_trial,
        max_connections=me.max_connections,
        subscription_enforced=me.subscription_enforced,
        subscription_exp_date=me.subscription_exp_date,
        provider_exp_date=me.provider_exp_date,
        effective_exp_date=me.effective_exp_date,
    )


@router.post("/api/v1/auth/logout")
def legacy_logout(user: IPTVUser = Depends(get_current_user)):
    """Legacy expected the server to invalidate the token. New backend
    is stateless JWT — token expires on its own. Just acknowledge."""
    return {"status": "ok"}


@router.api_route("/api/v1/auth/heartbeat", methods=["GET", "POST"])
def legacy_heartbeat(user: IPTVUser = Depends(get_current_user)):
    """Legacy session-level keepalive (unrelated to slot allocation).
    The new backend's /play/heartbeat is per-allocation; this shim
    just ack's so legacy can keep its useHeartbeat hook happy. Slot
    expiry is governed by allocation tokens emitted by /play/{type}/{id}
    and refreshed on play actions, not by this endpoint."""
    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════════════════
# Genres — /api/v1/genres (top-level, also at /api/v1/user/streams/genres)
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/v1/genres")
def legacy_genres(
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Bare TMDB genres list. Legacy expects {id, name} (no count)."""
    rows = catalog_module.list_genres(db=db)
    return [{"id": r.id, "name": r.name, "tmdb_genre_id": r.tmdb_genre_id} for r in rows]


@router.get("/api/v1/user/streams/genres")
def legacy_stream_genres(
    type: Optional[str] = Query(None, description="'movie' | 'vod' | 'series'"),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Genres with per-type count, used by Movies and Series filter pills.
    Legacy expects field name `movie_count` for movies, `series_count` for series.
    """
    t = (type or "").lower()
    if t in ("movie", "movies", "vod"):
        rows = _genre_counts_for(db, user.provider_id, kind="movies")
        return [
            {"id": r.id, "tmdb_genre_id": r.tmdb_genre_id, "name": r.name, "movie_count": r.count}
            for r in rows
        ]
    if t in ("series", "tv", "tvseries"):
        rows = _genre_counts_for(db, user.provider_id, kind="series")
        return [
            {"id": r.id, "tmdb_genre_id": r.tmdb_genre_id, "name": r.name, "series_count": r.count}
            for r in rows
        ]
    # No type — merge both counts onto each genre row.
    movie_rows = _genre_counts_for(db, user.provider_id, kind="movies")
    series_rows = _genre_counts_for(db, user.provider_id, kind="series")
    by_id: Dict[int, Dict[str, Any]] = {}
    for r in movie_rows:
        by_id[r.id] = {"id": r.id, "tmdb_genre_id": r.tmdb_genre_id, "name": r.name, "movie_count": r.count, "series_count": 0}
    for r in series_rows:
        if r.id in by_id:
            by_id[r.id]["series_count"] = r.count
        else:
            by_id[r.id] = {"id": r.id, "tmdb_genre_id": r.tmdb_genre_id, "name": r.name, "movie_count": 0, "series_count": r.count}
    return sorted(by_id.values(), key=lambda x: x["name"])


# ═══════════════════════════════════════════════════════════════════════
# Categories — /api/v1/user/streams/{live,vod,series}-categories
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/v1/user/streams/live-categories")
def legacy_live_categories(
    parent_id: Optional[int] = Query(None, description="0 = root nodes; N = children of N"),
    adult_only: bool = Query(
        False, description="Return ONLY adult categories (Adult page). Default excludes them."
    ),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Legacy expects a flat list with parent_id pointers. The new endpoint
    returns a tree, so we flatten it. Honors the legacy `parent_id` filter:
    parent_id=0 → root rows, parent_id=N → direct children of N."""
    rows = (
        db.query(LiveCategory)
        .filter(LiveCategory.provider_id == user.provider_id)
        .filter(LiveCategory.is_adult.is_(True) if adult_only else LiveCategory.is_adult.is_(False))
        .order_by(LiveCategory.parent_id.asc(), LiveCategory.category_name.asc())
        .all()
    )
    # Pre-compute child counts so legacy can show "(N)" badges without an
    # extra round-trip per row.
    child_counts: Dict[int, int] = {}
    for r in rows:
        if r.parent_id is not None:
            child_counts[r.parent_id] = child_counts.get(r.parent_id, 0) + 1

    def shape(r: LiveCategory) -> Dict[str, Any]:
        return {
            "id": r.id,
            "category_name": r.category_name,
            "parent_id": r.parent_id,
            "category_id": r.category_id,
            "child_count": child_counts.get(r.id, 0),
        }

    if parent_id is None:
        return [shape(r) for r in rows]
    if parent_id == 0:
        return [shape(r) for r in rows if r.parent_id is None]
    return [shape(r) for r in rows if r.parent_id == parent_id]


@router.get("/api/v1/user/streams/vod-categories")
def legacy_vod_categories(
    adult_only: bool = Query(
        False, description="Return ONLY adult categories (Adult page). Default excludes them."
    ),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(MovieCategory)
        .filter(MovieCategory.provider_id == user.provider_id)
        .filter(MovieCategory.is_adult.is_(True) if adult_only else MovieCategory.is_adult.is_(False))
        .order_by(MovieCategory.category_name.asc())
        .all()
    )
    return [
        {
            "id": r.id,
            "category_name": r.category_name,
            "language": r.language,
            "category_id": r.category_id,
        }
        for r in rows
    ]


@router.get("/api/v1/user/streams/series-categories")
def legacy_series_categories(
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(SerieCategory)
        .filter(SerieCategory.provider_id == user.provider_id)
        .filter(SerieCategory.is_adult.is_(False))
        .order_by(SerieCategory.category_name.asc())
        .all()
    )
    return [
        {
            "id": r.id,
            "category_name": r.category_name,
            "language": r.language,
            "category_id": r.category_id,
        }
        for r in rows
    ]


# ═══════════════════════════════════════════════════════════════════════
# Lists — /api/v1/user/streams/{live,vod,series}
# ═══════════════════════════════════════════════════════════════════════
#
# Legacy expects bare arrays (not paginated wrappers) and uses
# limit/offset (not page/per_page).

_MAX_ROWS = 2000  # cap so a missing limit can't fetch the whole catalog


# Sort presets exposed to the legacy client. Each maps to a (col, ascending)
# pair; the query then applies the standard "IS NULL ASC" trick to keep
# nulls sorted to the end (MySQL doesn't support NULLS LAST natively).
def _movie_sort_clause(name: Optional[str]):
    col_map = {
        "added_desc": (MovieStream.added, False),
        "year_desc": (MovieStream.year, False),
        "rating_desc": (MovieStream.rating_5based, False),
        "popularity_desc": (MovieStream.tmdb_popularity, False),
        "name_asc": (MovieStream.name, True),
    }
    col, asc = col_map.get(name or "added_desc", col_map["added_desc"])
    return col.is_(None), col.asc() if asc else col.desc()


def _series_sort_clause(name: Optional[str]):
    col_map = {
        "last_modified_desc": (SeriesStream.last_modified, False),
        "rating_desc": (SeriesStream.rating_5based, False),
        "popularity_desc": (SeriesStream.tmdb_popularity, False),
        "name_asc": (SeriesStream.name, True),
    }
    col, asc = col_map.get(name or "last_modified_desc", col_map["last_modified_desc"])
    return col.is_(None), col.asc() if asc else col.desc()


@router.get("/api/v1/user/streams/live")
def legacy_live(
    category_id: Optional[int] = Query(None),
    name: Optional[str] = Query(None),
    tv_archive: Optional[bool] = Query(None),
    adult_only: bool = Query(
        False, description="Return ONLY adult channels (Adult page). Default excludes them."
    ),
    limit: int = Query(200, ge=1, le=_MAX_ROWS),
    offset: int = Query(0, ge=0),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = db.query(LiveStream).filter(LiveStream.provider_id == user.provider_id)
    if category_id is not None:
        q = q.filter(LiveStream.live_category_id == category_id)
    if name:
        pattern = f"%{name.strip()}%"
        q = q.filter(or_(LiveStream.name.ilike(pattern), LiveStream.raw_name.ilike(pattern)))
    if tv_archive:
        q = q.filter(LiveStream.tv_archive.is_(True))
    q = apply_adult_filter(
        q, LiveStream.live_category_id,
        adult_live_category_ids(db, user.provider_id), adult_only,
    )
    q = q.order_by(LiveStream.xtream_live_id.asc(), LiveStream.id.asc())
    rows = q.offset(offset).limit(limit).all()
    return [_live_legacy_shape(l) for l in rows]


@router.get("/api/v1/user/streams/vod")
def legacy_vod(
    tmdb_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None),
    language: Optional[str] = Query(None),
    category_id: Optional[int] = Query(None),
    category_ids: Optional[str] = Query(None, description="comma-separated"),
    year: Optional[int] = Query(None),
    genre: Optional[str] = Query(None, description="genre name (legacy, ILIKE match — prefer genre_id)"),
    genre_id: Optional[int] = Query(None, description="TMDBGenre.id (numeric, exact match)"),
    sort: Optional[str] = Query(
        None,
        description="added_desc | year_desc | rating_desc | popularity_desc | name_asc (default: added_desc)",
    ),
    adult_only: bool = Query(
        False, description="Return ONLY adult movies (Adult page). Default excludes them."
    ),
    limit: int = Query(20, ge=1, le=_MAX_ROWS),
    offset: int = Query(0, ge=0),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = (
        db.query(MovieStream)
        .options(selectinload(MovieStream.genres))
        .filter(MovieStream.provider_id == user.provider_id)
    )
    if tmdb_id is not None:
        q = q.filter(MovieStream.tmdb_id == tmdb_id)
    if search:
        pattern = f"%{search.strip()}%"
        q = q.filter(or_(MovieStream.name.ilike(pattern), MovieStream.o_name.ilike(pattern), MovieStream.raw_name.ilike(pattern)))
    if language:
        q = q.filter(MovieStream.language == language.upper())
    if category_id is not None:
        q = q.filter(MovieStream.movie_category_id == category_id)
    if category_ids:
        ids = [int(t) for t in category_ids.split(",") if t.strip().isdigit()]
        if ids:
            q = q.filter(MovieStream.movie_category_id.in_(ids))
    if year is not None:
        q = q.filter(MovieStream.year == year)
    # Genre filter — prefer numeric genre_id (exact, indexed); fall
    # back to name ILIKE for older clients that still pass `genre`.
    if genre_id is not None:
        from ..models import movie_stream_genre_association
        q = (
            q.join(movie_stream_genre_association,
                   movie_stream_genre_association.c.movie_stream_id == MovieStream.id)
             .filter(movie_stream_genre_association.c.genre_id == genre_id)
        )
    elif genre:
        from ..models import TMDBGenre, movie_stream_genre_association
        q = (
            q.join(movie_stream_genre_association,
                   movie_stream_genre_association.c.movie_stream_id == MovieStream.id)
             .join(TMDBGenre, TMDBGenre.id == movie_stream_genre_association.c.genre_id)
             .filter(TMDBGenre.name.ilike(genre))
        )
    q = apply_adult_filter(
        q, MovieStream.movie_category_id,
        adult_movie_category_ids(db, user.provider_id), adult_only,
    )
    q = q.order_by(*_movie_sort_clause(sort))
    rows = q.offset(offset).limit(limit).all()
    return [_movie_legacy_shape(m) for m in rows]


@router.get("/api/v1/user/streams/series")
def legacy_series(
    search: Optional[str] = Query(None),
    language: Optional[str] = Query(None),
    category_id: Optional[int] = Query(None),
    category_ids: Optional[str] = Query(None, description="comma-separated SerieCategory.id list"),
    genre: Optional[str] = Query(None, description="genre name (legacy, ILIKE match — prefer genre_id)"),
    genre_id: Optional[int] = Query(None, description="TMDBGenre.id (numeric, exact match)"),
    sort: Optional[str] = Query(
        None,
        description="last_modified_desc | rating_desc | popularity_desc | name_asc (default: last_modified_desc)",
    ),
    limit: int = Query(40, ge=1, le=_MAX_ROWS),
    offset: int = Query(0, ge=0),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = (
        db.query(SeriesStream)
        .options(selectinload(SeriesStream.genres))
        .filter(SeriesStream.provider_id == user.provider_id)
    )
    if search:
        pattern = f"%{search.strip()}%"
        q = q.filter(or_(SeriesStream.name.ilike(pattern), SeriesStream.o_name.ilike(pattern), SeriesStream.raw_name.ilike(pattern)))
    if language:
        q = q.filter(SeriesStream.language == language.upper())
    if category_id is not None:
        q = q.filter(SeriesStream.series_category_id == category_id)
    if category_ids:
        ids = [int(t) for t in category_ids.split(",") if t.strip().isdigit()]
        if ids:
            q = q.filter(SeriesStream.series_category_id.in_(ids))
    # Genre filter — prefer numeric genre_id (exact, indexed); fall
    # back to name ILIKE for older clients that still pass `genre`.
    if genre_id is not None:
        from ..models import series_stream_genre_association
        q = (
            q.join(series_stream_genre_association,
                   series_stream_genre_association.c.series_stream_id == SeriesStream.id)
             .filter(series_stream_genre_association.c.genre_id == genre_id)
        )
    elif genre:
        from ..models import TMDBGenre, series_stream_genre_association
        q = (
            q.join(series_stream_genre_association,
                   series_stream_genre_association.c.series_stream_id == SeriesStream.id)
             .join(TMDBGenre, TMDBGenre.id == series_stream_genre_association.c.genre_id)
             .filter(TMDBGenre.name.ilike(genre))
        )
    q = apply_adult_filter(
        q, SeriesStream.series_category_id,
        adult_serie_category_ids(db, user.provider_id), False,
    )
    q = q.order_by(*_series_sort_clause(sort))
    rows = q.offset(offset).limit(limit).all()
    return [_series_legacy_shape(s) for s in rows]


# ═══════════════════════════════════════════════════════════════════════
# Series detail — seasons + episodes
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/v1/user/streams/series/{series_id}/seasons")
def legacy_series_seasons(
    series_id: int,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    series = (
        db.query(SeriesStream)
        .options(selectinload(SeriesStream.seasons))
        .filter(SeriesStream.id == series_id)
        .filter(SeriesStream.provider_id == user.provider_id)
        .one_or_none()
    )
    if series is None:
        raise HTTPException(status_code=404, detail="series not found")
    seasons = sorted(series.seasons, key=lambda x: x.season_number)
    return [_season_legacy_shape(se) for se in seasons]


@router.get("/api/v1/user/streams/series/{series_id}/episodes")
def legacy_series_episodes(
    series_id: int,
    season: Optional[int] = Query(None, description="If omitted: all episodes of all seasons"),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Authorize the series belongs to user's provider before returning eps
    found = (
        db.query(SeriesStream.id)
        .filter(SeriesStream.id == series_id)
        .filter(SeriesStream.provider_id == user.provider_id)
        .one_or_none()
    )
    if found is None:
        raise HTTPException(status_code=404, detail="series not found")

    q = (
        db.query(SeriesEpisode)
        .filter(SeriesEpisode.series_id == series_id)
    )
    if season is not None:
        q = q.filter(SeriesEpisode.season_number == season)
    q = q.order_by(SeriesEpisode.season_number.asc(), SeriesEpisode.episode_num.asc())
    return [_episode_legacy_shape(ep) for ep in q.all()]


# ═══════════════════════════════════════════════════════════════════════
# Stream access / stop  — /api/v1/user/streams/access | stop
# ═══════════════════════════════════════════════════════════════════════
#
# Legacy uses Xtream stream_id; new endpoints take internal DB id. The
# shim resolves IDs via the helpers above, then calls the donor allocator
# directly (avoids self-HTTP) and wraps the response in the legacy shape:
# `{ url, stream_kind, stream_ref, allocation_id, allocation_type }`.
#
# `allocation_id` legacy field carries the new allocation `token` value —
# the legacy stop endpoint then forwards it through to /play/release.

class LegacyAccessRequest(BaseModel):
    kind: Literal["live", "movie", "series", "catchup"]
    stream_id: int  # Xtream id (live: stream_id, movie/episode: xtream_id)
    stream_ref: Optional[str] = None
    container_extension: Optional[str] = None
    duration: Optional[int] = None  # catchup minutes
    start: Optional[str] = None     # catchup "YYYY-MM-DD:HH-MM"


@router.post("/api/v1/user/streams/access")
def legacy_stream_access(
    body: LegacyAccessRequest,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not is_eligible(user):
        raise HTTPException(status_code=403, detail="subscription expired or account inactive")

    if body.kind == "live":
        # Confirm the live channel exists for the user's provider
        live = (
            db.query(LiveStream)
            .filter(LiveStream.provider_id == user.provider_id)
            .filter(LiveStream.stream_id == body.stream_id)
            .one_or_none()
        )
        if live is None:
            raise HTTPException(status_code=404, detail="live stream not found")
        alloc = allocate_or_reuse(db, user)
        if alloc is None:
            raise HTTPException(status_code=503, detail="no slot available; try again shortly")
        ext = (user.preferred_output or "m3u8")
        url = build_stream_url(alloc.slot, "live", live.stream_id, ext, db=db)
        return {
            "url": url,
            "stream_kind": "live",
            "stream_ref": body.stream_ref,
            "allocation_id": alloc.token,
            "allocation_type": "donor" if alloc.slot.username != user.username else "owner",
            "expires_at": alloc.expires_at.isoformat() if alloc.expires_at else None,
        }

    if body.kind == "catchup":
        # Catchup builds a /timeshift/... URL using the user's own creds
        # (legacy app does this client-side too via authService.buildCatchupUrl).
        # No slot allocation in legacy semantics — provider tolerates it
        # because catchup uses the user's primary credentials.
        if body.duration is None or not body.start:
            raise HTTPException(status_code=400, detail="catchup requires duration and start")
        provider = db.get(XtreamProvider, user.provider_id)
        if provider is None:
            raise HTTPException(status_code=404, detail="provider not found")
        base = (provider.base_url or "").rstrip("/")
        url = f"{base}/timeshift/{user.username}/{user.password}/{body.duration}/{body.start}/{body.stream_id}.m3u8"
        return {
            "url": url,
            "stream_kind": "catchup",
            "stream_ref": body.stream_ref,
            "allocation_id": None,
            "allocation_type": "owner",
        }

    if body.kind == "movie":
        movie = (
            db.query(MovieStream)
            .filter(MovieStream.provider_id == user.provider_id)
            .filter(MovieStream.xtream_id == body.stream_id)
            .one_or_none()
        )
        if movie is None:
            raise HTTPException(status_code=404, detail="movie not found")
        alloc = allocate_or_reuse(db, user)
        if alloc is None:
            raise HTTPException(status_code=503, detail="no slot available; try again shortly")
        ext = body.container_extension or movie.container_extension or "mp4"
        url = build_stream_url(alloc.slot, "movie", movie.xtream_id, ext, db=db)
        return {
            "url": url,
            "stream_kind": "movie",
            "stream_ref": body.stream_ref,
            "allocation_id": alloc.token,
            "allocation_type": "donor" if alloc.slot.username != user.username else "owner",
            "expires_at": alloc.expires_at.isoformat() if alloc.expires_at else None,
        }

    # kind == "series" — legacy passes the Xtream EPISODE id (not series id)
    ep = (
        db.query(SeriesEpisode)
        .filter(SeriesEpisode.provider_id == user.provider_id)
        .filter(SeriesEpisode.xtream_id == body.stream_id)
        .one_or_none()
    )
    if ep is None:
        raise HTTPException(status_code=404, detail="episode not found")
    alloc = allocate_or_reuse(db, user)
    if alloc is None:
        raise HTTPException(status_code=503, detail="no slot available; try again shortly")
    ext = body.container_extension or ep.container_extension or "mkv"
    url = build_stream_url(alloc.slot, "series", ep.xtream_id, ext, db=db)
    return {
        "url": url,
        "stream_kind": "series",
        "stream_ref": body.stream_ref,
        "allocation_id": alloc.token,
        "allocation_type": "donor" if alloc.slot.username != user.username else "owner",
        "expires_at": alloc.expires_at.isoformat() if alloc.expires_at else None,
    }


class LegacyStopRequest(BaseModel):
    allocation_id: Optional[str] = None  # carries allocation_token in shim
    stream_ref: Optional[str] = None
    stream_kind: Optional[str] = None
    reason: Optional[str] = "stop"


@router.post("/api/v1/user/streams/stop")
def legacy_stream_stop(
    body: LegacyStopRequest,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not body.allocation_id:
        # Catchup or owner-creds streams don't have a token to release.
        return {"status": "ok", "released": False}
    if not do_release(db, user, str(body.allocation_id)):
        # 404 here would force the client to error; legacy expects a graceful
        # ack (it may fire stop on an already-expired allocation).
        return {"status": "ok", "released": False}
    return {"status": "ok", "released": True}


# ═══════════════════════════════════════════════════════════════════════
# EPG — /api/v1/user/epg/{stream_id} | catchup
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/v1/user/epg/{xtream_stream_id}")
def legacy_epg(
    xtream_stream_id: int,
    limit: int = Query(10, ge=1, le=20),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Legacy expects a flat array of EPG entries; new wraps in {epg_listings, cached}.
    Resolve Xtream stream_id → internal LiveStream.id, call new endpoint, unwrap."""
    live_id = _resolve_live_internal_id(db, user.provider_id, xtream_stream_id)
    if live_id is None:
        raise HTTPException(status_code=404, detail="live stream not found")
    payload = catalog_module.get_live_epg(live_id=live_id, limit=limit, user=user, db=db)
    listings = payload.get("epg_listings") if isinstance(payload, dict) else []
    return listings or []


@router.get("/api/v1/user/epg/{xtream_stream_id}/catchup")
def legacy_epg_catchup(
    xtream_stream_id: int,
    duration: int = Query(...),
    start: str = Query(...),
    user: IPTVUser = Depends(get_current_user),
):
    """Legacy uses this only for echo confirmation — the actual catchup
    URL is built client-side via authService.buildCatchupUrl(). Returning
    the same params it sent confirms the route exists and the channel
    supports catchup."""
    return {"stream_id": xtream_stream_id, "duration": duration, "start": start}


# ═══════════════════════════════════════════════════════════════════════
# Search — /api/v1/search and /api/v1/search/global
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/v1/search")
def legacy_search(
    query: Optional[str] = Query(None),
    type: Optional[str] = Query(None, description="'movie' | 'tvSeries' (legacy values)"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Legacy search endpoint returning {results, total, page, page_size}.
    Maps legacy `query` → new `q`, legacy `page_size` → new `per_page`,
    legacy 'movie'/'tvSeries' → new 'movies'/'series'."""
    q = (query or "").strip()
    if len(q) < 2:
        return {"results": [], "total": 0, "page": page, "page_size": page_size}

    t = (type or "").lower()
    if t in ("movie", "movies", "vod"):
        kind = "movies"
    elif t in ("tvseries", "series", "tv"):
        kind = "series"
    elif t == "live":
        kind = "live"
    else:
        kind = "movies"  # default

    response = catalog_module.search(q=q, type=kind, page=page, per_page=page_size, user=user, db=db)
    items = response.get("items", []) if isinstance(response, dict) else []
    total = response.get("total", 0) if isinstance(response, dict) else 0

    # Project items to legacy shape per kind
    if kind == "movies":
        # search() returns MovieListItem objects when items are list of pydantic
        # In our handler list_movies returns raw projected dicts via _movie_to_list_item;
        # search() does the same. Re-fetch as DB rows for legacy shape.
        ids = [it.id for it in items]
        if ids:
            rows = (
                db.query(MovieStream)
                .options(selectinload(MovieStream.genres))
                .filter(MovieStream.id.in_(ids))
                .all()
            )
            id_to_row = {r.id: r for r in rows}
            results = [_movie_legacy_shape(id_to_row[i]) for i in ids if i in id_to_row]
        else:
            results = []
    elif kind == "series":
        ids = [it.id for it in items]
        if ids:
            rows = (
                db.query(SeriesStream)
                .options(selectinload(SeriesStream.genres))
                .filter(SeriesStream.id.in_(ids))
                .all()
            )
            id_to_row = {r.id: r for r in rows}
            results = [_series_legacy_shape(id_to_row[i]) for i in ids if i in id_to_row]
        else:
            results = []
    else:
        # Live results — search() returns raw LiveStream-like dicts
        ids = [it.get("id") if isinstance(it, dict) else getattr(it, "id", None) for it in items]
        ids = [i for i in ids if i is not None]
        if ids:
            rows = db.query(LiveStream).filter(LiveStream.id.in_(ids)).all()
            id_to_row = {r.id: r for r in rows}
            results = [_live_legacy_shape(id_to_row[i]) for i in ids if i in id_to_row]
        else:
            results = []

    return {"results": results, "total": total, "page": page, "page_size": page_size}


@router.get("/api/v1/search/global")
def legacy_search_global(
    q: str = Query("", min_length=0),
    types: Optional[str] = Query("live,movies,series", description="comma-separated"),
    limit: int = Query(20, ge=1, le=100),
    include_predictions: bool = Query(True),
    min_score: float = Query(0.0),
    lang: Optional[str] = Query(None),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Legacy unified search: returns predictions + grouped results across
    types. We aggregate per-type from the new /search endpoint."""
    query = (q or "").strip()
    type_list = [t.strip() for t in (types or "").split(",") if t.strip()]
    groups: Dict[str, List[Dict[str, Any]]] = {"live": [], "movies": [], "series": []}
    totals: Dict[str, int] = {"live": 0, "movies": 0, "series": 0}

    if len(query) < 2:
        return {
            "predictions": [],
            "groups": groups,
            "meta": {"total_by_type": totals, "next_cursor_by_type": {}, "query_time_ms": 0},
        }

    started = time.time()
    for kind in type_list:
        if kind not in ("live", "movies", "series"):
            continue
        try:
            resp = catalog_module.search(q=query, type=kind, page=1, per_page=limit, user=user, db=db)
        except HTTPException:
            continue
        items = resp.get("items", []) if isinstance(resp, dict) else []
        totals[kind] = resp.get("total", 0) if isinstance(resp, dict) else 0
        if kind == "movies":
            ids = [it.id for it in items]
            rows = (
                db.query(MovieStream)
                .options(selectinload(MovieStream.genres))
                .filter(MovieStream.id.in_(ids))
                .all()
            ) if ids else []
            id_to_row = {r.id: r for r in rows}
            groups["movies"] = [_movie_legacy_shape(id_to_row[i]) for i in ids if i in id_to_row]
        elif kind == "series":
            ids = [it.id for it in items]
            rows = (
                db.query(SeriesStream)
                .options(selectinload(SeriesStream.genres))
                .filter(SeriesStream.id.in_(ids))
                .all()
            ) if ids else []
            id_to_row = {r.id: r for r in rows}
            groups["series"] = [_series_legacy_shape(id_to_row[i]) for i in ids if i in id_to_row]
        else:  # live
            ids = [it.get("id") if isinstance(it, dict) else getattr(it, "id", None) for it in items]
            ids = [i for i in ids if i is not None]
            rows = db.query(LiveStream).filter(LiveStream.id.in_(ids)).all() if ids else []
            id_to_row = {r.id: r for r in rows}
            groups["live"] = [_live_legacy_shape(id_to_row[i]) for i in ids if i in id_to_row]

    return {
        "predictions": [],  # legacy app accepts empty
        "groups": groups,
        "meta": {
            "total_by_type": totals,
            "next_cursor_by_type": {k: None for k in groups},
            "query_time_ms": int((time.time() - started) * 1000),
        },
    }


# ═══════════════════════════════════════════════════════════════════════
# Similar titles — /api/v1/user/streams/similar
# ═══════════════════════════════════════════════════════════════════════
#
# Legacy is single-seed paginated. New /recommendations is multi-seed,
# top-N. We translate by issuing a single-seed POST and slicing.

# Tauri-style multi-seed recommendations — proxies the new
# /api/v1/recommendations endpoint and reshapes the response into the
# legacy field-shape so HomePage's "You should also like" row can use it.
@router.post("/api/v1/user/streams/recommendations")
def legacy_recommendations(
    body: RecommendationsRequest,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    response = recommendations_module.get_recommendations(body=body, db=db, user=user)
    movie_ids = [m.id for m in response.movies]
    series_ids = [s.id for s in response.series]
    movie_rows = (
        db.query(MovieStream)
        .options(selectinload(MovieStream.genres))
        .filter(MovieStream.id.in_(movie_ids))
        .all()
        if movie_ids else []
    )
    series_rows = (
        db.query(SeriesStream)
        .options(selectinload(SeriesStream.genres))
        .filter(SeriesStream.id.in_(series_ids))
        .all()
        if series_ids else []
    )
    movie_by_id = {m.id: m for m in movie_rows}
    series_by_id = {s.id: s for s in series_rows}
    return {
        "movies": [_movie_legacy_shape(movie_by_id[i]) for i in movie_ids if i in movie_by_id],
        "series": [_series_legacy_shape(series_by_id[i]) for i in series_ids if i in series_by_id],
    }


@router.get("/api/v1/user/streams/similar")
def legacy_similar(
    type: Literal["movie", "series"] = Query(...),
    tmdb_id: int = Query(...),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Look up the seed item to pull its genres for better recommendations.
    seed_genres: List[str] = []
    if type == "movie":
        seed = (
            db.query(MovieStream)
            .options(selectinload(MovieStream.genres))
            .filter(MovieStream.provider_id == user.provider_id)
            .filter(MovieStream.tmdb_id == tmdb_id)
            .one_or_none()
        )
        if seed:
            seed_genres = [g.name for g in (seed.genres or [])]
    else:
        seed = (
            db.query(SeriesStream)
            .options(selectinload(SeriesStream.genres))
            .filter(SeriesStream.provider_id == user.provider_id)
            .filter(SeriesStream.tmdb_id == tmdb_id)
            .one_or_none()
        )
        if seed:
            seed_genres = [g.name for g in (seed.genres or [])]

    # Same-genre items, sorted by popularity, excluding the seed itself.
    if not seed_genres:
        return {"items": [], "page": page, "has_more": False, "total_matches": 0}

    if type == "movie":
        from ..models import TMDBGenre, movie_stream_genre_association
        q = (
            db.query(MovieStream)
            .options(selectinload(MovieStream.genres))
            .join(movie_stream_genre_association,
                  movie_stream_genre_association.c.movie_stream_id == MovieStream.id)
            .join(TMDBGenre, TMDBGenre.id == movie_stream_genre_association.c.genre_id)
            .filter(MovieStream.provider_id == user.provider_id)
            .filter(MovieStream.tmdb_id != tmdb_id)
            .filter(TMDBGenre.name.in_(seed_genres))
            .group_by(MovieStream.id)
            .order_by(MovieStream.tmdb_popularity.is_(None), MovieStream.tmdb_popularity.desc())
        )
        q = apply_adult_filter(
            q, MovieStream.movie_category_id,
            adult_movie_category_ids(db, user.provider_id), False,
        )
        total = q.count()
        rows = q.offset((page - 1) * limit).limit(limit).all()
        items = [_movie_legacy_shape(m) for m in rows]
    else:
        from ..models import TMDBGenre, series_stream_genre_association
        q = (
            db.query(SeriesStream)
            .options(selectinload(SeriesStream.genres))
            .join(series_stream_genre_association,
                  series_stream_genre_association.c.series_stream_id == SeriesStream.id)
            .join(TMDBGenre, TMDBGenre.id == series_stream_genre_association.c.genre_id)
            .filter(SeriesStream.provider_id == user.provider_id)
            .filter(SeriesStream.tmdb_id != tmdb_id)
            .filter(TMDBGenre.name.in_(seed_genres))
            .group_by(SeriesStream.id)
            .order_by(SeriesStream.tmdb_popularity.is_(None), SeriesStream.tmdb_popularity.desc())
        )
        q = apply_adult_filter(
            q, SeriesStream.series_category_id,
            adult_serie_category_ids(db, user.provider_id), False,
        )
        total = q.count()
        rows = q.offset((page - 1) * limit).limit(limit).all()
        items = [_series_legacy_shape(s) for s in rows]

    return {
        "items": items,
        "page": page,
        "has_more": (page * limit) < total,
        "total_matches": total,
    }


# ═══════════════════════════════════════════════════════════════════════
# Preview clip — /api/v1/user/preview-clip
# ═══════════════════════════════════════════════════════════════════════
#
# Legacy semantics: return a short (60s) MP4 clip URL the hero carousel
# plays as a hover-preview. The new backend doesn't generate clips —
# but it does expose direct stream URLs via /play/preview/{type}/{id}
# (no slot allocation, uses owner creds). For legacy compatibility we
# return the full stream URL as the "clip" — the legacy hero player
# will start at start_at_sec and the carousel auto-advances after
# duration_sec, so it behaves close enough to the clipped version.

class LegacyPreviewClip(BaseModel):
    clip_url: str
    start_at_sec: int
    duration_sec: int
    cached: bool
    expires_at: int


@router.get("/api/v1/user/preview-clip", response_model=LegacyPreviewClip)
def legacy_preview_clip(
    url: str = Query(..., description="Full provider stream URL (legacy passes the whole thing)"),
    type: Optional[str] = Query("movie"),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Heuristic: the legacy URL embeds {type}/{user}/{pass}/{xtream_id}.{ext}
    # Pull the xtream_id and decide which preview endpoint to hit.
    parsed = urlparse(url)
    segs = [s for s in parsed.path.split("/") if s]
    xtream_id_str = ""
    if segs:
        last = segs[-1]
        # strip extension
        if "." in last:
            xtream_id_str = last.rsplit(".", 1)[0]
        else:
            xtream_id_str = last
    try:
        xtream_id = int(xtream_id_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="could not parse xtream id from url")

    t = (type or "").lower()
    # Resolve to a stream URL — use owner creds (no slot allocation, like
    # the new /play/preview endpoints).
    if t == "movie":
        movie = (
            db.query(MovieStream)
            .filter(MovieStream.provider_id == user.provider_id)
            .filter(MovieStream.xtream_id == xtream_id)
            .one_or_none()
        )
        if movie is None:
            raise HTTPException(status_code=404, detail="movie not found")
        ext = movie.container_extension or "mp4"
        clip_url = build_stream_url(user, "movie", movie.xtream_id, ext, db=db)
    elif t == "series":
        ep = (
            db.query(SeriesEpisode)
            .filter(SeriesEpisode.provider_id == user.provider_id)
            .filter(SeriesEpisode.xtream_id == xtream_id)
            .one_or_none()
        )
        if ep is None:
            raise HTTPException(status_code=404, detail="episode not found")
        ext = ep.container_extension or "mkv"
        clip_url = build_stream_url(user, "series", ep.xtream_id, ext, db=db)
    else:
        # live: forward the URL unchanged (no clip semantics for live)
        clip_url = url

    return LegacyPreviewClip(
        clip_url=clip_url,
        start_at_sec=300,    # 5 min in (matches legacy random-offset window)
        duration_sec=60,
        cached=False,
        expires_at=int(time.time()) + 3600,
    )


# ═══════════════════════════════════════════════════════════════════════
# Titles — /api/v1/titles | /api/v1/titles/{id}
# ═══════════════════════════════════════════════════════════════════════
#
# Legacy uses these for IMDB/TMDB-style top-rated browsing. New backend
# is provider-scoped, so we synthesize from /movies + /series sorted by
# rating. The shape closely matches what fetchTitles consumes.

@router.get("/api/v1/titles")
def legacy_titles(
    type: Optional[str] = Query(None, description="'movie' | 'tvSeries'"),
    order_by: str = Query("averageRating"),
    order: str = Query("desc"),
    limit: int = Query(20, ge=1, le=100),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    out: List[Dict[str, Any]] = []
    t = (type or "").lower()

    if t in ("movie", ""):
        q = (
            db.query(MovieStream)
            .filter(MovieStream.provider_id == user.provider_id)
            .filter(MovieStream.tmdb_id.isnot(None))
        )
        q = apply_adult_filter(
            q, MovieStream.movie_category_id,
            adult_movie_category_ids(db, user.provider_id), False,
        )
        if order_by == "averageRating":
            col = MovieStream.rating_5based
        elif order_by == "numVotes":
            col = MovieStream.tmdb_popularity
        else:
            col = MovieStream.year
        q = q.order_by(col.is_(None), col.desc() if order == "desc" else col.asc())
        for m in q.limit(limit).all():
            out.append({
                "id": f"tmdb_{m.tmdb_id}" if m.tmdb_id else f"ott_{m.id}",
                "primaryTitle": m.name,
                "originalTitle": m.o_name or m.name,
                "type": "movie",
                "coverUrl": m.cover_big or m.stream_icon,
                "startYear": str(m.year) if m.year else None,
                "averageRating": m.rating_5based,
                "numVotes": int(m.tmdb_popularity or 0),
            })

    if t in ("tvseries", "series", ""):
        q = (
            db.query(SeriesStream)
            .filter(SeriesStream.provider_id == user.provider_id)
            .filter(SeriesStream.tmdb_id.isnot(None))
        )
        q = apply_adult_filter(
            q, SeriesStream.series_category_id,
            adult_serie_category_ids(db, user.provider_id), False,
        )
        if order_by == "averageRating":
            col = SeriesStream.rating_5based
        elif order_by == "numVotes":
            col = SeriesStream.tmdb_popularity
        else:
            col = SeriesStream.last_modified
        q = q.order_by(col.is_(None), col.desc() if order == "desc" else col.asc())
        for s in q.limit(limit).all():
            year_str = None
            if s.release_date:
                year_str = str(s.release_date.year)
            out.append({
                "id": f"tmdb_{s.tmdb_id}" if s.tmdb_id else f"ott_{s.id}",
                "primaryTitle": s.name,
                "originalTitle": s.o_name or s.name,
                "type": "tvSeries",
                "coverUrl": s.cover or s.backdrop_path,
                "startYear": year_str,
                "averageRating": s.rating_5based,
                "numVotes": int(s.tmdb_popularity or 0),
            })

    return out


@router.get("/api/v1/titles/{title_id}")
def legacy_title_detail(
    title_id: str,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Resolve an IMDB ('tt...') or TMDB ('tmdb_NNN') id back to a movie
    or series in this provider's catalog. IMDB lookup not supported
    (new schema doesn't store imdb_id) → returns 404."""
    if title_id.startswith("tmdb_"):
        try:
            tmdb_id = int(title_id[len("tmdb_"):])
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid tmdb id")
        movie = (
            db.query(MovieStream)
            .options(selectinload(MovieStream.genres))
            .filter(MovieStream.provider_id == user.provider_id)
            .filter(MovieStream.tmdb_id == tmdb_id)
            .one_or_none()
        )
        if movie:
            return {**_movie_legacy_shape(movie), "type": "movie"}
        series = (
            db.query(SeriesStream)
            .options(selectinload(SeriesStream.genres))
            .filter(SeriesStream.provider_id == user.provider_id)
            .filter(SeriesStream.tmdb_id == tmdb_id)
            .one_or_none()
        )
        if series:
            return {**_series_legacy_shape(series), "type": "tvSeries"}
        raise HTTPException(status_code=404, detail="title not found")
    raise HTTPException(status_code=404, detail="title id format not supported")
