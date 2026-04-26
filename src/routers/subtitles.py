"""On-demand subtitles, DB-cached.

Flow per request:
  GET /api/v1/subtitles?tmdb_id=550&lang=en,fr[&season=1&episode=3]
    -> for each requested lang, check (tmdb_id, lang, season, episode) in DB
    -> cache HIT  : return entry
    -> cache MISS : SUBDL search -> download zip -> convert to VTT
                    -> persist row with vtt_content -> return entry

  GET /api/v1/subtitles/{id}
    -> serve the cached vtt_content as text/vtt with a long Cache-Control.

The TMDB-id self-heal that the legacy router had (which patched a wrong
upstream tmdb_id by searching TMDB by name) is intentionally not lifted
here — it depended on a TMDBEnrichmentService that hasn't been rebuilt
yet. It comes back in step T (TMDB enrichment refactor).
"""

import io
import logging
import re
import zipfile
from datetime import datetime
from typing import Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Subtitle
from ..services.subdl_client import (
    LANG_LABELS,
    best_per_language,
    search_subtitles,
    subtitle_download_url,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/subtitles", tags=["subtitles"])


# ---------------------------------------------------------------------------
# Response model
# ---------------------------------------------------------------------------

class SubtitleEntry(BaseModel):
    id: int
    tmdb_id: int
    lang: str
    label: str
    season: int
    episode: int
    url_vtt: str

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Subtitle format conversion
# ---------------------------------------------------------------------------

def _srt_to_vtt(srt_text: str) -> str:
    text = srt_text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", text)
    return "WEBVTT\n\n" + text.strip() + "\n"


def _ass_to_vtt(ass_text: str) -> str:
    lines = ass_text.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    fmt_indices: Dict[str, int] = {}
    dialogues: List[List[str]] = []
    in_events = False

    for line in lines:
        stripped = line.strip()
        if stripped == "[Events]":
            in_events = True
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            in_events = False
            continue
        if in_events and stripped.startswith("Format:") and not fmt_indices:
            cols = [c.strip() for c in stripped[len("Format:"):].split(",")]
            fmt_indices = {c: i for i, c in enumerate(cols)}
        elif in_events and stripped.startswith("Dialogue:"):
            n_cols = len(fmt_indices) if fmt_indices else 10
            parts = stripped[len("Dialogue:"):].split(",", n_cols - 1)
            dialogues.append(parts)

    if not fmt_indices or not dialogues:
        raise ValueError("could not parse ASS — no Dialogue lines found")

    start_i = fmt_indices.get("Start", 1)
    end_i = fmt_indices.get("End", 2)
    text_i = fmt_indices.get("Text", len(fmt_indices) - 1)

    def _ts(ts: str) -> str:
        ts = ts.strip()
        try:
            h, m, rest = ts.split(":")
            s, cs = rest.split(".")
            ms = int(cs) * 10
            return f"{int(h):02d}:{int(m):02d}:{int(s):02d}.{ms:03d}"
        except Exception:
            return ts

    def _strip(t: str) -> str:
        return re.sub(r"\{[^}]*\}", "", t).replace("\\N", "\n").replace("\\n", "\n")

    blocks = []
    for i, parts in enumerate(dialogues, 1):
        start = _ts(parts[start_i])
        end = _ts(parts[end_i])
        text = _strip(parts[text_i]).strip()
        if text:
            blocks.append(f"{i}\n{start} --> {end}\n{text}")

    return "WEBVTT\n\n" + "\n\n".join(blocks) + "\n"


# ---------------------------------------------------------------------------
# Zip extraction
# ---------------------------------------------------------------------------

_EPISODE_RE_TEMPLATE = r"[Ss]0*{s}[xXeE]0*{e}|0*{s}[xX]0*{e}"


def _zip_to_vtt(zip_bytes: bytes, season: int = 0, episode: int = 0) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        lower = {n.lower(): n for n in names}

        ep_pattern: Optional[re.Pattern] = None
        if season > 0 and episode > 0:
            ep_pattern = re.compile(_EPISODE_RE_TEMPLATE.format(s=season, e=episode))

        def _pick(ext: str) -> Optional[str]:
            candidates = [(low, orig) for low, orig in lower.items() if low.endswith(ext)]
            if not candidates:
                return None
            if ep_pattern:
                for low, orig in candidates:
                    if ep_pattern.search(low):
                        return orig
            return candidates[0][1]

        if (fn := _pick(".vtt")):
            return zf.read(fn).decode("utf-8-sig", errors="replace")
        if (fn := _pick(".srt")):
            return _srt_to_vtt(zf.read(fn).decode("utf-8-sig", errors="replace"))
        if (fn := _pick(".ass")) or (fn := _pick(".ssa")):
            return _ass_to_vtt(zf.read(fn).decode("utf-8-sig", errors="replace"))

        raise ValueError(f"no VTT/SRT/ASS found in zip; contents: {names}")


def _fetch_and_convert(zip_path: str, season: int = 0, episode: int = 0) -> str:
    download_url = subtitle_download_url(zip_path)
    try:
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            resp = client.get(download_url)
            resp.raise_for_status()
            zip_bytes = resp.content
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"failed to download subtitle: {exc}") from exc

    try:
        return _zip_to_vtt(zip_bytes, season=season, episode=episode)
    except (zipfile.BadZipFile, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"could not parse subtitle file: {exc}") from exc


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

