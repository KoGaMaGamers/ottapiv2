"""Driver for the sport-events curation pipeline.

Shells out to `claude -p` running the project's `sport-events` Skill,
which assembles a batch of upcoming live sport events and pipes the
result into the ingest helper. We capture stdout/stderr, record a
SportEventsRun row for visibility, and let APScheduler (or the admin
trigger) call us at any time — `max_instances=1` on the job def
prevents collisions.

All cost is intentionally uncapped; quality of the curation is the
priority. The hard guards are the subprocess timeout and the
`--max-turns` flag.
"""

from __future__ import annotations

import logging
import os
import subprocess
from datetime import datetime
from typing import Optional

from ..config import (
    ANTHROPIC_API_KEY,
    CLAUDE_BIN,
    CLAUDE_SUBPROCESS_TIMEOUT_SEC,
    SPORT_EVENTS_STATIC_DIR,
)
from ..database import SessionLocal
from ..models import SportEventsRun

logger = logging.getLogger(__name__)

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _record_run(triggered_by: str) -> Optional[int]:
    db = SessionLocal()
    try:
        row = SportEventsRun(
            started_at=datetime.utcnow(),
            status="running",
            triggered_by=triggered_by,
        )
        db.add(row)
        db.commit()
        return row.id
    except Exception:
        db.rollback()
        logger.exception("failed to insert sport_events_runs row")
        return None
    finally:
        db.close()


def _finalize_run(run_id: Optional[int], status: str, error: Optional[str], events_written: int) -> None:
    if run_id is None:
        return
    db = SessionLocal()
    try:
        row = db.query(SportEventsRun).filter(SportEventsRun.id == run_id).first()
        if row is None:
            return
        row.finished_at = datetime.utcnow()
        row.status = status
        row.events_written = events_written
        if error is not None:
            row.error = error[-2000:]
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("failed to finalize sport_events_runs row %s", run_id)
    finally:
        db.close()


def run_sport_events_refresh(triggered_by: str = "schedule", dry_run: bool = False) -> None:
    """Invoke `claude -p` to refresh the sport_events table.

    Called by APScheduler on its periodic cadence and by the admin
    trigger endpoint on demand. `dry_run=True` instructs the skill to
    run the validation script (`dry_run.py`) instead of `ingest.py`.
    """
    if not ANTHROPIC_API_KEY:
        logger.warning("ANTHROPIC_API_KEY is empty — skipping sport-events refresh")
        return

    if not os.path.exists(CLAUDE_BIN):
        logger.error(
            "claude bin missing at %s — set CLAUDE_BIN env var", CLAUDE_BIN,
        )
        return

    os.makedirs(SPORT_EVENTS_STATIC_DIR, exist_ok=True)

    run_id = _record_run(triggered_by)

    prompt = (
        "Run the sport-events skill in dry-run mode (call dry_run.py "
        "instead of ingest.py)."
        if dry_run else
        "Run the sport-events skill."
    )

    cmd = [
        CLAUDE_BIN,
        "-p", prompt,
        "--bare",
        "--dangerously-skip-permissions",
        "--output-format", "json",
        "--max-turns", "40",
    ]

    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "ANTHROPIC_API_KEY": ANTHROPIC_API_KEY,
        "HOME": os.environ.get("HOME", "/root"),
        "SPORT_EVENTS_STATIC_DIR": SPORT_EVENTS_STATIC_DIR,
    }

    logger.info("sport-events refresh starting (dry_run=%s, triggered_by=%s)",
                dry_run, triggered_by)

    try:
        proc = subprocess.run(
            cmd,
            cwd=PROJECT_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=CLAUDE_SUBPROCESS_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        logger.error("sport-events refresh timed out after %ss",
                     CLAUDE_SUBPROCESS_TIMEOUT_SEC)
        _finalize_run(run_id, "failure",
                      f"timeout after {CLAUDE_SUBPROCESS_TIMEOUT_SEC}s", 0)
        return
    except Exception as e:
        logger.exception("sport-events subprocess error: %s", e)
        _finalize_run(run_id, "failure", str(e), 0)
        return

    if proc.returncode != 0:
        logger.warning(
            "sport-events refresh exit=%d\nstdout=%s\nstderr=%s",
            proc.returncode, proc.stdout[-500:], proc.stderr[-500:],
        )
        _finalize_run(run_id, "failure",
                      f"exit={proc.returncode}\nstderr={proc.stderr[-1000:]}",
                      0)
        return

    # Best-effort: parse the ingest summary from Claude's stdout. The
    # skill prints the script's JSON summary as its final assistant
    # message. We tolerate misses — the row's `events_written` stays
    # at 0 but status is success.
    events_written = 0
    try:
        import json as _json
        # `--output-format json` envelope contains the assistant text
        # in `result` field on stop. Different CLI versions have
        # subtly different envelopes — we just look for an inline
        # ingest summary.
        text = proc.stdout
        for marker in ('"events_written":',):
            idx = text.find(marker)
            if idx == -1:
                continue
            # Walk backward to find the start of the JSON object.
            start = text.rfind("{", 0, idx)
            if start == -1:
                continue
            # Walk forward braces to find a matching close.
            depth = 0
            for j in range(start, len(text)):
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            obj = _json.loads(text[start:j + 1])
                            events_written = int(obj.get("events_written", 0))
                        except Exception:
                            pass
                        break
            break
    except Exception:
        pass

    logger.info("sport-events refresh succeeded; events_written=%d", events_written)
    _finalize_run(run_id, "success", None, events_written)
