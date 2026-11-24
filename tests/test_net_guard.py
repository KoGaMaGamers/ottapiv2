import pytest
from fastapi import HTTPException

from src.services.net_guard import assert_public_url, is_public_url


@pytest.mark.parametrize("url", [
    "http://127.0.0.1:8011/health",
    "http://localhost/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.17.0.1/",
    "http://[::1]/",
    "http://0.0.0.0/",
    "file:///etc/passwd",
    "gopher://example.com/",
])
def test_blocks_non_public(url):
    assert not is_public_url(url)


def test_allows_public_ip_literal():
    assert is_public_url("http://1.1.1.1/player_api.php")


def test_unresolvable_host_is_not_blocked():
    # nothing to connect to -> the real request fails normally
    assert is_public_url("http://does-not-exist.invalid/")


def test_assert_raises_codes():
    with pytest.raises(HTTPException) as e:
        assert_public_url("http://127.0.0.1/")
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        assert_public_url("ftp://x/")
    assert e.value.status_code == 422
