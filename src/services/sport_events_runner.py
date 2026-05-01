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

    Auth: this server runs Claude on a Max plan whose OAuth token
    lives in the invoking user's `~/.claude/`. The subprocess
    inherits the parent's env (incl. `HOME`) so claude finds the
    creds without us needing to pass `ANTHROPIC_API_KEY`.
    """
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

    # Explicit allowed-tools (mirrors SKILL.md frontmatter). Claude
    # refuses `--dangerously-skip-permissions` when running as root,
    # which the runner's installation context requires; the explicit
    # whitelist is functionally equivalent and survives that check.
    skill_dir = os.path.join(PROJECT_ROOT, ".claude", "skills", "sport-events", "scripts")
    allowed_tools = ",".join([
        "WebSearch",
        "WebFetch",
        f"Bash({skill_dir}/list_channels.py)",
        f"Bash({skill_dir}/current_events.py)",
        f"Bash({skill_dir}/ingest.py)",
        f"Bash({skill_dir}/dry_run.py)",
        # Heredoc / piping wrappers Claude may need to feed JSON to ingest.
        "Bash(cat)",
        "Bash(echo *)",
    ])

    cmd = [
        CLAUDE_BIN,
        "-p", prompt,
        "--allowed-tools", allowed_tools,
        "--output-format", "json",
        # Multi-step web research → 40 was too tight; allow up to 80
        # so list_channels → 5+ WebFetches → ingest fits comfortably.
        "--max-turns", "80",
    ]

    # Inherit the parent process env so claude can read its OAuth
    # config from $HOME/.claude/. Do not pass --bare (it strips that
    # config). Add the static dir + project root for the skill.
    env = os.environ.copy()
    env.setdefault("SPORT_EVENTS_STATIC_DIR", SPORT_EVENTS_STATIC_DIR)

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
    # Surface a tail of claude's output to journal so dry-runs (which
    # report via dry_run.py's would_accept/would_reject summary, not
    # events_written) and unusual successes are still inspectable.
    if proc.stdout:
        logger.info("sport-events stdout tail: %s", proc.stdout[-1500:])
    _finalize_run(run_id, "success", None, events_written)


# ---------------------------------------------------------------------------
# Standalone cleanup — fires from its own systemd timer between refreshes
# so finished events disappear from the hero within an hour of ending,
# even if the next refresh is still days away.
# ---------------------------------------------------------------------------

def sweep_finished_events() -> int:
    """Two-part sweep, run hourly by the cleanup timer:

      1. Delete sport_events rows whose `end_utc` has passed.
      2. Delete rows from STALE batches (batch_id < current_batch - 1).
         Stale batches happen when Claude calls ingest.py twice in one
         session — only the latest batch is user-visible (the read
         endpoint filters on current_batch), older ones are cruft.

    Composite-cover JPGs for deleted rows are unlinked from disk in
    the same step. Idempotent — safe to run as often as wanted.
    """
    from datetime import datetime as _dt
    db = SessionLocal()
    n = 0
    try:
        from ..models import SportEvent, KvSettings
        # Pointer (may not exist if ingest never ran).
        ptr_row = (
            db.query(KvSettings)
            .filter(KvSettings.key == "sport_events_current_batch")
            .first()
        )
        try:
            current_batch = int(ptr_row.value) if ptr_row else 0
        except (TypeError, ValueError):
            current_batch = 0

        # Doomed = finished events OR stale-batch events. We keep
        # `current_batch` and `current_batch - 1` for rollback safety.
        keep_batches = {current_batch, current_batch - 1}
        doomed = (
            db.query(SportEvent)
            .filter(
                (SportEvent.end_utc < _dt.utcnow())
                | (~SportEvent.batch_id.in_(keep_batches))
            )
            .all()
        )
        # /static/ root holds both composite covers (sport-events/) and
        # mirrored remote covers (sport-covers/). Unlink whichever the
        # row points at.
        static_root = os.path.dirname(SPORT_EVENTS_STATIC_DIR.rstrip("/"))
        covers_dir = os.path.join(static_root, "sport-covers")
        for ev in doomed:
            if ev.cover_url:
                if ev.cover_url.startswith("/static/sport-events/"):
                    disk_dir = SPORT_EVENTS_STATIC_DIR
                elif ev.cover_url.startswith("/static/sport-covers/"):
                    disk_dir = covers_dir
                else:
                    disk_dir = None
                if disk_dir:
                    disk = os.path.join(disk_dir, os.path.basename(ev.cover_url))
                    try:
                        os.unlink(disk)
                    except OSError:
                        pass
            db.delete(ev)
            n += 1
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("sweep_finished_events failed")
        return 0
    finally:
        db.close()
    if n:
        logger.info("swept %d finished/stale sport event(s)", n)
    return n


# ---------------------------------------------------------------------------
# CLI entrypoint — fires from systemd timer
# ---------------------------------------------------------------------------

def _main() -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="sport_events_runner")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_refresh = sub.add_parser("refresh", help="Invoke claude -p to repopulate the table")
    p_refresh.add_argument("--dry-run", action="store_true",
                           help="Run dry_run.py instead of ingest.py (no DB writes)")
    p_refresh.add_argument("--triggered-by", default="systemd",
                           help="Tag for the sport_events_runs row")
    sub.add_parser("cleanup", help="Delete events whose end_utc has passed")
    args = ap.parse_args()

    if args.cmd == "refresh":
        run_sport_events_refresh(triggered_by=args.triggered_by, dry_run=args.dry_run)
    elif args.cmd == "cleanup":
        sweep_finished_events()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
