from src.log_redact import redact


def test_query_credentials():
    out = redact("GET http://p.cc/player_api.php?username=U1&password=P1&action=x")
    assert "U1" not in out and "P1" not in out and "action=x" in out


def test_session_token_and_api_key():
    out = redact('"GET /api/v1/user/stream-proxy?url=x&token=abc.def123 HTTP/1.1" 200')
    assert "abc.def123" not in out and "HTTP/1.1" in out
    assert "KEY9" not in redact("https://api.subdl.com/api/v1/subtitles?api_key=KEY9&tmdb_id=1")


def test_percent_encoded_url_param():
    line = ("GET /api/v1/user/stream-proxy?url=http%3A%2F%2Flumvo.cc%2Fplayer_api.php"
            "%3Fusername%3DSYQB3L%26password%3DSECRETPW%26action%3Dget_short_epg&token=T0K")
    out = redact(line)
    for secret in ("SYQB3L", "SECRETPW", "T0K"):
        assert secret not in out
    assert "get_short_epg" in out


def test_stream_paths_plain_and_encoded():
    assert "USR" not in redact("http://cdn.x/live/USR/PWD/123.m3u8")
    out = redact("url=http%3A%2F%2Fcdn.x%2Fmovie%2FUSR%2FPWD%2F99.mkv")
    assert "USR" not in out and "PWD" not in out and "99.mkv" in out
