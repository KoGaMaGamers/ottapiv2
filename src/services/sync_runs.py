"""Record each background job run in ``sync_runs``.

The provider-1 catalog sync failed daily for ~7 weeks and nobody knew:
results were only logged (journald keeps ~7 days) and the scheduler
ignored the returned summary. ``tracked(phase)`` writes a row per run and
``/health/sync`` alerts on stale or failed runs.
"""

from __future__ import annotations

import functools
import json
import logging
from datetime import datetime
from typing import Any, Callable, Optional

from ..database import SessionLocal
from ..models import SyncRun

logger = logging.getLogger(__name__)

_MAX_ERRORS_STORED = 20


def _status_of(result: Any) -> str:
    if not isinstance(result, dict):
        return "ok"
    if result.get("skipped"):
        return "skipped"
    errors = result.get("errors") or []
    if any(str(e).startswith("unhandled") for e in errors) or result.get("failed_hard"):
        return "failed"
    if errors or result.get("circuit_open"):
        return "degraded"
    return "ok"


def _start(provider_id: Optional[int], phase: str) -> Optional[int]:
    db = SessionLocal()
    try:
        run = SyncRun(provider_id=provider_id, phase=phase, status="running",
                      started_at=datetime.utcnow())
        db.add(run)
        db.commit()
        return run.id
    except Exception:
        logger.exception("sync_runs: could not record start of %s", phase)
        return None
    finally:
        db.close()


def _finish(run_id: Optional[int], status: str, result: Any, error: Optional[str]) -> None:
    if run_id is None:
        return
    summary = None
    if isinstance(result, dict):
        trimmed = dict(result)
        if isinstance(trimmed.get("errors"), list):
            trimmed["errors_total"] = len(trimmed["errors"])
            trimmed["errors"] = trimmed["errors"][:_MAX_ERRORS_STORED]
        summary = json.dumps(trimmed, default=str)[:60000]
    db = SessionLocal()
    try:
        run = db.get(SyncRun, run_id)
        if run is not None:
            run.status = status
            run.finished_at = datetime.utcnow()
            run.summary = summary
            run.error = (error or "")[:4000] or None
            db.commit()
    except Exception:
        logger.exception("sync_runs: could not record finish of run %s", run_id)
    finally:
        db.close()


def tracked(phase: str) -> Callable:
    """Decorate ``fn(provider_id, ...) -> summary dict`` (provider_id may be
    omitted/None for global jobs such as the GoldenOTT sync)."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            provider_id = args[0] if args else kwargs.get("provider_id")
            run_id = _start(provider_id, phase)
            try:
                result = fn(*args, **kwargs)
            except Exception as exc:
                _finish(run_id, "failed", None, f"{type(exc).__name__}: {exc}")
                raise
            status = _status_of(result)
            _finish(run_id, status, result, None)
            if status == "failed":
                logger.error("%s run failed for provider %s: %s", phase, provider_id,
                             (result.get("errors") or [""])[0] if isinstance(result, dict) else "")
            return result
        return wrapper
    return deco
