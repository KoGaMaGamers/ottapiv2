"""User-facing stream proxy + preview-clip generator.

Two endpoints:

  GET /api/v1/user/stream-proxy?url=…&token=…
      Transport-level proxy for live/HLS preview URLs the WebView
      can't fetch directly (mixed content, CORS). Streams bytes
      through verbatim for non-HLS, rewrites M3U8 child URLs back
      through this proxy so the chain stays inside auth.

  GET /api/v1/user/preview-clip?url=…&type=movie&token=…
      Generates a 60-second teaser clip from a donor VOD URL using
      ffmpeg, caches it on disk for 30 min, returns a relative
      `/api/v1/user/preview-clip/file/{clip_id}` for the WebView's
      <video> element to fetch.

  GET /api/v1/user/preview-clip/file/{clip_id}?token=…
      Serves a previously-generated clip file.

Auth: JWT either via `Authorization: Bearer …` (XHR / fetch) OR via a
`token=` query string (HTML media elements can't set headers). The
JWT identifies the *requester*, but the URL we fetch is already a
donor URL minted by `/api/v1/play/{kind}/{id}` or
`/api/v1/play/preview/{kind}/{id}` — this proxy / clipper is a
transport-level shim, it does NOT swap creds.
"""

from __future__ import annotations

import hashlib
import logging
import os
import random
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import List, Literal, Optional
from urllib.parse import quote, urljoin, urlparse

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import IPTVUser
from ..services.auth_service import get_user_from_token


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/user", tags=["streams"])


# ── Preview-clip config ─────────────────────────────────────────────────────

_PREVIEW_CLIP_CACHE_DIR = Path(os.getenv(
    "PREVIEW_CLIP_CACHE_DIR", "/tmp/ottapi_preview_clips",
))
_PREVIEW_CLIP_TTL_SEC = int(os.getenv("PREVIEW_CLIP_TTL_SEC", "1800"))   # 30 min
_PREVIEW_CLIP_MAX_BYTES = int(os.getenv(
    "PREVIEW_CLIP_MAX_BYTES", str(1_500_000_000),
))   # ~1.5 GB total cache budget
_PREVIEW_CLIP_DURATION_SEC = 60
_PREVIEW_CLIP_RANDOM_START_MIN = 300
_PREVIEW_CLIP_RANDOM_START_MAX = 600
_PREVIEW_CLIP_ALLOW_DEBUG_START = (
    os.getenv("PREVIEW_CLIP_ALLOW_DEBUG_START", "false").strip().lower() == "true"
)
_FFMPEG_TIMEOUT_SEC = 95


class PreviewClipResponse(BaseModel):
    clip_url: str
    start_at_sec: int
    duration_sec: int
    cached: bool
    expires_at: int


# ── Auth: header OR query-string token ──────────────────────────────────────

def _resolve_user(
    authorization: Optional[str],
    token_qs: Optional[str],
    db: Session,
) -> IPTVUser:
    raw = None
    if authorization and authorization.lower().startswith("bearer "):
        raw = authorization[7:].strip()
    elif token_qs:
        raw = token_qs.strip()
    if not raw:
        raise HTTPException(status_code=401, detail="missing bearer token")
    user = get_user_from_token(raw, db)
    if user is None:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    return user


# ── Helpers ─────────────────────────────────────────────────────────────────

# Hop-by-hop headers we must NOT forward back to the WebView.
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
    # We re-set Content-Type explicitly when rewriting M3U8.
}

