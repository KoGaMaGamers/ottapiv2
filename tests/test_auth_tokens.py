import base64
import hashlib
import hmac
import time
from types import SimpleNamespace

import pytest

from src.services import auth_service as a


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "test-secret")
    monkeypatch.delenv("ADMIN_SECRET", raising=False)


def _legacy_token(username, ts=None):
    payload = f"{username}:{int(ts or time.time())}"
    b64 = base64.urlsafe_b64encode(payload.encode()).decode()
    sig = hmac.new(b"test-secret", b64.encode(), hashlib.sha256).hexdigest()
    return f"{b64}.{sig}"


class _DB:
    def __init__(self, user):
        self.user = user

    def query(self, *_):
        return self

    def filter(self, *_):
        return self

    def first(self):
        return self.user


def _user(**kw):
    base = dict(username="alice", is_active=True, token_version=0)
    base.update(kw)
    return SimpleNamespace(**base)


def test_roundtrip_with_version():
    tok = a.create_user_token("alice", 3)
    assert a.verify_user_token(tok) == ("alice", 3)


def test_legacy_token_is_version_zero_and_still_valid():
    assert a.get_user_from_token(_legacy_token("alice"), _DB(_user())) is not None


def test_revoked_after_version_bump():
    tok = a.create_user_token("alice", 0)
    assert a.get_user_from_token(tok, _DB(_user(token_version=1))) is None


def test_inactive_user_rejected():
    tok = a.create_user_token("alice", 0)
    assert a.get_user_from_token(tok, _DB(_user(is_active=False))) is None


def test_expired_and_tampered():
    assert a.verify_user_token(_legacy_token("alice", time.time() - a.SESSION_MAX_AGE - 5)) is None
    tok = a.create_user_token("alice")
    assert a.verify_user_token(tok[:-1] + ("0" if tok[-1] != "0" else "1")) is None


def test_missing_or_default_secret_refused(monkeypatch):
    monkeypatch.delenv("SECRET_KEY")
    with pytest.raises(RuntimeError):
        a.create_user_token("alice")
    monkeypatch.setenv("SECRET_KEY", "change-me-in-production")
    with pytest.raises(RuntimeError):
        a.assert_secret_configured()
