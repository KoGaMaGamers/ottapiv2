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

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import SessionLocal
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
    series_episodes_skipped: int = 0
    series_episodes_fetched: int = 0
    series_episodes_failed: int = 0
    seasons_inserted: int = 0
    seasons_updated: int = 0
    episodes_inserted: int = 0
    episodes_updated: int = 0
    episodes_pruned: int = 0
    movie_details_fetched: int = 0
    movie_details_failed: int = 0
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
# Episodes — phase 2
# ---------------------------------------------------------------------------

def _pick_default_video(track) -> Optional[dict]:
    """Pick first non-mjpeg, non-attached_pic video track."""
    if isinstance(track, dict):
        candidates = [track]
    elif isinstance(track, list):
        candidates = [t for t in track if isinstance(t, dict)]
    else:
        return None
    for s in candidates:
        if (s.get("codec_name") or "").lower() == "mjpeg":
            continue
        if (s.get("disposition") or {}).get("attached_pic"):
            continue
        return s
    return candidates[0] if candidates else None


def _pick_default_audio(track) -> Optional[dict]:
    if isinstance(track, dict):
        candidates = [track]
    elif isinstance(track, list):
        candidates = [t for t in track if isinstance(t, dict)]
    else:
        return None
    for s in candidates:
        if (s.get("disposition") or {}).get("default"):
            return s
    return candidates[0] if candidates else None


def _episode_sync_up_to_date(series: SeriesStream, upstream_last_modified: Optional[datetime]) -> bool:
    """Skip per-series episode fetch if local data is at least as fresh as upstream's last_modified.

    Compares ``episodes_last_synced_at`` (set after a successful per-series upsert) against
    the upstream ``last_modified`` value from the get_series listing. If we've already synced
    at or after that watermark, the data is current and we can skip the get_series_info call.
    """
    if upstream_last_modified is None:
        # No upstream signal → safer to refetch.
        return False
    last_synced = series.episodes_last_synced_at
    if last_synced is None:
        return False
    return last_synced >= upstream_last_modified


def _upsert_seasons(
    db: Session, series: SeriesStream, seasons_data: list[dict], summary: SyncSummary
) -> dict[int, int]:
    """Returns {season_number: SeriesSeason.id}."""
    existing = (
        db.query(SeriesSeason)
        .filter(SeriesSeason.series_id == series.id)
        .all()
    )
    by_num = {row.season_number: row for row in existing}
    out: dict[int, int] = {}
    for sd in seasons_data or []:
        sn = _to_int(sd.get("season_number"))
        if sn is None:
            continue
        row = by_num.get(sn)
        if row is None:
            row = SeriesSeason(
                series_id=series.id,
                provider_id=series.provider_id,
                tmdb_season_id=_to_int(sd.get("id")),
                season_number=sn,
                name=_safe_text(sd.get("name"), 255),
                overview=sd.get("overview"),
                air_date=_date_or_none(sd.get("air_date")),
                episode_count=_to_int(sd.get("episode_count")),
                vote_average=float(sd["vote_average"]) if sd.get("vote_average") not in (None, "") else None,
                cover=_safe_url(sd.get("cover")),
                cover_big=_safe_url(sd.get("cover_big")),
            )
            db.add(row)
            db.flush()
            summary.seasons_inserted += 1
        else:
            changed = False
            for field_name, new_value in (
                ("tmdb_season_id", _to_int(sd.get("id"))),
                ("name", _safe_text(sd.get("name"), 255)),
                ("overview", sd.get("overview")),
                ("air_date", _date_or_none(sd.get("air_date"))),
                ("episode_count", _to_int(sd.get("episode_count"))),
                ("cover", _safe_url(sd.get("cover"))),
                ("cover_big", _safe_url(sd.get("cover_big"))),
            ):
                if getattr(row, field_name) != new_value:
                    setattr(row, field_name, new_value)
                    changed = True
            if changed:
                summary.seasons_updated += 1
        out[sn] = row.id
    return out


def _normalize_episodes_block(block) -> dict:
    """Some providers return episodes as a flat list instead of {season: [eps]}.

    Normalise to {season_number_str: [eps]} either way.
    """
    if isinstance(block, dict):
        return block
    if isinstance(block, list):
        out: dict = {}
        for ep in block:
            if not isinstance(ep, dict):
                continue
            sn = ep.get("season")
            if sn is None:
                continue
            out.setdefault(str(sn), []).append(ep)
        return out
    return {}


