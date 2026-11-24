from src.services.ratelimit import SlidingWindowLimiter


def test_limits_per_key_and_recovers(monkeypatch):
    t = [1000.0]
    monkeypatch.setattr("src.services.ratelimit.time.monotonic", lambda: t[0])
    lim = SlidingWindowLimiter(limit=2, window_sec=10)
    assert lim.allow("a") and lim.allow("a")
    assert not lim.allow("a")
    assert lim.allow("b")
    t[0] += 11
    assert lim.allow("a")


def test_key_table_is_bounded():
    lim = SlidingWindowLimiter(limit=1, window_sec=60, max_keys=50)
    for i in range(500):
        lim.allow(f"ip{i}")
    assert len(lim._hits) <= 50
