"""Personalised "You should like…" recommendations.

Pure-derivation endpoint: takes a list of seed items the user has
finished (≥90% watched), pulls TMDB /similar for each seed, intersects
the returned tmdb_ids with our local catalog, and scores each candidate
on two signals:

  - TMDB-similar hit       : 2 points per seed it appeared as similar to
  - Genre overlap          : 1 point per seed it shares ≥1 genre with

Candidates are scoped to the user's provider, deduped across movies +
series, sorted by score desc + tmdb_popularity desc, capped at the
caller's limit (default 20).

Seeds carry their own tmdb_id so the client doesn't need a round-trip
to look it up — the playback/history store records it at the time of
completion.

Why this isn't a full recommender service
-----------------------------------------
Building user-vector cosine-similarity and the like makes sense once we
have hundreds of users and a feedback loop. For now the goal is just
"if I just watched five samurai movies, the home page should hint at
the sixth one", which the simple TMDB-similar overlap covers cleanly.
The endpoint is a single POST so the server holds no state — the seed
list lives entirely on the client.
"""

import logging
from typing import Iterable, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import IPTVUser, MovieStream, SeriesStream
from ..services.tmdb_client import TMDBClient, TMDBNotConfigured
from .auth import get_current_user
from .catalog import (
    MovieListItem,
    SeriesListItem,
    _movie_to_list_item,
    _series_to_list_item,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["recommendations"])


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

#: Per-seed TMDB results we consider. TMDB returns 20 items per page;
#: we don't paginate.
_TMDB_SIMILAR_KEEP = 20
#: Cap on seeds the client may submit. Keeps TMDB fan-out bounded.
_MAX_SEEDS = 8
#: Default and max items returned to the client.
_DEFAULT_LIMIT = 20
_MAX_LIMIT = 50
_TMDB_HIT_POINTS = 2
_GENRE_OVERLAP_POINTS = 1


# ---------------------------------------------------------------------------
# Request / response shapes
# ---------------------------------------------------------------------------

class RecommendationSeed(BaseModel):
    """One completed item the user finished (≥90%).

    Either ``tmdb_id`` or ``genres`` (or both) should be present —
    seeds with neither contribute nothing and are dropped server-side.
    """
    type: str = Field(..., description="movie | series")
    tmdb_id: Optional[int] = None
    genres: List[str] = []


class RecommendationsRequest(BaseModel):
    seeds: List[RecommendationSeed] = []
    limit: Optional[int] = None
    #: Local catalog ids the client wants suppressed (already in
    #: watchlist, currently in continue-watching, or recently dismissed).
    exclude_movie_ids: List[int] = []
    exclude_series_ids: List[int] = []
    #: User content prefs (Profile → Preferences). Same semantics the
    #: Home rails use:
    #:   None  — no category restriction (recommend across the whole pool)
    #:   []    — user has deselected every category for this kind, skip
    #:           the pool entirely
    #:   [...] — restrict candidates to these category ids
    movie_category_ids: Optional[List[int]] = None
    series_category_ids: Optional[List[int]] = None


class RecommendationsResponse(BaseModel):
    movies: List[MovieListItem] = []
    series: List[SeriesListItem] = []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_seeds(seeds: Iterable[RecommendationSeed]) -> List[RecommendationSeed]:
    cleaned: List[RecommendationSeed] = []
    seen_keys = set()
    for s in seeds:
        t = (s.type or "").lower()
        if t not in ("movie", "series"):
            continue
        if not s.tmdb_id and not s.genres:
            continue
        # Dedupe on (type, tmdb_id) — same seed in twice (e.g., user
        # rewatched a finished movie) shouldn't double-weight similar.
        key = (t, s.tmdb_id)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        cleaned.append(RecommendationSeed(type=t, tmdb_id=s.tmdb_id, genres=s.genres))
        if len(cleaned) >= _MAX_SEEDS:
            break
    return cleaned


def _collect_tmdb_similar(
    seeds: List[RecommendationSeed],
) -> tuple[set[int], set[int]]:
    """Returns (movie_tmdb_ids, series_tmdb_ids) suggested as similar.

    Per seed we query TMDB's `/recommendations` endpoint (curated /
    algorithmic — the same list TMDB's own UI shows under "More like
    this") and fall back to `/similar` (keyword-based) when
    recommendations is empty. The fallback matters because newer or
    lesser-known titles often have rich /similar but no
    /recommendations, and vice versa for popular ones; we want to
    take whichever signal exists.

    Silently degrades when TMDB isn't configured or rate-limits — the
    genre-overlap pass alone still produces reasonable recommendations.
    """
    movie_hits: set[int] = set()
    series_hits: set[int] = set()
    try:
        client = TMDBClient()
    except TMDBNotConfigured:
        logger.info("recommendations: TMDB not configured; falling back to genre-only")
        return movie_hits, series_hits

    for seed in seeds:
        if not seed.tmdb_id:
            continue
        bucket = movie_hits if seed.type == "movie" else series_hits
        try:
            if seed.type == "movie":
                payload = client.get_movie_recommendations(seed.tmdb_id)
            else:
                payload = client.get_tv_recommendations(seed.tmdb_id)
            results = (payload or {}).get("results") or []
            if not results:
                # Fallback: /similar — sparse on newer titles but
                # populated on classics where /recommendations may be
                # quiet.
                if seed.type == "movie":
                    payload = client.get_movie_similar(seed.tmdb_id)
                else:
                    payload = client.get_tv_similar(seed.tmdb_id)
                results = (payload or {}).get("results") or []
        except Exception as exc:  # pragma: no cover — defence in depth
            logger.warning("recommendations: TMDB call failed: %s", exc)
            continue
        for row in results[:_TMDB_SIMILAR_KEEP]:
            rid = row.get("id")
            if isinstance(rid, int):
                bucket.add(rid)
    return movie_hits, series_hits