def _upsert_episodes(
    db: Session,
    series: SeriesStream,
    episodes_block,
    season_id_by_number: dict[int, int],
    summary: SyncSummary,
) -> set[int]:
    """Returns the set of upstream xtream_ids we touched (for prune)."""
    existing_rows = (
        db.query(SeriesEpisode)
        .filter(SeriesEpisode.series_id == series.id)
        .all()
    )
    existing = {row.xtream_id: row for row in existing_rows}

    seen: set[int] = set()
    block = _normalize_episodes_block(episodes_block)
    for season_key, ep_list in block.items():
        season_number = _to_int(season_key)
        if season_number is None or not isinstance(ep_list, list):
            continue
        season_pk = season_id_by_number.get(season_number)
        if season_pk is None:
            continue

        for ep in ep_list:
            if not isinstance(ep, dict):
                continue
            xid = _to_int(ep.get("id"))
            if xid is None:
                continue
            seen.add(xid)

            info = ep.get("info") or {}
            video = _pick_default_video(info.get("video")) or {}
            audio = _pick_default_audio(info.get("audio")) or {}
            audio_lang = (audio.get("tags") or {}).get("language") if isinstance(audio.get("tags"), dict) else None

            try:
                added_dt = _ts_to_dt(ep.get("added"))
            except Exception:
                added_dt = None

            payload = dict(
                series_id=series.id,
                season_id=season_pk,
                provider_id=series.provider_id,
                xtream_id=xid,
                season_number=season_number,
                episode_num=_to_int(ep.get("episode_num")) or 0,
                raw_title=_safe_text(ep.get("title"), 512),
                title=_safe_text(ep.get("title"), 512),
                container_extension=_safe_text(ep.get("container_extension"), 20),
                custom_sid=_safe_text(ep.get("custom_sid"), 255),
                direct_source=_safe_url(ep.get("direct_source")),
                added=added_dt,
                tmdb_id=_to_int(info.get("tmdb_id")),
                release_date=_date_or_none(info.get("releasedate")),
                plot=info.get("plot"),
                movie_image=_safe_url(info.get("movie_image")),
                duration_secs=_to_int(info.get("duration_secs")),
                rating=_safe_text(str(info.get("rating")) if info.get("rating") not in (None, "") else None, 20),
                video_codec=_safe_text(video.get("codec_name"), 20),
                video_width=_to_int(video.get("width")),
                video_height=_to_int(video.get("height")),
                audio_codec=_safe_text(audio.get("codec_name"), 20),
                audio_channels=_to_int(audio.get("channels")),
                audio_channel_layout=_safe_text(audio.get("channel_layout"), 50),
                audio_language=_safe_text(audio_lang, 10),
                bitrate=_to_int(info.get("bitrate")),
                frame_rate=_safe_text(video.get("r_frame_rate") or video.get("avg_frame_rate"), 20),
                aspect_ratio=_safe_text(video.get("display_aspect_ratio"), 10),
                crew=info.get("crew"),
            )

            row = existing.get(xid)
            if row is None:
                db.add(SeriesEpisode(**payload))
                summary.episodes_inserted += 1
            else:
                changed = False
                for k, v in payload.items():
                    if k in ("series_id", "provider_id", "xtream_id"):
                        continue
                    if getattr(row, k) != v:
                        setattr(row, k, v)
                        changed = True
                if changed:
                    summary.episodes_updated += 1

    return seen


