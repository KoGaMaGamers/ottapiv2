"""Shared admin auth dependency for the browser-friendly admin pages.

Accepts EITHER:
  * `X-Admin-Secret: <secret>` matching `ADMIN_SECRET` — for curl / scripts.
  * `Authorization: Basic base64("user:password")` — for the browser
    dashboard. Password is matched against `ADMIN_PASSWORD` first
    (human-friendly, also paired with `ADMIN_USERNAME` if set), then
    falls back to `ADMIN_SECRET` (lets any old curl-style password
    keep working in a browser too). Username comparison is constant-
    time when ADMIN_USERNAME is set; otherwise the username field is
    ignored.

No login form, no session table, no cookies. The 401 response carries
`WWW-Authenticate: Basic` so browsers prompt natively.
"""

from __future__ import annotations

import base64
import hmac
from typing import Optional

from fastapi import Header, HTTPException

from ..config import ADMIN_PASSWORD, ADMIN_SECRET, ADMIN_USERNAME


_BASIC_REALM = 'Basic realm="ottapi-admin"'


def _basic_ok(authorization: str) -> bool:
    if not authorization.lower().startswith("basic "):
        return False
    try:
        decoded = base64.b64decode(authorization[6:]).decode("utf-8", "ignore")
    except (ValueError, UnicodeDecodeError):
        return False
    user, _, pw = decoded.partition(":")
    if not pw:
        return False

    # Preferred path: ADMIN_PASSWORD (+ optional ADMIN_USERNAME).
    if ADMIN_PASSWORD and hmac.compare_digest(pw, ADMIN_PASSWORD):
        if ADMIN_USERNAME and not hmac.compare_digest(user, ADMIN_USERNAME):
            return False
        return True

    # Fallback: secret-as-password. Username is ignored for back-compat
    # with the prior bootstrap flow (paste secret as password, no username).
    if ADMIN_SECRET and hmac.compare_digest(pw, ADMIN_SECRET):
        return True
    return False


def require_admin(
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
    authorization: Optional[str] = Header(default=None),
) -> None:
    if not (ADMIN_SECRET or ADMIN_PASSWORD):
        raise HTTPException(
            status_code=503,
            detail="Admin auth not configured (set ADMIN_PASSWORD and/or ADMIN_SECRET)",
        )

    if x_admin_secret and ADMIN_SECRET and hmac.compare_digest(x_admin_secret, ADMIN_SECRET):
        return

    if authorization and _basic_ok(authorization):
        return

    raise HTTPException(
        status_code=401,
        detail="Unauthorized",
        headers={"WWW-Authenticate": _BASIC_REALM},
    )