def _score_candidates(
    rows,
    *,
    tmdb_hits: set[int],
    seed_genres: set[str],
    seed_tmdb_ids: set[int],
    exclude_ids: set[int],
) -> list[tuple[int, float, object]]:
    """Score+filter a stream-row iterable.

    Returns a list of (score, popularity, row) tuples for rows with
    score > 0; caller sorts and slices.
    """
    out: list[tuple[int, float, object]] = []
    for row in rows:
        if row.id in exclude_ids:
            continue
        if row.tmdb_id and row.tmdb_id in seed_tmdb_ids:
            # Don't recommend the seed back to the user.
            continue
        score = 0
        if row.tmdb_id and row.tmdb_id in tmdb_hits:
            score += _TMDB_HIT_POINTS
        if seed_genres:
            row_genres = {g.name for g in (row.genres or [])}
            if row_genres & seed_genres:
                score += _GENRE_OVERLAP_POINTS
        if score <= 0:
            continue
        out.append((score, row.tmdb_popularity or 0.0, row))
    return out


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/recommendations", response_model=RecommendationsResponse)
def get_recommendations(
    body: RecommendationsRequest,
    db: Session = Depends(get_db),
    user: IPTVUser = Depends(get_current_user),
):
    seeds = _normalize_seeds(body.seeds)
    if not seeds:
        return RecommendationsResponse()

    limit = body.limit or _DEFAULT_LIMIT
    if limit < 1:
        raise HTTPException(status_code=400, detail="limit must be >= 1")
    limit = min(limit, _MAX_LIMIT)

    movie_hits, series_hits = _collect_tmdb_similar(seeds)

    # Pool the seed signal — genres + already-seen tmdb_ids — once,
    # since we apply it to both the movie and series pass.
    seed_genres: set[str] = set()
    seed_movie_tmdb: set[int] = set()
    seed_series_tmdb: set[int] = set()
    for s in seeds:
        seed_genres.update(s.genres or [])
        if s.tmdb_id:
            (seed_movie_tmdb if s.type == "movie" else seed_series_tmdb).add(s.tmdb_id)

    # Pull candidates scoped to the user's provider. We only consider
    # rows that could possibly score: a tmdb_id in the similar set, or
    # a genre intersecting the seed pool. We can't easily express the
    # genre intersection at the SQL layer (the genres are joined via
    # an association + name string), so we widen the candidate pool to
    # "any row with tmdb_id set or with non-empty genres on the user's
    # provider" — bounded by per-row provider scoping it stays cheap
    # in practice.
    #
    # If the client passed user category prefs, narrow the pool to
    # those categories first. An empty list means "user explicitly
    # deselected every category for this kind" — skip the pool
    # outright (no recommendations of that type).
    if body.movie_category_ids is None:
        movie_rows = (
            db.query(MovieStream)
            .options(selectinload(MovieStream.genres))
            .filter(MovieStream.provider_id == user.provider_id)
            .filter(MovieStream.tmdb_id.isnot(None))
            .all()
        )
    elif not body.movie_category_ids:
        movie_rows = []
    else:
        movie_rows = (
            db.query(MovieStream)
            .options(selectinload(MovieStream.genres))
            .filter(MovieStream.provider_id == user.provider_id)
            .filter(MovieStream.tmdb_id.isnot(None))
            .filter(MovieStream.movie_category_id.in_(body.movie_category_ids))
            .all()
        )

    if body.series_category_ids is None:
        series_rows = (
            db.query(SeriesStream)
            .options(selectinload(SeriesStream.genres))
            .filter(SeriesStream.provider_id == user.provider_id)
            .filter(SeriesStream.tmdb_id.isnot(None))
            .all()
        )
    elif not body.series_category_ids:
        series_rows = []
    else:
        series_rows = (
            db.query(SeriesStream)
            .options(selectinload(SeriesStream.genres))
            .filter(SeriesStream.provider_id == user.provider_id)
            .filter(SeriesStream.tmdb_id.isnot(None))
            .filter(SeriesStream.series_category_id.in_(body.series_category_ids))
            .all()
        )

    movie_scored = _score_candidates(
        movie_rows,
        tmdb_hits=movie_hits,
        seed_genres=seed_genres,
        seed_tmdb_ids=seed_movie_tmdb,
        exclude_ids=set(body.exclude_movie_ids),
    )
    series_scored = _score_candidates(
        series_rows,
        tmdb_hits=series_hits,
        seed_genres=seed_genres,
        seed_tmdb_ids=seed_series_tmdb,
        exclude_ids=set(body.exclude_series_ids),
    )

    # Sort by score desc, popularity desc as tiebreak.
    movie_scored.sort(key=lambda t: (-t[0], -(t[1] or 0)))
    series_scored.sort(key=lambda t: (-t[0], -(t[1] or 0)))

    # Mix movies + series at the configured limit. The Home row is
    # mixed-type, so split roughly 60/40 movies/series — most providers
    # have a deeper movie catalog. Caller can re-bucket by inspecting
    # the response.
    movie_take = max(1, limit * 6 // 10)
    series_take = max(1, limit - movie_take)

    movies = [_movie_to_list_item(t[2]) for t in movie_scored[:movie_take]]
    series = [_series_to_list_item(t[2]) for t in series_scored[:series_take]]
    return RecommendationsResponse(movies=movies, series=series)