def _sync_series_episodes(
    db: Session,
    provider: XtreamProvider,
    client: XtreamClient,
    summary: SyncSummary,
) -> None:
    upstream_series = client.get_series() or []
    upstream_by_xid = {
        int(s["series_id"]): s
        for s in upstream_series
        if s.get("series_id")
    }

    local_series = (
        db.query(SeriesStream)
        .filter(SeriesStream.provider_id == provider.id)
        .order_by(SeriesStream.id)
        .all()
    )

    total = len(local_series)
    fetched_in_batch = 0
    for idx, ss in enumerate(local_series):
        if idx > 0 and idx % 100 == 0:
            logger.info(
                "episode sync progress: %d/%d series  skipped=%d fetched=%d failed=%d",
                idx, total,
                summary.series_episodes_skipped,
                summary.series_episodes_fetched,
                summary.series_episodes_failed,
            )

        upstream = upstream_by_xid.get(ss.xtream_id)
        if not upstream:
            continue
        upstream_last_modified = _ts_to_dt(upstream.get("last_modified"))

        if _episode_sync_up_to_date(ss, upstream_last_modified):
            summary.series_episodes_skipped += 1
            continue

        info = client.get_series_info(ss.xtream_id)
        if not info:
            summary.errors.append(f"series xtream_id={ss.xtream_id}: get_series_info failed")
            summary.series_episodes_failed += 1
            continue

        try:
            season_ids = _upsert_seasons(db, ss, info.get("seasons") or [], summary)
            seen_eps = _upsert_episodes(
                db, ss, info.get("episodes") or {}, season_ids, summary
            )
            if seen_eps:
                stale = (
                    db.query(SeriesEpisode)
                    .filter(SeriesEpisode.series_id == ss.id)
                    .filter(~SeriesEpisode.xtream_id.in_(seen_eps))
                    .all()
                )
                for row in stale:
                    db.delete(row)
                    summary.episodes_pruned += 1
            ss.episodes_last_synced_at = upstream_last_modified or datetime.utcnow()
        except Exception as exc:
            logger.warning("series xtream_id=%s upsert failed: %s", ss.xtream_id, exc)
            summary.errors.append(f"series xtream_id={ss.xtream_id}: {exc}")
            summary.series_episodes_failed += 1
            db.rollback()
            continue

        summary.series_episodes_fetched += 1
        fetched_in_batch += 1
        if fetched_in_batch >= 50:
            db.commit()
            fetched_in_batch = 0

    db.commit()
    logger.info(
        "episode sync done: %d/%d series  skipped=%d fetched=%d failed=%d  "
        "(episodes inserted=%d updated=%d pruned=%d)",
        total, total,
        summary.series_episodes_skipped,
        summary.series_episodes_fetched,
        summary.series_episodes_failed,
        summary.episodes_inserted,
        summary.episodes_updated,
        summary.episodes_pruned,
    )


# ---------------------------------------------------------------------------
# Movie details — phase 3 (Xtream get_vod_info per movie)
# ---------------------------------------------------------------------------

def _apply_vod_info_to_movie(ms: MovieStream, info: dict) -> None:
    """Populate MovieStream fields from get_vod_info's `info` block.

    Only fills fields that are currently NULL (idempotent — repeated runs
    don't overwrite existing values that may have been hand-curated).
    """
    if ms.tmdb_id is None:
        v = _to_int(info.get("tmdb_id"))
        if v:
            ms.tmdb_id = v

    if not ms.o_name:
        v = _safe_text(info.get("o_name"), 512)
        if v:
            ms.o_name = v

    if not ms.cover_big:
        ms.cover_big = _safe_url(info.get("cover_big") or info.get("movie_image"))

    if not ms.backdrop_path:
        bp = info.get("backdrop_path")
        if isinstance(bp, list):
            bp = bp[0] if bp else None
        ms.backdrop_path = _safe_url(bp)

    if not ms.description:
        text = info.get("plot") or info.get("description")
        if text:
            ms.description = str(text)

    if not ms.actors:
        text = info.get("actors") or info.get("cast")
        if text:
            ms.actors = str(text)

    if not ms.director:
        if info.get("director"):
            ms.director = str(info["director"])

    if not ms.country:
        v = _safe_text(info.get("country"), 100)
        if v:
            ms.country = v

    if not ms.age_rating:
        v = _safe_text(info.get("age"), 20)
        if v:
            ms.age_rating = v

    if not ms.genre_raw:
        v = _safe_text(info.get("genre"), 255)
        if v:
            ms.genre_raw = v

    if not ms.status:
        v = _safe_text(info.get("status"), 20)
        if v:
            ms.status = v

    if not ms.youtube_trailer:
        v = _safe_text(info.get("youtube_trailer"), 100)
        if v:
            ms.youtube_trailer = v

    if not ms.releasedate:
        ms.releasedate = _date_or_none(info.get("releasedate"))

    if not ms.duration:
        v = _safe_text(info.get("duration"), 20)
        if v:
            ms.duration = v

    if ms.duration_secs is None:
        v = _to_int(info.get("duration_secs") or info.get("runtime"))
        if v:
            ms.duration_secs = v

    if ms.bitrate is None:
        v = _to_int(info.get("bitrate"))
        if v:
            ms.bitrate = v

    # Opportunistic ffprobe-like blocks (not all providers return these).
    video = _pick_default_video(info.get("video"))
    if video:
        if not ms.video_codec:
            ms.video_codec = _safe_text(video.get("codec_name"), 20)
        if ms.video_width is None:
            ms.video_width = _to_int(video.get("width"))
        if ms.video_height is None:
            ms.video_height = _to_int(video.get("height"))

    audio = _pick_default_audio(info.get("audio"))
    if audio:
        if not ms.audio_codec:
            ms.audio_codec = _safe_text(audio.get("codec_name"), 20)
        if ms.audio_channels is None:
            ms.audio_channels = _to_int(audio.get("channels"))
        if not ms.audio_channel_layout:
            ms.audio_channel_layout = _safe_text(audio.get("channel_layout"), 50)


