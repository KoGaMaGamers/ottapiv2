"""Per-provider catalog sync — phase 1.

Pulls categories + top-level streams (live, vod, series) for one provider
using its ``active_master_user_id`` credentials, then upserts into our DB.

Phase 2 (per-series episodes) and phase 3 (TMDB enrichment) land in
later sub-steps.

Sync semantics
--------------
- Always full-pull from upstream — Xtream has no since-filter.
- Compare each upstream row against a small in-memory index of local rows
  for that provider; insert when missing, update only material fields
  (category linkage, ``added`` / ``last_modified`` timestamps) when they
  changed. No mass updates, no full-replace, no prune.
"""

import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models import (
    IPTVUser,
    LiveCategory,
    LiveStream,
    MovieCategory,
    MovieStream,
    SerieCategory,
    SeriesStream,
    XtreamProvider,
)
from .catalog_parser import (
    parse_live_category_segments,
    parse_live_stream_name,
    parse_movie_category_name,
    parse_movie_stream_name,
    parse_serie_category_name,
    parse_series_stream_name,
)
from .xtream_client import XtreamClient

logger = logging.getLogger(__name__)


@dataclass
class SyncSummary:
    provider_id: int
    live_categories_inserted: int = 0
    live_streams_inserted: int = 0
    live_streams_updated: int = 0
    movie_categories_inserted: int = 0
    movie_categories_updated: int = 0
    movie_streams_inserted: int = 0
    movie_streams_updated: int = 0
    serie_categories_inserted: int = 0
    serie_categories_updated: int = 0
    series_streams_inserted: int = 0
    series_streams_updated: int = 0
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _to_int(value) -> Optional[int]:
    if value in (None, "", "0"):
        return 0 if value == "0" else None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_url(value, max_len: int = 1024) -> Optional[str]:
    """For URL-like fields: drop oversized values (not truncate — invalid URLs are useless)."""
    if value is None or value == "":
        return None
    s = str(value)
    if len(s) > max_len:
        return None
    return s


def _safe_text(value, max_len: int = 512) -> Optional[str]:
    """For free-text fields: truncate. Returns None for empty/None inputs."""
    if value is None or value == "":
        return None
    s = str(value)
    return s if len(s) <= max_len else s[:max_len]


def _ts_to_dt(value) -> Optional[datetime]:
    if value in (None, "", "0"):
        return None
    try:
        return datetime.utcfromtimestamp(int(value))
    except (TypeError, ValueError):
        return None


def _date_or_none(value) -> Optional[datetime]:
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def _first_or_value(value):
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _resolve_master_credentials(
    db: Session, provider: XtreamProvider
) -> Optional[tuple[str, str]]:
    if not provider.active_master_user_id:
        return None
    user = db.get(IPTVUser, provider.active_master_user_id)
    if user is None or not user.username or not user.password:
        return None
    return user.username, user.password


# ---------------------------------------------------------------------------
# Live categories — hierarchical tree
# ---------------------------------------------------------------------------

def _sync_live_categories(
    db: Session, provider: XtreamProvider, client: XtreamClient, summary: SyncSummary
) -> dict[int, int]:
    """Returns {upstream_category_id: local_LiveCategory.id} for the leaves."""
    raw = client.get_live_categories() or []

    # In-memory index of existing live_category rows for this provider:
    #   key = (parent_id_or_None, lowercased_name)  -> LiveCategory.id
    rows = (
        db.query(LiveCategory.id, LiveCategory.parent_id, LiveCategory.category_name)
        .filter(LiveCategory.provider_id == provider.id)
        .all()
    )
    by_path: dict[tuple[Optional[int], str], int] = {
        (r.parent_id, (r.category_name or "").strip().lower()): r.id for r in rows
    }
    leaf_lookup: dict[int, int] = {}

    def _ensure_segment(segment: str, parent_local_id: Optional[int]) -> int:
        key = (parent_local_id, segment.strip().lower())
        existing = by_path.get(key)
        if existing is not None:
            return existing
        node = LiveCategory(
            provider_id=provider.id,
            parent_id=parent_local_id,
            category_name=segment.strip(),
        )
        db.add(node)
        db.flush()
        by_path[key] = node.id
        summary.live_categories_inserted += 1
        return node.id

    for cat in raw:
        upstream_cat_id = _to_int(cat.get("category_id"))
        segments = parse_live_category_segments(cat.get("category_name") or "")
        if not segments or upstream_cat_id is None:
            continue
        parent_local_id: Optional[int] = None
        leaf_local_id: Optional[int] = None
        for seg in segments:
            parent_local_id = _ensure_segment(seg, parent_local_id)
            leaf_local_id = parent_local_id

        if leaf_local_id is not None:
            leaf = db.get(LiveCategory, leaf_local_id)
            if leaf is not None and leaf.category_id != upstream_cat_id:
                leaf.category_id = upstream_cat_id
            leaf_lookup[upstream_cat_id] = leaf_local_id

    db.flush()
    return leaf_lookup


