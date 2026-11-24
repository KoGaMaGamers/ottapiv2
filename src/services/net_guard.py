"""Refuse server-side fetches to non-public destinations (SSRF guard).

Endpoints that fetch a client-supplied URL (stream-proxy, preview-clip,
login's provider probe) must not be usable to reach loopback, the LAN,
link-local / cloud metadata (169.254.169.254) or other reserved ranges.

Check every hop: callers that follow redirects must call
``assert_public_url`` on each Location before requesting it.
"""

from __future__ import annotations

import ipaddress
import socket
from typing import Optional
from urllib.parse import urlparse

from fastapi import HTTPException


def _host_is_public(host: str, port: Optional[int]) -> bool:
    try:
        infos = socket.getaddrinfo(host, port or 80, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        # Unresolvable: not an SSRF risk (nothing to connect to); let the
        # actual request fail with its normal network error.
        return True
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        if getattr(ip, "ipv4_mapped", None):
            ip = ip.ipv4_mapped
        if not ip.is_global or ip.is_multicast:
            return False
    return True


def is_public_url(url: str) -> bool:
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    try:
        port = p.port
    except ValueError:
        return False
    return _host_is_public(p.hostname, port)


def assert_public_url(url: str) -> None:
    """Raise 422 for malformed URLs and 403 for non-public destinations."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise HTTPException(status_code=422, detail="invalid url")
    if not is_public_url(url):
        raise HTTPException(status_code=403, detail="destination not allowed")