def run_movie_details_sync(provider_id: int) -> dict:
    """Background phase 3: per-movie get_vod_info enrichment.

    Idempotent: only touches movie_streams rows where details_synced_at is NULL.
    Sets details_synced_at on success; subsequent runs skip the row.
    """
    summary_local = {
        "provider_id": provider_id,
        "fetched": 0,
        "failed": 0,
        "errors": [],
    }
    db: Session = SessionLocal()
    try:
        provider = db.get(XtreamProvider, provider_id)
        if provider is None:
            summary_local["errors"].append(f"provider id={provider_id} not found")
            return summary_local
        creds = _resolve_master_credentials(db, provider)
        if creds is None:
            summary_local["errors"].append("no master credentials")
            return summary_local

        client = XtreamClient(provider.base_url, creds[0], creds[1])

        rows = (
            db.query(MovieStream)
            .filter(MovieStream.provider_id == provider_id)
            .filter(MovieStream.details_synced_at.is_(None))
            .order_by(MovieStream.id)
            .all()
        )
        total = len(rows)
        logger.info("movie details: %d movies need enrichment for provider id=%s", total, provider_id)

        pending = 0
        for idx, ms in enumerate(rows):
            if idx > 0 and idx % 200 == 0:
                logger.info(
                    "movie details progress: %d/%d  fetched=%d failed=%d",
                    idx, total, summary_local["fetched"], summary_local["failed"],
                )

            resp = client.get_vod_info(ms.xtream_id)
            if not resp:
                summary_local["failed"] += 1
                continue

            info = resp.get("info") or {}
            try:
                _apply_vod_info_to_movie(ms, info)
                ms.details_synced_at = datetime.utcnow()
                summary_local["fetched"] += 1
                pending += 1
            except Exception as exc:
                logger.warning("movie %s detail upsert failed: %s", ms.xtream_id, exc)
                summary_local["errors"].append(f"movie {ms.xtream_id}: {exc}")
                summary_local["failed"] += 1
                db.rollback()
                continue

            if pending >= 100:
                db.commit()
                pending = 0

        if pending:
            db.commit()
    except Exception as exc:
        logger.exception("movie details sync failed for provider id=%s", provider_id)
        summary_local["errors"].append(f"unhandled: {exc}")
        db.rollback()
    finally:
        db.close()

    logger.info("movie details done: %s", {k: v for k, v in summary_local.items() if k != "errors"})

    # Phase 4 — TMDB enrichment. Chained sequentially (not in parallel) so it
    # doesn't race with phase 3 on movie_streams updates. Lazy import to
    # avoid a circular dependency at module load.
    try:
        from .tmdb_enrichment import run_tmdb_enrichment
        run_tmdb_enrichment(provider_id)
    except Exception:
        logger.exception("chained TMDB enrichment failed for provider id=%s", provider_id)

    return summary_local


def trigger_movie_details_sync(provider_id: int) -> bool:
    """Spawn movie details sync as a daemon thread."""
    threading.Thread(
        target=run_movie_details_sync,
        args=(provider_id,),
        name=f"movie-details-{provider_id}",
        daemon=True,
    ).start()
    return True


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
        _sync_series_episodes(db, provider, client, summary)

        provider.is_populated = True
        provider.last_synced_at = datetime.utcnow()
        provider.last_refreshed_at = provider.last_synced_at
        provider.sync_started_at = None
        db.commit()

        # Phase 3 — movie detail mining via Xtream get_vod_info — runs in
        # its own background thread so this function returns quickly and the
        # 24h scheduler isn't blocked on a 4-hour cold-start enrichment.
        # Phase 4 (TMDB enrichment) is chained from inside that thread when
        # phase 3 completes — running them in parallel deadlocks because
        # both update movie_streams.
        trigger_movie_details_sync(provider_id)
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
