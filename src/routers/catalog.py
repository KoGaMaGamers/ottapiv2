"""Read-side catalog endpoints scoped to the logged-in user's provider.

Stream URLs intentionally NEVER appear in these responses — playback uses
the dedicated /api/v1/play/* endpoints (donor allocation gates each play).

Endpoint summary:
  GET /api/v1/genres
  GET /api/v1/categories/{kind}            kind=live|movies|series
  GET /api/v1/live                         ?category_id=&page=&per_page=
  GET /api/v1/movies                       ?category_id=&language=&genre_id=&sort=&page=&per_page=
  GET /api/v1/series                       ?category_id=&language=&genre_id=&sort=&page=&per_page=
  GET /api/v1/movies/{id}
  GET /api/v1/series/{id}
  GET /api/v1/series/{id}/seasons/{n}/episodes
  GET /api/v1/search                       ?q=&type=&page=&per_page=
"""

import logging
import threading
import time
from datetime import date, datetime
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
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
    TMDBGenre,
    movie_stream_genre_association,
    series_stream_genre_association,
)
from ..services.donor_service import pick_url_owner
from ..services.xtream_client import XtreamClient
from .auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["catalog"])


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------

DEFAULT_PER_PAGE = 50
# Cap of 500 covers single-shot fetches like the parental adult-channel
# discovery (legacy passed limit=2000) without enabling unbounded scans.
MAX_PER_PAGE = 500


def _paginate(query, page: int, per_page: int):
    total = query.count()
    items = query.offset((page - 1) * per_page).limit(per_page).all()
    return items, total


