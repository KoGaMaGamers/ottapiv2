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


_INSECURE_DEFAULT = "change-me-in-production"


def _get_secret() -> bytes:
    """Return the HMAC signing secret from environment.

    Refuses to sign/verify with the old hard-coded fallback: a missing
    SECRET_KEY must be a startup failure, not silently forgeable tokens.
    """
    secret = os.getenv("SECRET_KEY", "") or os.getenv("ADMIN_SECRET", "")
    if not secret or secret == _INSECURE_DEFAULT:
        raise RuntimeError("SECRET_KEY (or ADMIN_SECRET) must be set in .env")
    return secret.encode("utf-8")


def assert_secret_configured() -> None:
    """Call at startup so a missing secret fails fast."""
    _get_secret()


def create_user_token(username: str, token_version: int = 0) -> str:
    """
    Create a signed session token for ``username``.

    Returns ``<base64_payload>.<hex_signature>``; payload is
    ``username:issued_ts:token_version``.
    """
    payload = f"{username}:{int(time.time())}:{int(token_version or 0)}"
    payload_b64 = base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")
    sig = _hmac.new(
        _get_secret(),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{payload_b64}.{sig}"


def verify_user_token(token: str) -> Optional[tuple[str, int]]:
    """
    Verify the token signature and expiry.

    Returns ``(username, token_version)`` if the signature and age are
    valid, else ``None``.
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
        username, ts, version = _parse_payload(payload)
        if time.time() - ts > SESSION_MAX_AGE:
            return None
        return username, version
    except Exception:
        return None


def _parse_payload(payload: str) -> tuple[str, int, int]:
    # New: "username:ts:version". Legacy (pre token_version): "username:ts"
    # -> version 0. Usernames never contain ':' (Xtream usernames).
    parts = payload.split(":")
    if len(parts) == 3:
        return parts[0], int(parts[1]), int(parts[2])
    username, ts = payload.split(":", 1)
    return username, int(ts), 0


def get_user_from_token(token: str, db: Session) -> Optional[IPTVUser]:
    """Look up an ``IPTVUser`` by a verified session token."""
    verified = verify_user_token(token)
    if not verified:
        return None
    username, version = verified
    user = db.query(IPTVUser).filter(IPTVUser.username == username).first()
    if user is None or user.is_active is False:
        return None
    if version != int(user.token_version or 0):
        return None   # revoked (admin disabled the user / revoked sessions)
    return user