# Default UA: WebView-style. Many xtream upstreams reject bare/curl UAs.
_FALLBACK_UA = (
    "Mozilla/5.0 (Linux; Android 12; TV) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

_M3U8_LINE_RE = re.compile(r"^([^\s#].*)$", re.MULTILINE)


def _proxy_url_for(absolute: str, token: str) -> str:
    """Wrap `absolute` so a media element can fetch it through this proxy."""
    return f"/api/v1/user/stream-proxy?url={quote(absolute, safe='')}&token={quote(token, safe='')}"


def _rewrite_m3u8(body: str, base_url: str, token: str) -> str:
    """Rewrite every URL line (variant playlists + segments) in `body`
    to flow back through the proxy. Resolves relative paths against
    `base_url` (the URL of THIS playlist after redirects).
    """
    out_lines = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            # Comment / tag line. Some tags carry a URI in their attributes
            # (e.g. EXT-X-KEY:URI="..."); rewrite those too.
            if "URI=\"" in line:
                def repl(m):
                    inner = m.group(1)
                    abs_url = urljoin(base_url, inner)
                    return f'URI="{_proxy_url_for(abs_url, token)}"'
                line = re.sub(r'URI="([^"]+)"', repl, line)
            out_lines.append(line)
            continue
        # URL line.
        abs_url = urljoin(base_url, stripped)
        out_lines.append(_proxy_url_for(abs_url, token))
    return "\n".join(out_lines) + ("\n" if body.endswith("\n") else "")


def _looks_like_m3u8(url: str, content_type: str) -> bool:
    if content_type and any(t in content_type.lower() for t in (
        "mpegurl", "m3u8", "vnd.apple.mpegurl",
    )):
        return True
    path = urlparse(url).path.lower()
    return path.endswith(".m3u8") or path.endswith(".m3u")


# ── Endpoint ────────────────────────────────────────────────────────────────

@router.api_route("/stream-proxy", methods=["GET", "HEAD"])
def stream_proxy(
    request: Request,
    url: str = Query(..., description="Absolute upstream URL to fetch"),
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    _resolve_user(authorization, token, db)   # 401s on bad auth

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=422, detail="invalid proxy url")

    fwd_headers = {
        "User-Agent":      request.headers.get("user-agent") or _FALLBACK_UA,
        "Accept":          request.headers.get("accept") or "*/*",
        "Accept-Language": request.headers.get("accept-language") or "en-US,en;q=0.9",
    }
    if request.headers.get("range"):
        fwd_headers["Range"] = request.headers["range"]

    # Use a streaming client. We open a connection, optionally read+rewrite
    # the body if it's an HLS playlist, otherwise pipe the bytes through.
    method = request.method.upper()
    timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)
    client = httpx.Client(follow_redirects=True, timeout=timeout)

    try:
        upstream = client.send(
            client.build_request(method, url, headers=fwd_headers),
            stream=True,
        )
    except httpx.RequestError as exc:
        client.close()
        logger.warning("stream-proxy upstream error %s: %s", url, exc)
        raise HTTPException(status_code=502, detail="upstream unreachable") from exc

    # Final URL after redirects — needed for M3U8 base resolution.
    final_url = str(upstream.url)
    upstream_ct = upstream.headers.get("content-type", "")
    is_hls = _looks_like_m3u8(final_url, upstream_ct)

    # Status-code passthrough (so 4xx/5xx surface to HLS.js's error handler).
    status = upstream.status_code

    # Build response headers (drop hop-by-hop, keep media-relevant ones).
    out_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }
    out_headers["Access-Control-Allow-Origin"] = "*"

    if is_hls:
        try:
            body = upstream.read().decode("utf-8", errors="replace")
        finally:
            upstream.close()
            client.close()
        token_for_children = token or (authorization[7:].strip() if authorization else "")
        rewritten = _rewrite_m3u8(body, final_url, token_for_children)
        out_headers["Content-Type"] = "application/vnd.apple.mpegurl"
        out_headers.pop("content-length", None)
        out_headers.pop("Content-Length", None)
        return Response(content=rewritten, status_code=status, headers=out_headers)

    # HEAD / non-HLS: stream upstream body verbatim.
    if method == "HEAD":
        upstream.close()
        client.close()
        return Response(status_code=status, headers=out_headers)

    def _iter():
        try:
            for chunk in upstream.iter_bytes(chunk_size=64 * 1024):
                yield chunk
        finally:
            upstream.close()
            client.close()

    return StreamingResponse(_iter(), status_code=status, headers=out_headers)


# ── Preview-clip helpers ────────────────────────────────────────────────────

def _ensure_preview_cache_dir() -> Path:
    _PREVIEW_CLIP_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _PREVIEW_CLIP_CACHE_DIR


def _safe_stream_ref(raw_url: str) -> str:
    try:
        parsed = urlparse(raw_url)
        host = parsed.hostname or "unknown-host"
        path_tail = (parsed.path or "").split("/")[-1] or "-"
        return f"{host}/{path_tail}"
    except Exception:
        return "invalid-url"


def _pick_preview_start_at(debug_start_at_sec: Optional[int]) -> int:
    if debug_start_at_sec is not None and _PREVIEW_CLIP_ALLOW_DEBUG_START:
        return max(0, int(debug_start_at_sec))
    return random.randint(
        _PREVIEW_CLIP_RANDOM_START_MIN, _PREVIEW_CLIP_RANDOM_START_MAX,
    )


def _preview_clip_id(user_id: int, source_url: str, start_at_sec: int, duration_sec: int) -> str:
    payload = f"{user_id}|{source_url}|{start_at_sec}|{duration_sec}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _preview_clip_path(user_id: int, clip_id: str) -> Path:
    return _ensure_preview_cache_dir() / f"u{user_id}_{clip_id}.mp4"


def _clip_not_expired(path: Path) -> bool:
    if not path.exists() or not path.is_file():
        return False
    age = max(0.0, time.time() - path.stat().st_mtime)
    return age <= _PREVIEW_CLIP_TTL_SEC