def _parse_id_list(raw: Optional[str]) -> Optional[List[int]]:
    """
    Accept either a single integer ("5") or a comma-separated list ("1,2,3")
    and return a deduped list[int]. Returns None when the value is empty/None.
    Skips non-numeric tokens silently — clients can construct from typed prefs
    without worrying about stray whitespace.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    out: List[int] = []
    seen = set()
    for tok in s.split(","):
        t = tok.strip()
        if not t.lstrip("-").isdigit():
            continue
        v = int(t)
        if v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out or None


class Page(BaseModel):
    items: list
    total: int
    page: int
    per_page: int
    has_next: bool


def _page(items, total: int, page: int, per_page: int) -> dict:
    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_next": (page * per_page) < total,
    }


# ---------------------------------------------------------------------------
# Response shapes
# ---------------------------------------------------------------------------

class GenreOut(BaseModel):
    id: int
    tmdb_genre_id: Optional[int]
    name: str

    class Config:
        from_attributes = True


class LiveCategoryNode(BaseModel):
    id: int
    name: str
    category_id: Optional[int]
    children: List["LiveCategoryNode"] = []


LiveCategoryNode.model_rebuild()


class FlatCategory(BaseModel):
    id: int
    category_id: int
    name: str
    language: Optional[str]


class LiveStreamItem(BaseModel):
    id: int
    stream_id: int
    name: str
    raw_name: Optional[str]
    stream_icon: Optional[str]
    epg_channel_id: Optional[str]
    category_id: Optional[int]
    live_category_id: Optional[int]
    tv_archive: bool
    added: Optional[datetime]


class MovieListItem(BaseModel):
    id: int
    name: str
    year: Optional[int]
    language: Optional[str]
    rating_5based: Optional[float]
    cover_big: Optional[str]
    stream_icon: Optional[str]
    backdrop_path: Optional[str]
    tmdb_id: Optional[int]
    o_language: Optional[str]
    tmdb_vote_average: Optional[float]
    tmdb_popularity: Optional[float]
    duration_secs: Optional[int]
    added: Optional[datetime]
    genres: List[str] = []


class MovieDetail(MovieListItem):
    o_name: Optional[str]
    description: Optional[str]
    actors: Optional[str]
    director: Optional[str]
    country: Optional[str]
    age_rating: Optional[str]
    bitrate: Optional[int]
    status: Optional[str]
    youtube_trailer: Optional[str]
    releasedate: Optional[date]
    duration: Optional[str]
    video_codec: Optional[str]
    video_width: Optional[int]
    video_height: Optional[int]
    audio_codec: Optional[str]
    audio_channels: Optional[int]
    audio_channel_layout: Optional[str]
    container_extension: Optional[str]
    category_id: Optional[int]
    movie_category_id: Optional[int]


class SeasonOut(BaseModel):
    id: int
    season_number: int
    name: Optional[str]
    overview: Optional[str]
    air_date: Optional[date]
    episode_count: Optional[int]
    cover: Optional[str]
    cover_big: Optional[str]


class SeriesListItem(BaseModel):
    id: int
    name: str
    language: Optional[str]
    rating_5based: Optional[float]
    cover: Optional[str]
    backdrop_path: Optional[str]
    tmdb_id: Optional[int]
    o_language: Optional[str]
    tmdb_vote_average: Optional[float]
    tmdb_popularity: Optional[float]
    last_modified: Optional[datetime]
    release_date: Optional[date]
    genres: List[str] = []


class SeriesDetail(SeriesListItem):
    o_name: Optional[str]
    plot: Optional[str]
    cast: Optional[str]
    director: Optional[str]
    youtube_trailer: Optional[str]
    episode_run_time: Optional[int]
    category_id: Optional[int]
    series_category_id: Optional[int]
    seasons: List[SeasonOut] = []


class EpisodeOut(BaseModel):
    id: int
    season_number: int
    episode_num: int
    title: Optional[str]
    plot: Optional[str]
    movie_image: Optional[str]
    duration_secs: Optional[int]
    rating: Optional[str]
    release_date: Optional[date]
    container_extension: Optional[str]
    tmdb_id: Optional[int]
    audio_language: Optional[str]
    video_codec: Optional[str]
    video_width: Optional[int]
    video_height: Optional[int]
    audio_codec: Optional[str]
    audio_channels: Optional[int]
    audio_channel_layout: Optional[str]
    frame_rate: Optional[str]
    aspect_ratio: Optional[str]
    bitrate: Optional[int]
    crew: Optional[str]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _movie_to_list_item(m: MovieStream) -> MovieListItem:
    return MovieListItem(
        id=m.id, name=m.name, year=m.year, language=m.language,
        rating_5based=m.rating_5based, cover_big=m.cover_big,
        stream_icon=m.stream_icon, backdrop_path=m.backdrop_path,
        tmdb_id=m.tmdb_id, o_language=m.o_language,
        tmdb_vote_average=m.tmdb_vote_average, tmdb_popularity=m.tmdb_popularity,
        duration_secs=m.duration_secs, added=m.added,
        genres=[g.name for g in (m.genres or [])],
    )


def _series_to_list_item(s: SeriesStream) -> SeriesListItem:
    return SeriesListItem(
        id=s.id, name=s.name, language=s.language, rating_5based=s.rating_5based,
        cover=s.cover, backdrop_path=s.backdrop_path,
        tmdb_id=s.tmdb_id, o_language=s.o_language,
        tmdb_vote_average=s.tmdb_vote_average, tmdb_popularity=s.tmdb_popularity,
        last_modified=s.last_modified, release_date=s.release_date,
        genres=[g.name for g in (s.genres or [])],
    )


def _live_to_item(l: LiveStream) -> LiveStreamItem:
    return LiveStreamItem(
        id=l.id, stream_id=l.stream_id, name=l.name, raw_name=l.raw_name,
        stream_icon=l.stream_icon, epg_channel_id=l.epg_channel_id,
        category_id=l.category_id, live_category_id=l.live_category_id,
        tv_archive=bool(l.tv_archive), added=l.added,
    )


_MOVIE_SORT = {
    "added_desc": MovieStream.added.desc(),
    "added_asc": MovieStream.added.asc(),
    "year_desc": MovieStream.year.desc(),
    "year_asc": MovieStream.year.asc(),
    "rating_desc": MovieStream.rating_5based.desc(),
    "name_asc": MovieStream.name.asc(),
    "popularity_desc": MovieStream.tmdb_popularity.desc(),
}

_SERIES_SORT = {
    "last_modified_desc": SeriesStream.last_modified.desc(),
    "name_asc": SeriesStream.name.asc(),
    "popularity_desc": SeriesStream.tmdb_popularity.desc(),
    "rating_desc": SeriesStream.rating_5based.desc(),
}


# ---------------------------------------------------------------------------
# Genres
# ---------------------------------------------------------------------------

@router.get("/genres", response_model=List[GenreOut])
def list_genres(db: Session = Depends(get_db)):
    return db.query(TMDBGenre).order_by(TMDBGenre.name).all()


class GenreCountOut(BaseModel):
    id: int
    tmdb_genre_id: Optional[int]
    name: str
    count: int


def _genre_counts_for(
    db: Session,
    provider_id: int,
    *,
    kind: str,
) -> List[GenreCountOut]:
    """Return the TMDB genres that have ≥1 stream of the given kind on the
    user's provider. Ordered by name; zero-count genres dropped via HAVING."""
    if kind == "movies":
        junction = movie_stream_genre_association
        stream_table = MovieStream
        stream_fk_col = junction.c.movie_stream_id
    else:
        junction = series_stream_genre_association
        stream_table = SeriesStream
        stream_fk_col = junction.c.series_stream_id

    rows = (
        db.query(
            TMDBGenre.id,
            TMDBGenre.tmdb_genre_id,
            TMDBGenre.name,
            func.count(stream_table.id).label("count"),
        )
        .outerjoin(junction, junction.c.genre_id == TMDBGenre.id)
        .outerjoin(
            stream_table,
            and_(
                stream_table.id == stream_fk_col,
                stream_table.provider_id == provider_id,
            ),
        )
        .group_by(TMDBGenre.id)
        .having(func.count(stream_table.id) > 0)
        .order_by(TMDBGenre.name)
        .all()
    )
    return [
        GenreCountOut(
            id=r.id,
            tmdb_genre_id=r.tmdb_genre_id,
            name=r.name,
            count=int(r.count or 0),
        )
        for r in rows
    ]


