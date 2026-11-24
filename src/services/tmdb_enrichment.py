"""TMDB enrichment for movies and series.

For each MovieStream / SeriesStream where ``tmdb_synced_at`` is NULL:
  - if ``tmdb_id`` is set: fetch /movie/{id} or /tv/{id} → genres,
    vote_average, popularity, original_language
  - if ``tmdb_id`` is NULL: search by name+year, pick best match,
    take genre_ids + the same fields from the search result (no
    second API call needed)

Watermark: ``tmdb_synced_at`` set on success. Re-runs are no-op once
all rows are synced.

Genre links use upsert semantics on the (movie|series)_stream_genres
junction tables — INSERT OR IGNORE on the composite PK so existing
links from legacy enrichment are preserved.
"""

import logging
import re
import threading
import unicodedata
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import and_, insert, or_, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models import (
    MovieStream,
    SeriesStream,
    TMDBGenre,
    XtreamProvider,
    movie_stream_genre_association,
    series_stream_genre_association,
)
from .adult import adult_movie_category_ids, adult_serie_category_ids, apply_adult_filter
from .job_locks import exclusive, is_running
from .sync_runs import tracked
from .tmdb_client import TMDBClient, TMDBNotConfigured

logger = logging.getLogger(__name__)


_BRACKET_RE = re.compile(r"\s*\[.*?\]\s*")
_PAREN_RE = re.compile(r"\s*\(.*?\)\s*")
_QUALITY_TAG_RE = re.compile(
    r"\b(?:FHD|UHD|HD|SD|2K|4K|8K|HDR(?:10)?|DV|"
    r"MULTI(?:-?SUB|-?LANG|-?AUDIO)?|VOSTFR|VOST|VF|VO)\b",
    re.IGNORECASE,
)
_TRAILING_YEAR_RE = re.compile(r"\s*-?\s*\b(19|20)\d{2}\b\s*$")
_WHITESPACE_RE = re.compile(r"\s+")


def _clean_search_name(name: str) -> str:
    """Strip quality tags + brackets + parens + trailing year so TMDB
    search gets a clean canonical title.

    Examples:
      "El Chapo (MULTI) FHD"           -> "El Chapo"
      "Spider-Man [VOSTFR] - 2019"     -> "Spider-Man"
      "FR - Half Man (MULTI-SUB) 4K"   -> "FR - Half Man"
    """
    cleaned = _BRACKET_RE.sub(" ", name or "")
    cleaned = _PAREN_RE.sub(" ", cleaned)
    cleaned = _QUALITY_TAG_RE.sub(" ", cleaned)
    cleaned = _TRAILING_YEAR_RE.sub("", cleaned)
    cleaned = _WHITESPACE_RE.sub(" ", cleaned).strip(" -|:")
    return cleaned


