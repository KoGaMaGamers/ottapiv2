"""
User Authentication Service

Creates and verifies HMAC-signed session tokens for registered IPTVUsers.

Token format:
    base64url({username}:{unix_timestamp}).{sha256_hmac}

Tokens are stateless — no token store needed.  Expiry is enforced by
comparing the embedded timestamp to the current time.
"""

import hmac as _hmac
import hashlib
import base64
import os
import time
from typing import Optional

from sqlalchemy.orm import Session

from ..models import IPTVUser

# 30-day session lifetime
SESSION_MAX_AGE = 60 * 60 * 24 * 30


def _get_secret() -> bytes:
    """Return the HMAC signing secret from environment."""
    secret = os.getenv("SECRET_KEY", "") or os.getenv("ADMIN_SECRET", "")
    if not secret:
        secret = "change-me-in-production"
    return secret.encode("utf-8")


def create_user_token(username: str) -> str:
    """
    Create a signed session token for ``username``.

    Returns a dot-separated string:  ``<base64_payload>.<hex_signature>``
    """
    payload = f"{username}:{int(time.time())}"
    payload_b64 = base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")
    sig = _hmac.new(
        _get_secret(),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{payload_b64}.{sig}"


def verify_user_token(token: str) -> Optional[str]:
    """
    Verify the token signature and expiry.

    Returns the ``username`` embedded in the token if valid, else ``None``.
    """
    if not token or "." not in token:
        return None
    payload_b64, sig = token.rsplit(".", 1)
    expected_sig = _hmac.new(
        _get_secret(),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not _hmac.compare_digest(sig, expected_sig):
        return None
    try:
        payload = base64.urlsafe_b64decode(payload_b64.encode("ascii")).decode("utf-8")
        username, ts = payload.split(":", 1)
        if time.time() - int(ts) > SESSION_MAX_AGE:
            return None
        return username
    except Exception:
        return None


def get_user_from_token(token: str, db: Session) -> Optional[IPTVUser]:
    """Look up an ``IPTVUser`` by a verified session token."""
    username = verify_user_token(token)
    if not username:
        return None
    return db.query(IPTVUser).filter(IPTVUser.username == username).first()
