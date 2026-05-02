"""Shared admin auth dependency for the browser-friendly admin pages.

Accepts EITHER:
  * `X-Admin-Secret: <secret>`            — for curl / scripts
  * `Authorization: Basic base64(:secret)`— for the browser dashboard

The username field on Basic is ignored; the secret is the password. This
keeps the surface tiny (no login form, no session table, no cookies)
while still letting the operator click around in a browser without
pasting headers.
"""

from __future__ import annotations

import base64
import hmac
from typing import Optional

from fastapi import Header, HTTPException

from ..config import ADMIN_SECRET


_BASIC_REALM = 'Basic realm="ottapi-admin"'


def require_admin(
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
    authorization: Optional[str] = Header(default=None),
) -> None:
    if not ADMIN_SECRET:
        raise HTTPException(status_code=503, detail="ADMIN_SECRET not configured")

    if x_admin_secret and hmac.compare_digest(x_admin_secret, ADMIN_SECRET):
        return

    if authorization and authorization.lower().startswith("basic "):
        try:
            decoded = base64.b64decode(authorization[6:]).decode("utf-8", "ignore")
            _, _, pw = decoded.partition(":")
            if pw and hmac.compare_digest(pw, ADMIN_SECRET):
                return
        except (ValueError, UnicodeDecodeError):
            pass

    raise HTTPException(
        status_code=401,
        detail="Unauthorized",
        headers={"WWW-Authenticate": _BASIC_REALM},
    )