# ---------------------------------------------------------------------------
# Movie / serie categories — flat with optional language
# ---------------------------------------------------------------------------

def _sync_movie_categories(
    db: Session, provider: XtreamProvider, client: XtreamClient, summary: SyncSummary
) -> dict[int, int]:
    raw = client.get_vod_categories() or []
    local_rows = (
        db.query(MovieCategory)
        .filter(MovieCategory.provider_id == provider.id)
        .all()
    )
    by_id: dict[int, MovieCategory] = {r.category_id: r for r in local_rows}

    out: dict[int, int] = {}
    for cat in raw:
        upstream_cat_id = _to_int(cat.get("category_id"))
        if upstream_cat_id is None:
            continue
        language, name = parse_movie_category_name(cat.get("category_name") or "")
        existing = by_id.get(upstream_cat_id)
        if existing is None:
            row = MovieCategory(
                provider_id=provider.id,
                category_id=upstream_cat_id,
                language=language,
                category_name=name,
            )
            db.add(row)
            db.flush()
            by_id[upstream_cat_id] = row
            out[upstream_cat_id] = row.id
            summary.movie_categories_inserted += 1
        else:
            changed = False
            if existing.language != language:
                existing.language = language
                changed = True
            if existing.category_name != name:
                existing.category_name = name
                changed = True
            if changed:
                summary.movie_categories_updated += 1
            out[upstream_cat_id] = existing.id

    db.flush()
    return out


def _sync_serie_categories(
    db: Session, provider: XtreamProvider, client: XtreamClient, summary: SyncSummary
) -> dict[int, int]:
    raw = client.get_series_categories() or []
    local_rows = (
        db.query(SerieCategory)
        .filter(SerieCategory.provider_id == provider.id)
        .all()
    )
    by_id: dict[int, SerieCategory] = {r.category_id: r for r in local_rows}

    out: dict[int, int] = {}
    for cat in raw:
        upstream_cat_id = _to_int(cat.get("category_id"))
        if upstream_cat_id is None:
            continue
        language, name = parse_serie_category_name(cat.get("category_name") or "")
        existing = by_id.get(upstream_cat_id)
        if existing is None:
            row = SerieCategory(
                provider_id=provider.id,
                category_id=upstream_cat_id,
                language=language,
                category_name=name,
            )
            db.add(row)
            db.flush()
            by_id[upstream_cat_id] = row
            out[upstream_cat_id] = row.id
            summary.serie_categories_inserted += 1
        else:
            changed = False
            if existing.language != language:
                existing.language = language
                changed = True
            if existing.category_name != name:
                existing.category_name = name
                changed = True
            if changed:
                summary.serie_categories_updated += 1
            out[upstream_cat_id] = existing.id

    db.flush()
    return out


# ---------------------------------------------------------------------------
# Streams
# ---------------------------------------------------------------------------

_COMMIT_BATCH = 5000


