"""User-facing stream proxy.

Proxies provider stream URLs through the backend so the WebView can
fetch them without hitting:
  * mixed-content blocks (app is HTTPS, donor URLs are HTTP),
  * CORS preflight failures,
  * cookie / referrer leakage from the WebView origin.

Auth: JWT either via `Authorization: Bearer …` (XHR / fetch) OR via a
`token=` query string (HTML media elements can't set headers). The
JWT identifies the *requester*, but the URL the proxy fetches is
already a donor URL minted by `/api/v1/play/{kind}/{id}` or
`/api/v1/play/preview/{kind}/{id}` — this proxy is purely a
transport-level shim, it does NOT swap creds.

For HLS playlists (.m3u8), child URLs (variant playlists + media
segments) are rewritten to also go through this proxy so the entire
HLS chain stays inside the auth'd path. For everything else the
upstream bytes are streamed back verbatim.
"""

from __future__ import annotations

import logging
import re
from typing import Optional
from urllib.parse import quote, urljoin, urlparse

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import IPTVUser
from ..services.auth_service import get_user_from_token


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
