import threading

from src.services.job_locks import exclusive, is_running


def test_second_run_is_skipped_while_first_runs():
    started, release = threading.Event(), threading.Event()
    calls = []

    @exclusive("t-group")
    def job(pid):
        calls.append(pid)
        started.set()
        release.wait(5)
        return "done"

    t = threading.Thread(target=job, args=(1,))
    t.start()
    started.wait(5)
    assert is_running("t-group", 1)
    assert job(1) == {"provider_id": 1, "skipped": "t-group already running"}
    assert not is_running("t-group", 2)          # other provider unaffected
    release.set(); t.join(5)
    assert not is_running("t-group", 1)
    assert calls == [1]


def test_reentrant_in_same_thread():
    @exclusive("t-re")
    def inner(pid):
        return "inner"

    @exclusive("t-re")
    def outer(pid):
        return inner(pid)        # details -> tmdb chain shape

    assert outer(7) == "inner"
