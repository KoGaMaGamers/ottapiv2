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
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import insert, select
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
        if not payload:
            return False
        _apply_movie_payload(movie, payload, genre_id_index, db)
        return True

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
        if not payload:
            return False
        _apply_series_payload(series, payload, genre_id_index, db)
        return True

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

def run_tmdb_enrichment(provider_id: int) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "provider_id": provider_id,
        "movies_enriched": 0,
        "movies_failed": 0,
        "series_enriched": 0,
        "series_failed": 0,
        "skipped_no_tmdb_token": False,
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

        movies = (
            db.query(MovieStream)
            .filter(MovieStream.provider_id == provider_id)
            .filter(MovieStream.tmdb_synced_at.is_(None))
            .order_by(MovieStream.id)
            .all()
        )
        logger.info("TMDB: %d movies to enrich for provider id=%s", len(movies), provider_id)
        pending = 0
        for idx, m in enumerate(movies):
            if idx > 0 and idx % 500 == 0:
                logger.info(
                    "TMDB movies: %d/%d  enriched=%d failed=%d",
                    idx, len(movies),
                    summary["movies_enriched"], summary["movies_failed"],
                )
            try:
                ok = _enrich_one_movie(db, client, m, genre_id_index)
            except Exception as exc:
                logger.warning("TMDB movie %s failed: %s", m.id, exc)
                summary["movies_failed"] += 1
                db.rollback()
                continue
            if ok:
                summary["movies_enriched"] += 1
                m.tmdb_synced_at = datetime.utcnow()
                pending += 1
                if pending >= 100:
                    db.commit()
                    pending = 0
            else:
                # Don't set the watermark on miss — leave NULL so a future run
                # can retry once data improves (e.g., upstream populates a tmdb_id,
                # name parsing improves, TMDB adds the title).
                summary["movies_failed"] += 1
        if pending:
            db.commit()

        seriess = (
            db.query(SeriesStream)
            .filter(SeriesStream.provider_id == provider_id)
            .filter(SeriesStream.tmdb_synced_at.is_(None))
            .order_by(SeriesStream.id)
            .all()
        )
        logger.info("TMDB: %d series to enrich for provider id=%s", len(seriess), provider_id)
        pending = 0
        for idx, s in enumerate(seriess):
            if idx > 0 and idx % 500 == 0:
                logger.info(
                    "TMDB series: %d/%d  enriched=%d failed=%d",
                    idx, len(seriess),
                    summary["series_enriched"], summary["series_failed"],
                )
            try:
                ok = _enrich_one_series(db, client, s, genre_id_index)
            except Exception as exc:
                logger.warning("TMDB series %s failed: %s", s.id, exc)
                summary["series_failed"] += 1
                db.rollback()
                continue
            if ok:
                summary["series_enriched"] += 1
                s.tmdb_synced_at = datetime.utcnow()
                pending += 1
                if pending >= 100:
                    db.commit()
                    pending = 0
            else:
                summary["series_failed"] += 1
        if pending:
            db.commit()

    except Exception as exc:
        logger.exception("TMDB enrichment failed for provider id=%s", provider_id)
        summary["errors"].append(f"unhandled: {exc}")
        db.rollback()
    finally:
        db.close()

    logger.info("TMDB enrichment done: %s", {k: v for k, v in summary.items() if k != "errors"})
    return summary


def trigger_tmdb_enrichment(provider_id: int) -> bool:
    threading.Thread(
        target=run_tmdb_enrichment,
        args=(provider_id,),
        name=f"tmdb-enrich-{provider_id}",
        daemon=True,
    ).start()
    return True