@router.get("/genres/movies", response_model=List[GenreCountOut])
def list_movie_genres(
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _genre_counts_for(db, user.provider_id, kind="movies")


@router.get("/genres/series", response_model=List[GenreCountOut])
def list_series_genres(
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _genre_counts_for(db, user.provider_id, kind="series")


# ---------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------

def _build_live_tree(rows: List[LiveCategory]) -> List[LiveCategoryNode]:
    by_id: dict[int, LiveCategoryNode] = {}
    for r in rows:
        by_id[r.id] = LiveCategoryNode(
            id=r.id, name=r.category_name, category_id=r.category_id, children=[],
        )
    roots: List[LiveCategoryNode] = []
    for r in rows:
        node = by_id[r.id]
        if r.parent_id and r.parent_id in by_id:
            by_id[r.parent_id].children.append(node)
        else:
            roots.append(node)
    return roots


@router.get("/categories/live", response_model=List[LiveCategoryNode])
def list_live_categories(
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(LiveCategory)
        .filter(LiveCategory.provider_id == user.provider_id)
        .order_by(LiveCategory.parent_id.asc(), LiveCategory.category_name.asc())
        .all()
    )
    return _build_live_tree(rows)


@router.get("/categories/movies", response_model=List[FlatCategory])
def list_movie_categories(
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(MovieCategory)
        .filter(MovieCategory.provider_id == user.provider_id)
        .order_by(MovieCategory.category_name.asc())
        .all()
    )
    return [
        FlatCategory(id=r.id, category_id=r.category_id, name=r.category_name, language=r.language)
        for r in rows
    ]


@router.get("/categories/series", response_model=List[FlatCategory])
def list_serie_categories(
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(SerieCategory)
        .filter(SerieCategory.provider_id == user.provider_id)
        .order_by(SerieCategory.category_name.asc())
        .all()
    )
    return [
        FlatCategory(id=r.id, category_id=r.category_id, name=r.category_name, language=r.language)
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Listings
# ---------------------------------------------------------------------------

@router.get("/live")
def list_live_streams(
    category_id: Optional[str] = Query(
        None,
        description="LiveCategory.id (FK). Accepts single int or comma-separated list (e.g. 1,2,3).",
    ),
    page: int = Query(1, ge=1),
    per_page: int = Query(DEFAULT_PER_PAGE, ge=1, le=MAX_PER_PAGE),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = db.query(LiveStream).filter(LiveStream.provider_id == user.provider_id)
    cat_ids = _parse_id_list(category_id)
    if cat_ids:
        if len(cat_ids) == 1:
            q = q.filter(LiveStream.live_category_id == cat_ids[0])
        else:
            q = q.filter(LiveStream.live_category_id.in_(cat_ids))
    q = q.order_by(LiveStream.xtream_live_id.asc(), LiveStream.id.asc())
    items, total = _paginate(q, page, per_page)
    return _page([_live_to_item(x) for x in items], total, page, per_page)


# ---------------------------------------------------------------------------
# Live EPG passthrough
# ---------------------------------------------------------------------------
#
# Frontend asks for short EPG per channel (4 entries) when a row gains focus
# and pre-fetches the prev/current/next neighbours. Rather than syncing EPG
# into our DB on a schedule, we proxy the provider's get_short_epg call on
# the fly using the user's own Xtream creds.
#
# To keep adjacent hovers from hammering the provider, we keep a small
# in-process TTL cache keyed by (provider_id, stream_id, limit). Bounded so
# the dict can't grow without bound.

_EPG_CACHE_TTL_SEC = 300  # 5 minutes — short enough that "now playing"
                          # stays accurate-ish but long enough to absorb
                          # rapid focus changes
_EPG_CACHE_MAX_ENTRIES = 4096

# Keyed by (user_id, stream_id, limit). User-scoped because provider
# responses depend on per-account state (expired accounts return
# user_info instead of EPG, etc.) — sharing a cache across users would
# leak one user's degraded response to others.
_epg_cache: Dict[Tuple[int, int, int], Tuple[float, List[Dict[str, Any]]]] = {}
_epg_cache_lock = threading.Lock()


def _epg_cache_get(key: Tuple[int, int, int]) -> Optional[List[Dict[str, Any]]]:
    now = time.time()
    with _epg_cache_lock:
        entry = _epg_cache.get(key)
        if entry is None:
            return None
        expires_at, payload = entry
        if expires_at <= now:
            _epg_cache.pop(key, None)
            return None
        return payload


def _epg_cache_put(key: Tuple[int, int, int], listings: List[Dict[str, Any]]) -> None:
    # Skip caching empty results: a blank response usually signals a
    # transient provider failure (expired account, rate-limit, network
    # blip) — not a stable "this channel truly has no EPG". Re-fetching
    # next time is cheap and avoids sticky bad state.
    if not listings:
        return
    expires_at = time.time() + _EPG_CACHE_TTL_SEC
    with _epg_cache_lock:
        if len(_epg_cache) >= _EPG_CACHE_MAX_ENTRIES:
            # Evict the oldest by expiry; cheapest correct policy without
            # pulling in a real LRU.
            oldest = min(_epg_cache.items(), key=lambda kv: kv[1][0], default=None)
            if oldest is not None:
                _epg_cache.pop(oldest[0], None)
        _epg_cache[key] = (expires_at, listings)


@router.get("/live/{live_id}/epg")
def get_live_epg(
    live_id: int,
    limit: int = Query(4, ge=1, le=20),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Short EPG for a live channel. Pass-through to the provider's
    get_short_epg endpoint with a 5-minute in-process cache so the
    frontend can pre-fetch neighbours without rate-limiting the
    provider.
    """
    live = db.get(LiveStream, live_id)
    if live is None or live.provider_id != user.provider_id:
        raise HTTPException(status_code=404, detail="live stream not found")

    cache_key = (user.id, live.stream_id, limit)
    cached = _epg_cache_get(cache_key)
    if cached is not None:
        return {"epg_listings": cached, "cached": True}

    # Build the upstream client from a donor when the requester's own
    # provider creds are dead (subscription_enforced=True past
    # provider_exp_date) — same swap rule as preview/play. EPG won't work
    # against dead creds because the upstream returns user_info instead
    # of epg_listings.
    cred_owner = pick_url_owner(db, user)
    if cred_owner is None:
        raise HTTPException(status_code=503, detail="no donor available for EPG")
    if cred_owner.id != user.id:
        logger.info("epg: requester=%s(id=%d) -> donor=%s(id=%d) live=%d",
                    user.username, user.id, cred_owner.username, cred_owner.id, live.stream_id)
    client = XtreamClient(cred_owner.base_url, cred_owner.username, cred_owner.password)
    payload = client.get_short_epg(stream_id=live.stream_id, limit=limit)
    listings: List[Dict[str, Any]] = []
    if isinstance(payload, dict):
        raw = payload.get("epg_listings")
        if isinstance(raw, list):
            listings = raw[:limit]
    elif isinstance(payload, list):
        listings = payload[:limit]

    _epg_cache_put(cache_key, listings)
    return {"epg_listings": listings, "cached": False}


@router.get("/movies")
def list_movies(
    category_id: Optional[str] = Query(
        None,
        description="MovieCategory.id (FK). Accepts single int or comma-separated list (e.g. 1,2,3).",
    ),
    language: Optional[str] = Query(None, max_length=10),
    genre_id: Optional[int] = Query(None, description="TMDBGenre.id"),
    sort: Literal["added_desc", "added_asc", "year_desc", "year_asc", "rating_desc", "name_asc", "popularity_desc"] = "added_desc",
    page: int = Query(1, ge=1),
    per_page: int = Query(DEFAULT_PER_PAGE, ge=1, le=MAX_PER_PAGE),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = (
        db.query(MovieStream)
        .options(selectinload(MovieStream.genres))
        .filter(MovieStream.provider_id == user.provider_id)
    )
    cat_ids = _parse_id_list(category_id)
    if cat_ids:
        if len(cat_ids) == 1:
            q = q.filter(MovieStream.movie_category_id == cat_ids[0])
        else:
            q = q.filter(MovieStream.movie_category_id.in_(cat_ids))
    if language:
        q = q.filter(MovieStream.language == language.upper())
    if genre_id is not None:
        q = (
            q.join(movie_stream_genre_association,
                   movie_stream_genre_association.c.movie_stream_id == MovieStream.id)
             .filter(movie_stream_genre_association.c.genre_id == genre_id)
        )
    q = q.order_by(_MOVIE_SORT[sort])
    items, total = _paginate(q, page, per_page)
    return _page([_movie_to_list_item(x) for x in items], total, page, per_page)


@router.get("/series")
def list_series(
    category_id: Optional[str] = Query(
        None,
        description="SerieCategory.id (FK). Accepts single int or comma-separated list (e.g. 1,2,3).",
    ),
    language: Optional[str] = Query(None, max_length=10),
    genre_id: Optional[int] = Query(None, description="TMDBGenre.id"),
    sort: Literal["last_modified_desc", "name_asc", "popularity_desc", "rating_desc"] = "last_modified_desc",
    page: int = Query(1, ge=1),
    per_page: int = Query(DEFAULT_PER_PAGE, ge=1, le=MAX_PER_PAGE),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = (
        db.query(SeriesStream)
        .options(selectinload(SeriesStream.genres))
        .filter(SeriesStream.provider_id == user.provider_id)
    )
    cat_ids = _parse_id_list(category_id)
    if cat_ids:
        if len(cat_ids) == 1:
            q = q.filter(SeriesStream.series_category_id == cat_ids[0])
        else:
            q = q.filter(SeriesStream.series_category_id.in_(cat_ids))
    if language:
        q = q.filter(SeriesStream.language == language.upper())
    if genre_id is not None:
        q = (
            q.join(series_stream_genre_association,
                   series_stream_genre_association.c.series_stream_id == SeriesStream.id)
             .filter(series_stream_genre_association.c.genre_id == genre_id)
        )
    q = q.order_by(_SERIES_SORT[sort])
    items, total = _paginate(q, page, per_page)
    return _page([_series_to_list_item(x) for x in items], total, page, per_page)


# ---------------------------------------------------------------------------
# Details
# ---------------------------------------------------------------------------

@router.get("/movies/{movie_id}", response_model=MovieDetail)
def get_movie(
    movie_id: int,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    m = (
        db.query(MovieStream)
        .options(selectinload(MovieStream.genres))
        .filter(MovieStream.id == movie_id)
        .filter(MovieStream.provider_id == user.provider_id)
        .one_or_none()
    )
    if m is None:
        raise HTTPException(status_code=404, detail="movie not found")
    base = _movie_to_list_item(m)
    return MovieDetail(
        **base.model_dump(),
        o_name=m.o_name, description=m.description, actors=m.actors,
        director=m.director, country=m.country, age_rating=m.age_rating,
        bitrate=m.bitrate, status=m.status, youtube_trailer=m.youtube_trailer,
        releasedate=m.releasedate, duration=m.duration,
        video_codec=m.video_codec, video_width=m.video_width, video_height=m.video_height,
        audio_codec=m.audio_codec, audio_channels=m.audio_channels,
        audio_channel_layout=m.audio_channel_layout,
        container_extension=m.container_extension,
        category_id=m.category_id, movie_category_id=m.movie_category_id,
    )


@router.get("/series/{series_id}", response_model=SeriesDetail)
def get_series(
    series_id: int,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    s = (
        db.query(SeriesStream)
        .options(selectinload(SeriesStream.genres), selectinload(SeriesStream.seasons))
        .filter(SeriesStream.id == series_id)
        .filter(SeriesStream.provider_id == user.provider_id)
        .one_or_none()
    )
    if s is None:
        raise HTTPException(status_code=404, detail="series not found")
    base = _series_to_list_item(s)
    seasons = sorted(s.seasons, key=lambda x: x.season_number)
    return SeriesDetail(
        **base.model_dump(),
        o_name=s.o_name, plot=s.plot, cast=s.cast, director=s.director,
        youtube_trailer=s.youtube_trailer, episode_run_time=s.episode_run_time,
        category_id=s.category_id, series_category_id=s.series_category_id,
        seasons=[
            SeasonOut(
                id=se.id, season_number=se.season_number, name=se.name,
                overview=se.overview, air_date=se.air_date,
                episode_count=se.episode_count, cover=se.cover, cover_big=se.cover_big,
            )
            for se in seasons
        ],
    )


@router.get("/series/{series_id}/seasons/{season_number}/episodes", response_model=List[EpisodeOut])
def get_episodes(
    series_id: int,
    season_number: int,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    series = (
        db.query(SeriesStream.id)
        .filter(SeriesStream.id == series_id)
        .filter(SeriesStream.provider_id == user.provider_id)
        .one_or_none()
    )
    if series is None:
        raise HTTPException(status_code=404, detail="series not found")
    rows = (
        db.query(SeriesEpisode)
        .filter(SeriesEpisode.series_id == series_id)
        .filter(SeriesEpisode.season_number == season_number)
        .order_by(SeriesEpisode.episode_num.asc())
        .all()
    )
    return [
        EpisodeOut(
            id=ep.id, season_number=ep.season_number, episode_num=ep.episode_num,
            title=ep.title, plot=ep.plot, movie_image=ep.movie_image,
            duration_secs=ep.duration_secs, rating=ep.rating,
            release_date=ep.release_date, container_extension=ep.container_extension,
            tmdb_id=ep.tmdb_id, audio_language=ep.audio_language,
            video_codec=ep.video_codec, video_width=ep.video_width, video_height=ep.video_height,
            audio_codec=ep.audio_codec, audio_channels=ep.audio_channels,
            audio_channel_layout=ep.audio_channel_layout,
            frame_rate=ep.frame_rate, aspect_ratio=ep.aspect_ratio,
            bitrate=ep.bitrate, crew=ep.crew,
        )
        for ep in rows
    ]


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

@router.get("/search")
def search(
    q: str = Query(..., min_length=2, max_length=100),
    type: Literal["movies", "series", "live"] = Query("movies"),
    page: int = Query(1, ge=1),
    per_page: int = Query(DEFAULT_PER_PAGE, ge=1, le=MAX_PER_PAGE),
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pattern = f"%{q.strip()}%"
    if type == "movies":
        query = (
            db.query(MovieStream)
            .options(selectinload(MovieStream.genres))
            .filter(MovieStream.provider_id == user.provider_id)
            .filter(or_(
                MovieStream.name.ilike(pattern),
                MovieStream.o_name.ilike(pattern),
                MovieStream.raw_name.ilike(pattern),
            ))
            .order_by(_MOVIE_SORT["popularity_desc"])
        )
        items, total = _paginate(query, page, per_page)
        return _page([_movie_to_list_item(x) for x in items], total, page, per_page)
    if type == "series":
        query = (
            db.query(SeriesStream)
            .options(selectinload(SeriesStream.genres))
            .filter(SeriesStream.provider_id == user.provider_id)
            .filter(or_(
                SeriesStream.name.ilike(pattern),
                SeriesStream.o_name.ilike(pattern),
                SeriesStream.raw_name.ilike(pattern),
            ))
            .order_by(_SERIES_SORT["popularity_desc"])
        )
        items, total = _paginate(query, page, per_page)
        return _page([_series_to_list_item(x) for x in items], total, page, per_page)
    # live
    query = (
        db.query(LiveStream)
        .filter(LiveStream.provider_id == user.provider_id)
        .filter(or_(
            LiveStream.name.ilike(pattern),
            LiveStream.raw_name.ilike(pattern),
        ))
        .order_by(LiveStream.name.asc())
    )
    items, total = _paginate(query, page, per_page)
    return _page([_live_to_item(x) for x in items], total, page, per_page)
