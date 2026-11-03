"""Login dead-domain fallback + log redaction.

Runs on in-memory SQLite with only the tables login touches; all provider
HTTP is faked at requests.get.
"""

import logging
import os

import pytest
import requests
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("SECRET_KEY", "test-secret")

from src.database import Base  # noqa: E402
from src.log_redact import RedactingFilter, redact  # noqa: E402
from src.models import IPTVUser, ProviderDnsEntry, XtreamProvider  # noqa: E402
from src.routers import auth  # noqa: E402

DEAD = "http://likane.cc"
LIVE = "http://zibak.ru"


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(
        engine,
        tables=[XtreamProvider.__table__, IPTVUser.__table__, ProviderDnsEntry.__table__],
    )
    session = sessionmaker(bind=engine)()
    provider = XtreamProvider(id=1, base_url=LIVE, is_populated=True)
    session.add(provider)
    session.flush()
    session.add(IPTVUser(
        id=26, username="alice", password="pw", provider_id=1,
        base_url="http://jigjqbtv.sidiman.com", is_active=True,
    ))
    session.add_all([
        ProviderDnsEntry(provider_id=1, domain="likane.cc", is_healthy=False),
        ProviderDnsEntry(provider_id=1, domain="zibak.ru", is_healthy=True),
        ProviderDnsEntry(provider_id=1, domain="sidiman.com", is_healthy=True),
    ])
    session.commit()
    yield session
    session.close()


class _Resp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"{self.status_code}")

    def json(self):
        return self._payload


def _ok(auth_flag=1):
    return _Resp({"user_info": {"auth": auth_flag, "status": "Active"}, "server_info": {}})


@pytest.fixture
def fake_hosts(monkeypatch):
    """Map host prefix -> response factory; unknown hosts fail DNS."""
    routes = {}
    calls = []

    def fake_get(url, params=None, **kw):
        calls.append(url)
        for prefix, fn in routes.items():
            if url.startswith(prefix):
                return fn()
        raise requests.exceptions.ConnectionError(
            f"Failed to resolve; url: /player_api.php?username={params['username']}"
            f"&password={params['password']}"
        )

    monkeypatch.setattr("src.services.xtream_client.requests.get", fake_get)
    monkeypatch.setattr(auth, "trigger_provider_sync", lambda pid: False)
    return routes, calls


def _req(base_url=DEAD, username="alice", password="pw"):
    return auth.LoginRequest(base_url=base_url, username=username, password=password)


def test_dead_domain_falls_back_to_working_domain(db, fake_hosts, caplog):
    routes, calls = fake_hosts
    routes[LIVE] = _ok
    with caplog.at_level(logging.WARNING):
        resp = auth.login(_req(), db)
    assert resp.base_url == LIVE
    assert resp.user_id == 26 and resp.provider_id == 1 and not resp.is_new_user
    assert calls[0].startswith(DEAD) and calls[1].startswith(LIVE)
    assert "likane.cc -> http://zibak.ru" in caplog.text and "provider_id=1" in caplog.text
    # Login still doesn't mutate the user row.
    assert db.get(IPTVUser, 26).base_url == "http://jigjqbtv.sidiman.com"


def test_falls_through_to_users_own_host_when_brand_domain_down(db, fake_hosts):
    routes, _ = fake_hosts
    routes["http://jigjqbtv.sidiman.com"] = _ok
    resp = auth.login(_req(), db)
    assert resp.base_url == "http://jigjqbtv.sidiman.com"


def test_no_alternative_keeps_502(db, fake_hosts):
    with pytest.raises(HTTPException) as e:
        auth.login(_req(), db)
    assert e.value.status_code == 502


def test_unknown_user_on_dead_host_gets_no_fallback(db, fake_hosts):
    routes, calls = fake_hosts
    routes[LIVE] = _ok
    with pytest.raises(HTTPException) as e:
        auth.login(_req(username="stranger"), db)
    assert e.value.status_code == 502
    assert len(calls) == 1


def test_credential_rejection_unchanged(db, fake_hosts):
    routes, calls = fake_hosts
    routes[LIVE] = lambda: _ok(auth_flag=0)
    with pytest.raises(HTTPException) as e:
        auth.login(_req(base_url=LIVE), db)
    assert e.value.status_code == 401
    assert len(calls) == 1  # host answered: no fallback attempted


def test_credential_rejection_on_fallback_host_is_401(db, fake_hosts):
    routes, _ = fake_hosts
    routes[LIVE] = lambda: _ok(auth_flag=0)
    with pytest.raises(HTTPException) as e:
        auth.login(_req(), db)
    assert e.value.status_code == 401


def test_http_error_does_not_trigger_fallback(db, fake_hosts):
    routes, calls = fake_hosts
    routes["http://jigjqbtv.sidiman.com"] = lambda: _Resp({}, status=503)
    routes[LIVE] = _ok
    with pytest.raises(HTTPException) as e:
        auth.login(_req(base_url="http://jigjqbtv.sidiman.com"), db)
    assert e.value.status_code == 502
    assert len(calls) == 1


def test_working_host_unchanged_path(db, fake_hosts):
    routes, calls = fake_hosts
    routes[LIVE] = _ok
    resp = auth.login(_req(base_url=LIVE), db)
    assert resp.base_url == LIVE and len(calls) == 1


def test_redact_both_url_forms():
    s = ("GET /player_api.php?username=U1&password=P1 and "
         "http://h.example/live/U1/P1/56644.m3u8 /movie/U1/P1/9.mkv")
    out = redact(s)
    assert "U1" not in out and "P1" not in out
    assert "/live/***/***/56644.m3u8" in out and "username=***&password=***" in out


def test_xtream_error_log_is_redacted(db, fake_hosts, caplog):
    with caplog.at_level(logging.ERROR):
        with pytest.raises(HTTPException):
            auth.login(_req(password="s3cr3t"), db)
    assert "s3cr3t" not in caplog.text


def test_filter_redacts_args_and_tracebacks():
    rec = logging.LogRecord("x", logging.INFO, __file__, 1, "url=%s", ("/live/u/p/1.ts",), None)
    RedactingFilter().filter(rec)
    assert rec.getMessage() == "url=/live/***/***/1.ts"
