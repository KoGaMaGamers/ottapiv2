"""User-facing stream proxy.

Endpoints:

  GET /api/v1/user/stream-proxy?url=…&token=…
      Transport-level proxy for live/HLS preview URLs the WebView
      can't fetch directly (mixed content, CORS). Streams bytes
      through verbatim for non-HLS, rewrites M3U8 child URLs back
      through this proxy so the chain stays inside auth.

  GET /api/v1/user/preview-clip[/file/{clip_id}]
      DISABLED (410 Gone). The ffmpeg teaser generator was removed after
      orphaned encodes exhausted the API's memory cgroup (2026-11-25);
      the feature is being dropped from the client.

Auth: JWT either via `Authorization: Bearer …` (XHR / fetch) OR via a
`token=` query string (HTML media elements can't set headers). The
JWT identifies the *requester*, but the URL we fetch is already a
donor URL minted by `/api/v1/play/{kind}/{id}` or
`/api/v1/play/preview/{kind}/{id}` — this proxy / clipper is a
transport-level shim, it does NOT swap creds.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Optional
from urllib.parse import quote, urljoin, urlparse

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import IPTVUser
from ..services.auth_service import get_user_from_token
from ..services.net_guard import assert_public_url, is_public_url


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/user", tags=["streams"])


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



_MAX_REDIRECTS = 5


def _send_following_public_redirects(
    client: httpx.Client, method: str, url: str, headers: dict,
) -> httpx.Response:
    """client.send(stream=True) that follows redirects itself so every hop
    is checked against the SSRF guard (httpx's follow_redirects would not)."""
    for _ in range(_MAX_REDIRECTS + 1):
        resp = client.send(client.build_request(method, url, headers=headers), stream=True)
        if not resp.is_redirect:
            return resp
        location = resp.headers.get("location")
        resp.close()
        if not location:
            return resp
        url = urljoin(str(resp.url), location)
        if not is_public_url(url):
            raise HTTPException(status_code=403, detail="redirect destination not allowed")
    raise HTTPException(status_code=502, detail="too many upstream redirects")


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
    db.close()   # don't hold a pool connection for the whole stream

    assert_public_url(url)   # SSRF guard: no loopback / LAN / metadata targets

    # ALWAYS present a browser User-Agent to the provider CDN. The VOD CDN
    # (cloudvix/vexovrix…) resets connections from non-browser UAs (curl etc.),
    # so forwarding the client's UA is fragile — a stray non-browser UA (or one
    # altered by an intermediary proxy) makes the whole movie fail. The provider
    # only needs a browser-like UA; the real client identity is irrelevant here.
    fwd_headers = {
        "User-Agent":      _FALLBACK_UA,
        "Accept":          request.headers.get("accept") or "*/*",
        "Accept-Language": request.headers.get("accept-language") or "en-US,en;q=0.9",
    }
    if request.headers.get("range"):
        fwd_headers["Range"] = request.headers["range"]

    # Use a streaming client. We open a connection, optionally read+rewrite
    # the body if it's an HLS playlist, otherwise pipe the bytes through.
    method = request.method.upper()
    timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)

    # The provider's VOD CDN (cloudvix/vexovrix…) intermittently resets the
    # connection (Errno 104) / rate-limits the datacenter IP at connect time.
    # A single failure would surface as a 502 and stall the browser's <video>,
    # so retry the initial open a few times with a small backoff — the reset
    # happens before any body is sent, so a fresh attempt almost always
    # succeeds. (Live/HLS rarely hits this because each segment is re-requested;
    # progressive MP4 does, since one failed open kills the whole playback.)
    _MAX_TRIES = 3
    client = None
    upstream = None
    last_exc: Optional[Exception] = None
    for attempt in range(_MAX_TRIES):
        client = httpx.Client(follow_redirects=False, timeout=timeout)
        try:
            upstream = _send_following_public_redirects(
                client, method, url, fwd_headers,
            )
            break
        except httpx.RequestError as exc:
            last_exc = exc
            client.close()
            client = None
            if attempt < _MAX_TRIES - 1:
                time.sleep(0.4 * (attempt + 1))
    if upstream is None or client is None:
        logger.warning(
            "stream-proxy upstream error %s after %d tries: %s",
            url, _MAX_TRIES, last_exc,
        )
        raise HTTPException(status_code=502, detail="upstream unreachable") from last_exc

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
    out_headers["Access-Control-Expose-Headers"] = "Content-Range, Content-Length, Accept-Ranges"
    # The provider returns a non-standard Accept-Ranges (e.g. "0-838263481").
    # Browsers expect the token "bytes"; a malformed value can make a player
    # treat a moov-at-end MP4 as non-seekable and hang. Since the upstream does
    # honour Range (it answers 206 + Content-Range), advertise it correctly.
    for _k in [k for k in out_headers if k.lower() == "accept-ranges"]:
        out_headers.pop(_k, None)
    out_headers["Accept-Ranges"] = "bytes"

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


# ── Preview clips: disabled ─────────────────────────────────────────────────
# Card/hero teasers used to be cut server-side with ffmpeg. Each encode pulled a
# whole .mkv from the provider (~1.5 GB RSS) and outlived its worker when the
# worker died, which starved the API cgroup and took the API down (2026-11-25).
# The feature is being removed from the client; until then, answer instantly
# so old builds just skip the teaser (they don't retry on failure).

_PREVIEW_DISABLED = "preview clips are disabled"


@router.get("/preview-clip")
def get_preview_clip():
    raise HTTPException(status_code=410, detail=_PREVIEW_DISABLED)


@router.get("/preview-clip/file/{clip_id}")
def get_preview_clip_file(clip_id: str):
    del clip_id
    raise HTTPException(status_code=410, detail=_PREVIEW_DISABLED)