def _sync_live_streams(
    db: Session,
    provider: XtreamProvider,
    client: XtreamClient,
    cat_index: dict[int, int],
    summary: SyncSummary,
) -> None:
    upstream = client.get_live_streams() or []
    local = (
        db.query(LiveStream.id, LiveStream.stream_id, LiveStream.category_id, LiveStream.added)
        .filter(LiveStream.provider_id == provider.id)
        .all()
    )
    local_index = {r.stream_id: (r.id, r.category_id, r.added) for r in local}

    pending = 0
    for item in upstream:
        sid = _to_int(item.get("stream_id"))
        if not sid:
            continue
        upstream_cat = _to_int(item.get("category_id"))
        added_dt = _ts_to_dt(item.get("added"))
        live_cat_fk = cat_index.get(upstream_cat) if upstream_cat else None

        existing = local_index.get(sid)
        if existing is None:
            db.add(LiveStream(
                provider_id=provider.id,
                stream_id=sid,
                xtream_live_id=_to_int(item.get("num")),
                name=_safe_text(parse_live_stream_name(item.get("name") or ""), 512) or "",
                raw_name=_safe_text(item.get("name"), 512),
                stream_type=_safe_text(item.get("stream_type"), 20) or "live",
                stream_icon=_safe_url(item.get("stream_icon")),
                epg_channel_id=_safe_text(item.get("epg_channel_id"), 255),
                added=added_dt,
                category_id=upstream_cat,
                live_category_id=live_cat_fk,
                custom_sid=_safe_text(item.get("custom_sid"), 255),
                tv_archive=bool(_to_int(item.get("tv_archive"))),
                tv_archive_duration=_to_int(item.get("tv_archive_duration")) or 0,
                direct_source=_safe_url(item.get("direct_source")),
            ))
            summary.live_streams_inserted += 1
            pending += 1
        else:
            local_id, local_cat, local_added = existing
            if local_cat == upstream_cat and (added_dt is None or local_added == added_dt):
                continue
            row = db.get(LiveStream, local_id)
            if row is None:
                continue
            if local_cat != upstream_cat:
                row.category_id = upstream_cat
                row.live_category_id = live_cat_fk
            if added_dt and local_added != added_dt:
                row.added = added_dt
            summary.live_streams_updated += 1
            pending += 1

        if pending >= _COMMIT_BATCH:
            db.commit()
            pending = 0

    if pending:
        db.commit()


def _sync_movie_streams(
    db: Session,
    provider: XtreamProvider,
    client: XtreamClient,
    cat_index: dict[int, int],
    summary: SyncSummary,
) -> None:
    upstream = client.get_vod_streams() or []
    local = (
        db.query(MovieStream.id, MovieStream.xtream_id, MovieStream.category_id, MovieStream.added)
        .filter(MovieStream.provider_id == provider.id)
        .all()
    )
    local_index = {r.xtream_id: (r.id, r.category_id, r.added) for r in local}

    pending = 0
    for item in upstream:
        xid = _to_int(item.get("stream_id"))
        if not xid:
            continue
        upstream_cat = _to_int(item.get("category_id"))
        added_dt = _ts_to_dt(item.get("added"))
        cat_fk = cat_index.get(upstream_cat) if upstream_cat else None

        existing = local_index.get(xid)
        if existing is None:
            language, title, year = parse_movie_stream_name(item.get("name") or "")
            try:
                rating_5 = float(item.get("rating_5based")) if item.get("rating_5based") not in (None, "") else None
            except (TypeError, ValueError):
                rating_5 = None
            db.add(MovieStream(
                provider_id=provider.id,
                xtream_id=xid,
                num=_to_int(item.get("num")),
                raw_name=_safe_text(item.get("name"), 512),
                language=_safe_text(language, 10),
                name=_safe_text(title, 512) or "",
                year=year,
                stream_type=_safe_text(item.get("stream_type"), 20) or "movie",
                stream_icon=_safe_url(item.get("stream_icon")),
                rating=_safe_text(str(item.get("rating")) if item.get("rating") not in (None, "") else None, 20),
                rating_5based=rating_5,
                added=added_dt,
                category_id=upstream_cat,
                movie_category_id=cat_fk,
                container_extension=_safe_text(item.get("container_extension"), 20),
            ))
            summary.movie_streams_inserted += 1
            pending += 1
        else:
            local_id, local_cat, local_added = existing
            if local_cat == upstream_cat and (added_dt is None or local_added == added_dt):
                continue
            row = db.get(MovieStream, local_id)
            if row is None:
                continue
            if local_cat != upstream_cat:
                row.category_id = upstream_cat
                row.movie_category_id = cat_fk
            if added_dt and local_added != added_dt:
                row.added = added_dt
            summary.movie_streams_updated += 1
            pending += 1

        if pending >= _COMMIT_BATCH:
            db.commit()
            pending = 0

    if pending:
        db.commit()