def _cleanup_preview_clip_cache() -> None:
    """Remove expired clips, then trim oldest files until under the byte
    budget. Best-effort — silently ignores per-file errors so a flaky
    file never breaks an unrelated request."""
    cache = _ensure_preview_cache_dir()
    now = time.time()
    files: List[Path] = [p for p in cache.glob("*.mp4") if p.is_file()]
    for p in files:
        try:
            if (now - p.stat().st_mtime) > _PREVIEW_CLIP_TTL_SEC:
                p.unlink(missing_ok=True)
        except Exception:
            continue
    files = [p for p in cache.glob("*.mp4") if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    if total <= _PREVIEW_CLIP_MAX_BYTES:
        return
    files.sort(key=lambda p: p.stat().st_mtime)
    for p in files:
        if total <= _PREVIEW_CLIP_MAX_BYTES:
            break
        try:
            sz = p.stat().st_size
            p.unlink(missing_ok=True)
            total = max(0, total - sz)
        except Exception:
            continue


def _generate_preview_clip(
    source_url: str, output_path: Path, start_at_sec: int, duration_sec: int,
) -> None:
    """Run ffmpeg to extract a short H.264/AAC clip starting at
    `start_at_sec` for `duration_sec`. Writes to `output_path`. Raises
    HTTPException on timeout / non-zero exit / empty output."""
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise HTTPException(status_code=503, detail="ffmpeg not available on server")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink(missing_ok=True)

    cmd = [
        ffmpeg_bin, "-y",
        "-ss", str(start_at_sec),
        "-i", source_url,
        "-t", str(duration_sec),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-ac", "2", "-b:a", "128k",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(output_path),
    ]
    logger.info(
        "[preview-clip] ffmpeg start stream=%s start=%ss duration=%ss out=%s",
        _safe_stream_ref(source_url), start_at_sec, duration_sec, output_path.name,
    )
    try:
        proc = subprocess.run(
            cmd, check=False, capture_output=True, text=True,
            timeout=_FFMPEG_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired as exc:
        logger.warning(
            "[preview-clip] ffmpeg timeout stream=%s",
            _safe_stream_ref(source_url),
        )
        raise HTTPException(status_code=504, detail="preview clip generation timed out") from exc
    except Exception as exc:
        logger.exception("[preview-clip] ffmpeg execution error stream=%s", _safe_stream_ref(source_url))
        raise HTTPException(status_code=502, detail=f"preview clip generation failed: {exc}") from exc

    if proc.returncode != 0 or not output_path.exists() or output_path.stat().st_size <= 0:
        stderr = (proc.stderr or "").strip()
        if len(stderr) > 700:
            stderr = stderr[:700] + "..."
        logger.warning(
            "[preview-clip] ffmpeg failed code=%s stream=%s stderr=%s",
            proc.returncode, _safe_stream_ref(source_url), stderr or "unknown",
        )
        raise HTTPException(
            status_code=502,
            detail=f"ffmpeg failed (code={proc.returncode}): {stderr or 'unknown error'}",
        )
    logger.info(
        "[preview-clip] ffmpeg ok stream=%s out=%s size=%s",
        _safe_stream_ref(source_url), output_path.name, output_path.stat().st_size,
    )


# ── Preview-clip endpoints ──────────────────────────────────────────────────

@router.get("/preview-clip", response_model=PreviewClipResponse)
def get_preview_clip(
    request: Request,
    url: str = Query(..., description="Absolute donor source URL to clip"),
    type: Optional[Literal["movie", "series"]] = Query(None),
    start_at_sec: Optional[int] = Query(None, ge=0,
        description="Debug-only override (requires PREVIEW_CLIP_ALLOW_DEBUG_START=true)"),
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    del type   # reserved for future per-type cache tuning
    user = _resolve_user(authorization, token, db)

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=422, detail="invalid preview source url")

    selected_start = _pick_preview_start_at(start_at_sec)
    duration = _PREVIEW_CLIP_DURATION_SEC
    clip_id = _preview_clip_id(user.id, url, selected_start, duration)
    clip_path = _preview_clip_path(user.id, clip_id)
    cached = _clip_not_expired(clip_path)

    logger.info(
        "[preview-clip] request user=%s(id=%d) stream=%s start=%ss cached=%s",
        user.username, user.id, _safe_stream_ref(url), selected_start, cached,
    )

    if not cached:
        _generate_preview_clip(
            source_url=url, output_path=clip_path,
            start_at_sec=selected_start, duration_sec=duration,
        )
        _cleanup_preview_clip_cache()

    effective_token = token or (
        authorization[7:].strip()
        if authorization and authorization.lower().startswith("bearer ") else ""
    )
    qs = f"?token={quote(effective_token, safe='')}" if effective_token else ""
    expires_at = int(clip_path.stat().st_mtime + _PREVIEW_CLIP_TTL_SEC)
    return PreviewClipResponse(
        clip_url=f"/api/v1/user/preview-clip/file/{clip_id}{qs}",
        start_at_sec=selected_start,
        duration_sec=duration,
        cached=cached,
        expires_at=expires_at,
    )


@router.get("/preview-clip/file/{clip_id}")
def get_preview_clip_file(
    clip_id: str,
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    user = _resolve_user(authorization, token, db)
    if not clip_id.isalnum():
        raise HTTPException(status_code=400, detail="invalid clip id")
    clip_path = _preview_clip_path(user.id, clip_id)
    if not _clip_not_expired(clip_path):
        if clip_path.exists():
            clip_path.unlink(missing_ok=True)
        raise HTTPException(status_code=404, detail="preview clip not found or expired")
    return FileResponse(
        path=str(clip_path),
        media_type="video/mp4",
        filename=clip_path.name,
        headers={"Cache-Control": f"private, max-age={_PREVIEW_CLIP_TTL_SEC}"},
    )