def _build_response(subtitles: List[Subtitle], base_url: str) -> List[SubtitleEntry]:
    return [
        SubtitleEntry(
            id=s.id,
            tmdb_id=s.tmdb_id,
            lang=s.lang,
            label=s.label or s.lang.upper(),
            season=s.season,
            episode=s.episode,
            url_vtt=f"{base_url}/api/v1/subtitles/{s.id}",
        )
        for s in subtitles
    ]


@router.get("", response_model=List[SubtitleEntry])
def get_subtitles(
    request: Request,
    tmdb_id: int = Query(..., description="TMDB id of the movie or series"),
    lang: Optional[str] = Query(
        None,
        description="Comma-separated 2-letter language codes (e.g. en,fr). Omit for all.",
    ),
    season: int = Query(0, ge=0),
    episode: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """Return cached subtitles for a movie or series episode, fetching from SUBDL on cache miss."""
    languages: List[str] = []
    if lang:
        languages = [l.strip().lower() for l in lang.split(",") if l.strip()]

    base_url = str(request.base_url).rstrip("/")

    query = db.query(Subtitle).filter(
        Subtitle.tmdb_id == tmdb_id,
        Subtitle.season == season,
        Subtitle.episode == episode,
    )
    if languages:
        query = query.filter(Subtitle.lang.in_(languages))
    cached = {s.lang: s for s in query.all()}

    missing = [l for l in languages if l not in cached] if languages else []
    if languages and not missing:
        return _build_response(list(cached.values()), base_url)

    fetch_langs = missing if missing else None
    try:
        raw_subs = search_subtitles(tmdb_id, fetch_langs, season=season, episode=episode)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"SUBDL API error: {exc}") from exc

    if not raw_subs:
        # No upstream results — return whatever's cached (might be empty).
        return _build_response(list(cached.values()), base_url)

    deduped = best_per_language(raw_subs, episode=episode)
    newly_added: List[Subtitle] = []

    for sub in deduped:
        lang_code = (sub.get("language") or "").lower()
        if not lang_code or lang_code in cached:
            continue
        zip_path = sub.get("url", "")
        if not zip_path:
            continue
        label = (
            LANG_LABELS.get(lang_code.upper())
            or sub.get("lang", "").capitalize()
            or lang_code.upper()
        )
        try:
            vtt_text = _fetch_and_convert(zip_path, season=season, episode=episode)
        except HTTPException as exc:
            logger.warning(
                "subtitles: skipping %s for tmdb_id=%d S%02dE%02d — %s",
                lang_code, tmdb_id, season, episode, exc.detail,
            )
            continue
        now = datetime.utcnow()
        subtitle = Subtitle(
            tmdb_id=tmdb_id,
            lang=lang_code,
            label=label,
            season=season,
            episode=episode,
            vtt_content=vtt_text,
            source_url=zip_path,
            created_at=now,
            updated_at=now,
        )
        db.add(subtitle)
        newly_added.append(subtitle)

    if newly_added:
        db.commit()
        for s in newly_added:
            db.refresh(s)

    all_subs = list(cached.values()) + newly_added
    if languages:
        all_subs = [s for s in all_subs if s.lang in languages]
    return _build_response(all_subs, base_url)


@router.get("/{subtitle_id}")
def serve_vtt(subtitle_id: int, db: Session = Depends(get_db)):
    """Serve cached VTT bytes from the DB."""
    subtitle = db.get(Subtitle, subtitle_id)
    if not subtitle or not subtitle.vtt_content:
        raise HTTPException(status_code=404, detail="subtitle not found")

    return Response(
        content=subtitle.vtt_content.encode("utf-8"),
        media_type="text/vtt; charset=utf-8",
        headers={
            "Cache-Control": "public, max-age=604800",
            "Access-Control-Allow-Origin": "*",
        },
    )