def _normalise(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    return text


def _name_similarity(a: str, b: str) -> float:
    sa, sb = set(_normalise(a).split()), set(_normalise(b).split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / max(len(sa), len(sb))


def _pick_best_match(
    results: List[Dict[str, Any]],
    name: str,
    year: Optional[int],
    title_keys: Tuple[str, str],
    year_key: str,
) -> Optional[Dict[str, Any]]:
    best: Optional[Dict[str, Any]] = None
    best_score = 0.0
    for r in results or []:
        candidate = r.get(title_keys[0]) or r.get(title_keys[1]) or ""
        candidate_year: Optional[int] = None
        date = r.get(year_key)
        if date:
            try:
                candidate_year = int(str(date)[:4])
            except (TypeError, ValueError):
                pass
        sim = _name_similarity(candidate, name)
        bonus = 0.0
        if year and candidate_year:
            diff = abs(year - candidate_year)
            if diff == 0:
                bonus = 0.2
            elif diff == 1:
                bonus = 0.05
        score = sim + bonus
        if score > best_score:
            best_score = score
            best = r
    return best if best_score >= 0.5 else None


def _ensure_genre_id_index(db: Session) -> Dict[int, int]:
    """Returns {tmdb_genre_id: TMDBGenre.id}. One DB hit per enrichment run."""
    rows = db.query(TMDBGenre.id, TMDBGenre.tmdb_genre_id).filter(TMDBGenre.tmdb_genre_id.isnot(None)).all()
    return {tmdb_id: pk for pk, tmdb_id in rows if tmdb_id is not None}


def _seed_genres_if_missing(db: Session, client: TMDBClient) -> None:
    """Top up tmdb_genres with any official genres we don't have yet."""
    existing = {row.tmdb_genre_id for row in db.query(TMDBGenre.tmdb_genre_id).all() if row.tmdb_genre_id}
    incoming: List[Tuple[int, str]] = []
    for fetcher in (client.get_movie_genre_list, client.get_tv_genre_list):
        body = fetcher() or {}
        for g in body.get("genres") or []:
            gid = g.get("id")
            name = g.get("name")
            if isinstance(gid, int) and isinstance(name, str) and gid not in existing:
                incoming.append((gid, name))
                existing.add(gid)
    if incoming:
        for gid, name in incoming:
            db.add(TMDBGenre(tmdb_genre_id=gid, name=name))
        db.flush()
        logger.info("seeded %d new TMDB genres", len(incoming))


def _link_genres(
    db: Session,
    *,
    junction,
    fk_column: str,
    fk_value: int,
    tmdb_genre_ids: Iterable[int],
    genre_id_index: Dict[int, int],
) -> None:
    rows = []
    for gid in tmdb_genre_ids or []:
        local_id = genre_id_index.get(int(gid)) if gid is not None else None
        if local_id is not None:
            rows.append({fk_column: fk_value, "genre_id": local_id})
    if not rows:
        return
    stmt = mysql_insert(junction).values(rows).prefix_with("IGNORE")
    db.execute(stmt)


# ---------------------------------------------------------------------------
# Movies
# ---------------------------------------------------------------------------

def _apply_movie_payload(
    movie: MovieStream,
    payload: Dict[str, Any],
    genre_id_index: Dict[int, int],
    db: Session,
) -> None:
    if movie.tmdb_id is None and isinstance(payload.get("id"), int):
        movie.tmdb_id = int(payload["id"])

    if not movie.o_language:
        ol = payload.get("original_language")
        if isinstance(ol, str) and ol:
            movie.o_language = ol[:10]

    va = payload.get("vote_average")
    if isinstance(va, (int, float)) and movie.tmdb_vote_average is None:
        movie.tmdb_vote_average = float(va)

    pop = payload.get("popularity")
    if isinstance(pop, (int, float)) and movie.tmdb_popularity is None:
        movie.tmdb_popularity = float(pop)

    raw_genre_ids: List[int] = []
    if isinstance(payload.get("genres"), list):
        raw_genre_ids = [g.get("id") for g in payload["genres"] if isinstance(g, dict) and isinstance(g.get("id"), int)]
    elif isinstance(payload.get("genre_ids"), list):
        raw_genre_ids = [g for g in payload["genre_ids"] if isinstance(g, int)]

    _link_genres(
        db,
        junction=movie_stream_genre_association,
        fk_column="movie_stream_id",
        fk_value=movie.id,
        tmdb_genre_ids=raw_genre_ids,
        genre_id_index=genre_id_index,
    )


def _enrich_one_movie(
    db: Session, client: TMDBClient, movie: MovieStream, genre_id_index: Dict[int, int]
) -> bool:
    if movie.tmdb_id:
        payload = client.get_movie_details(movie.tmdb_id)
        if payload:
            _apply_movie_payload(movie, payload, genre_id_index, db)
            return True
        if client.last_failure_transient:
            return False
        # 404: the stored id (from the provider / legacy import) doesn't
        # exist on TMDB. Drop it and fall back to a name search.
        logger.info("TMDB movie id=%s for stream %s is stale; searching by name",
                    movie.tmdb_id, movie.id)
        movie.tmdb_id = None

    name = _clean_search_name(movie.name)
    if not name:
        return False
    year = movie.year
    body = client.search_movie(name, year=year) or {}
    results = body.get("results") or []
    if not results and year:
        body = client.search_movie(name) or {}
        results = body.get("results") or []
    best = _pick_best_match(results, name, year, ("title", "original_title"), "release_date")
    if not best:
        return False
    _apply_movie_payload(movie, best, genre_id_index, db)
    return True


# ---------------------------------------------------------------------------
# Series
# ---------------------------------------------------------------------------

def _apply_series_payload(
    series: SeriesStream,
    payload: Dict[str, Any],
    genre_id_index: Dict[int, int],
    db: Session,
) -> None:
    if series.tmdb_id is None and isinstance(payload.get("id"), int):
        series.tmdb_id = int(payload["id"])

    if not series.o_language:
        ol = payload.get("original_language")
        if isinstance(ol, str) and ol:
            series.o_language = ol[:10]

    va = payload.get("vote_average")
    if isinstance(va, (int, float)) and series.tmdb_vote_average is None:
        series.tmdb_vote_average = float(va)

    pop = payload.get("popularity")
    if isinstance(pop, (int, float)) and series.tmdb_popularity is None:
        series.tmdb_popularity = float(pop)

    raw_genre_ids: List[int] = []
    if isinstance(payload.get("genres"), list):
        raw_genre_ids = [g.get("id") for g in payload["genres"] if isinstance(g, dict) and isinstance(g.get("id"), int)]
    elif isinstance(payload.get("genre_ids"), list):
        raw_genre_ids = [g for g in payload["genre_ids"] if isinstance(g, int)]

    _link_genres(
        db,
        junction=series_stream_genre_association,
        fk_column="series_stream_id",
        fk_value=series.id,
        tmdb_genre_ids=raw_genre_ids,
        genre_id_index=genre_id_index,
    )


def _enrich_one_series(
    db: Session, client: TMDBClient, series: SeriesStream, genre_id_index: Dict[int, int]
) -> bool:
    if series.tmdb_id:
        payload = client.get_tv_details(series.tmdb_id)
        if payload:
            _apply_series_payload(series, payload, genre_id_index, db)
            return True
        if client.last_failure_transient:
            return False
        logger.info("TMDB tv id=%s for series %s is stale; searching by name",
                    series.tmdb_id, series.id)
        series.tmdb_id = None

    name = _clean_search_name(series.name)
    if not name:
        return False
    year: Optional[int] = None
    if series.release_date:
        try:
            year = series.release_date.year
        except AttributeError:
            year = None
    body = client.search_tv(name, year=year) or {}
    results = body.get("results") or []
    if not results and year:
        body = client.search_tv(name) or {}
        results = body.get("results") or []
    best = _pick_best_match(results, name, year, ("name", "original_name"), "first_air_date")
    if not best:
        return False
    _apply_series_payload(series, best, genre_id_index, db)
    return True


# ---------------------------------------------------------------------------
# Top-level entry
# ---------------------------------------------------------------------------

# Retry schedule for titles TMDB couldn't match: after the Nth miss, wait
# _RETRY_AFTER[N] before trying again (last value repeats).
_RETRY_AFTER = [timedelta(days=1), timedelta(days=7), timedelta(days=30), timedelta(days=90)]


def _due_for_attempt(model, now: datetime):
    """SQL filter: never tried, or the backoff for its miss count elapsed."""
    conds = [model.tmdb_attempts == 0, model.tmdb_last_attempt_at.is_(None)]
    for n, wait in enumerate(_RETRY_AFTER, start=1):
        cmp = model.tmdb_attempts == n if n < len(_RETRY_AFTER) else model.tmdb_attempts >= n
        conds.append(and_(cmp, model.tmdb_last_attempt_at < now - wait))
    return or_(*conds)


def _enrich_batch(db, client, model, ids, enrich, genre_id_index, kind, summary) -> None:
    """Enrich rows one by one. Each row runs in a SAVEPOINT so a failure
    rolls back only that row (previously one exception discarded up to 99
    already-enriched rows). Commits every 100 rows; rows are fetched in
    chunks so the session never holds the whole table."""
    done = failed = 0
    for chunk_start in range(0, len(ids), 200):
        chunk = ids[chunk_start:chunk_start + 200]
        rows = db.query(model).filter(model.id.in_(chunk)).order_by(model.id).all()
        for row in rows:
            if client.circuit_open:
                return
            try:
                with db.begin_nested():
                    ok = enrich(db, client, row, genre_id_index)
                    now = datetime.utcnow()
                    if ok:
                        row.tmdb_synced_at = now
                        row.tmdb_attempts = 0
                    elif not client.last_failure_transient:
                        # genuine miss -> back off (transient errors don't count)
                        row.tmdb_attempts = int(row.tmdb_attempts or 0) + 1
                        row.tmdb_last_attempt_at = now
            except Exception as exc:
                logger.warning("TMDB %s %s failed: %s", kind, row.id, exc)
                ok = False
            if ok:
                done += 1
                summary[f"{kind}_enriched"] += 1
            else:
                failed += 1
                summary[f"{kind}_failed"] += 1
        db.commit()
        db.expunge_all()
        if chunk_start and chunk_start % 2000 == 0:
            logger.info("TMDB %s: %d/%d  enriched=%d failed=%d",
                        kind, chunk_start, len(ids), done, failed)


@tracked("tmdb")
@exclusive("enrich")
def run_tmdb_enrichment(provider_id: int) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "provider_id": provider_id,
        "movies_enriched": 0,
        "movies_failed": 0,
        "series_enriched": 0,
        "series_failed": 0,
        "skipped_no_tmdb_token": False,
        "circuit_open": False,
        "errors": [],
    }
    try:
        client = TMDBClient()
    except TMDBNotConfigured:
        summary["skipped_no_tmdb_token"] = True
        logger.warning("TMDB enrichment skipped: no TMDB_BEARER_TOKEN/TMDB_API_KEY set")
        return summary

    db: Session = SessionLocal()
    try:
        provider = db.get(XtreamProvider, provider_id)
        if provider is None:
            summary["errors"].append(f"provider id={provider_id} not found")
            return summary

        _seed_genres_if_missing(db, client)
        db.commit()
        genre_id_index = _ensure_genre_id_index(db)

        adult_movies = adult_movie_category_ids(db, provider_id)
        adult_series = adult_serie_category_ids(db, provider_id)
        now = datetime.utcnow()

        for kind, model, cat_col, adult_ids, enrich in (
            ("movies", MovieStream, MovieStream.movie_category_id, adult_movies, _enrich_one_movie),
            ("series", SeriesStream, SeriesStream.series_category_id, adult_series, _enrich_one_series),
        ):
            ids = [
                r.id for r in apply_adult_filter(
                    db.query(model.id)
                    .filter(model.provider_id == provider_id)
                    .filter(model.tmdb_synced_at.is_(None))
                    .filter(_due_for_attempt(model, now)),
                    cat_col, adult_ids, False,
                ).order_by(model.id)
            ]
            logger.info("TMDB: %d %s due for enrichment for provider id=%s",
                        len(ids), kind, provider_id)
            _enrich_batch(db, client, model, ids, enrich, genre_id_index, kind, summary)
            if client.circuit_open:
                summary["circuit_open"] = True
                break

    except Exception as exc:
        logger.exception("TMDB enrichment failed for provider id=%s", provider_id)
        summary["errors"].append(f"unhandled: {exc}")
        db.rollback()
    finally:
        db.close()

    logger.info("TMDB enrichment done: %s", {k: v for k, v in summary.items() if k != "errors"})
    return summary


def trigger_tmdb_enrichment(provider_id: int) -> bool:
    if is_running("enrich", provider_id):
        return False
    threading.Thread(
        target=run_tmdb_enrichment,
        args=(provider_id,),
        name=f"tmdb-enrich-{provider_id}",
        daemon=True,
    ).start()
    return True