def _sync_series_streams(
    db: Session,
    provider: XtreamProvider,
    client: XtreamClient,
    cat_index: dict[int, int],
    summary: SyncSummary,
) -> None:
    upstream = client.get_series() or []
    local = (
        db.query(
            SeriesStream.id,
            SeriesStream.xtream_id,
            SeriesStream.category_id,
            SeriesStream.last_modified,
        )
        .filter(SeriesStream.provider_id == provider.id)
        .all()
    )
    local_index = {r.xtream_id: (r.id, r.category_id, r.last_modified) for r in local}

    pending = 0
    for item in upstream:
        sid = _to_int(item.get("series_id"))
        if not sid:
            continue
        upstream_cat = _to_int(item.get("category_id"))
        last_modified_dt = _ts_to_dt(item.get("last_modified"))
        cat_fk = cat_index.get(upstream_cat) if upstream_cat else None

        existing = local_index.get(sid)
        if existing is None:
            language, name = parse_series_stream_name(item.get("name") or "")
            try:
                rating_5 = float(item.get("rating_5based")) if item.get("rating_5based") not in (None, "") else None
            except (TypeError, ValueError):
                rating_5 = None
            db.add(SeriesStream(
                provider_id=provider.id,
                xtream_id=sid,
                num=_to_int(item.get("num")),
                raw_name=_safe_text(item.get("name"), 512),
                language=_safe_text(language, 10),
                name=_safe_text(name, 512) or "",
                stream_type=_safe_text(item.get("stream_type"), 20),
                stream_icon=_safe_url(item.get("cover")),
                rating=_safe_text(str(item.get("rating")) if item.get("rating") not in (None, "") else None, 20),
                rating_5based=rating_5,
                added=last_modified_dt,
                category_id=upstream_cat,
                series_category_id=cat_fk,
                cover=_safe_url(item.get("cover")),
                backdrop_path=_safe_url(_first_or_value(item.get("backdrop_path"))),
                plot=item.get("plot"),
                cast=item.get("cast"),
                director=_safe_text(item.get("director"), 512),
                release_date=_date_or_none(item.get("releaseDate") or item.get("release_date")),
                last_modified=last_modified_dt,
                youtube_trailer=_safe_text(item.get("youtube_trailer") or None, 100),
                episode_run_time=_to_int(item.get("episode_run_time")),
            ))
            summary.series_streams_inserted += 1
            pending += 1
        else:
            local_id, local_cat, local_lm = existing
            if local_cat == upstream_cat and (last_modified_dt is None or local_lm == last_modified_dt):
                continue
            row = db.get(SeriesStream, local_id)
            if row is None:
                continue
            if local_cat != upstream_cat:
                row.category_id = upstream_cat
                row.series_category_id = cat_fk
            if last_modified_dt and local_lm != last_modified_dt:
                row.last_modified = last_modified_dt
            summary.series_streams_updated += 1
            pending += 1

        if pending >= _COMMIT_BATCH:
            db.commit()
            pending = 0

    if pending:
        db.commit()


# ---------------------------------------------------------------------------
# Top-level entry
# ---------------------------------------------------------------------------

def run_catalog_sync(provider_id: int) -> dict:
    summary = SyncSummary(provider_id=provider_id)
    db: Session = SessionLocal()
    started = datetime.utcnow()
    try:
        provider = db.get(XtreamProvider, provider_id)
        if provider is None:
            summary.errors.append(f"provider id={provider_id} not found")
            return summary.to_dict()

        creds = _resolve_master_credentials(db, provider)
        if creds is None:
            summary.errors.append(
                f"provider id={provider_id} has no usable active_master_user_id"
            )
            return summary.to_dict()

        provider.sync_started_at = started
        db.commit()

        client = XtreamClient(
            base_url=provider.base_url,
            username=creds[0],
            password=creds[1],
        )

        _sync_live_categories(db, provider, client, summary)
        movie_cat_index = _sync_movie_categories(db, provider, client, summary)
        serie_cat_index = _sync_serie_categories(db, provider, client, summary)
        live_cat_index = {
            r.category_id: r.id
            for r in db.query(LiveCategory.id, LiveCategory.category_id)
            .filter(LiveCategory.provider_id == provider.id, LiveCategory.category_id.isnot(None))
            .all()
        }
        db.commit()

        _sync_live_streams(db, provider, client, live_cat_index, summary)
        _sync_movie_streams(db, provider, client, movie_cat_index, summary)
        _sync_series_streams(db, provider, client, serie_cat_index, summary)

        provider.is_populated = True
        provider.last_synced_at = datetime.utcnow()
        provider.last_refreshed_at = provider.last_synced_at
        provider.sync_started_at = None
        db.commit()
    except Exception as exc:
        logger.exception("Catalog sync failed for provider id=%s", provider_id)
        summary.errors.append(f"unhandled: {exc}")
        db.rollback()
    finally:
        db.close()

    logger.info("Catalog sync done: %s", summary.to_dict())
    return summary.to_dict()


def trigger_provider_sync(provider_id: int) -> bool:
    """Kick off a background catalog sync for the given provider."""
    threading.Thread(
        target=run_catalog_sync,
        args=(provider_id,),
        name=f"catalog-sync-{provider_id}",
        daemon=True,
    ).start()
    return True
