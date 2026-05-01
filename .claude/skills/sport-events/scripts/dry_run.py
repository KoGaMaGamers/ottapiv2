#!/home/ottapi/.venv/bin/python
"""Dry-run validation of a sport-events JSON document.

Same input shape as ingest.py, but does no DB writes and no cover
composition — just reports what would have been ingested vs dropped
and why. Useful both during initial development and as the
{"dry_run": true} branch of the admin trigger endpoint.

Run:
    cat events.json | python3 .claude/skills/sport-events/scripts/dry_run.py
"""

from __future__ import annotations

import json
import sys
from datetime import timedelta
from typing import Any

from pydantic import ValidationError

from ingest import (
    HTTP_HEADERS,  # noqa: F401  (kept for reference)
    IngestPayload,
    WINDOW_MAX,
    WINDOW_MIN,
    _head_ok,
    _now_utc,
    _to_utc_naive,
)


def main() -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        json.dump({"error": f"invalid JSON on stdin: {e}"}, sys.stdout)
        sys.stdout.write("\n")
        return 1

    try:
        payload = IngestPayload.model_validate(data)
    except ValidationError as e:
        json.dump({"error": "validation failed", "details": e.errors()}, sys.stdout)
        sys.stdout.write("\n")
        return 1

    now = _now_utc()
    min_start = now - WINDOW_MIN
    max_start = now + WINDOW_MAX

    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []

    for ev in payload.events:
        why = []
        start = _to_utc_naive(ev.start_utc)
        end = _to_utc_naive(ev.end_utc) or (start + timedelta(hours=2))
        if start is None:
            why.append("missing start_utc")
        elif end < min_start:
            why.append("event already ended")
        elif start > max_start:
            why.append("event further than 14 days out")

        if not _head_ok(ev.source_url):
            why.append("source_url unreachable")

        cover_ok = _head_ok(ev.cover_url) if ev.cover_url else False
        if not cover_ok:
            if ev.home_team_logo_url and ev.away_team_logo_url:
                if not _head_ok(ev.home_team_logo_url):
                    why.append("home_team_logo_url unreachable")
                if not _head_ok(ev.away_team_logo_url):
                    why.append("away_team_logo_url unreachable")
            else:
                why.append("no cover and no team-logo fallback")

        bs = ev.resolved_broadcasters()
        record = {
            "title":              ev.title,
            "broadcaster_count":  len(bs),
            "broadcasters":       [
                f"{b.name}{(' (' + b.country + ')') if b.country else ''}"
                for b in bs
            ],
            "start_utc":          ev.start_utc.isoformat() if ev.start_utc else None,
            "cover_path":         "cover_url" if cover_ok else (
                "compose"
                if (ev.home_team_logo_url and ev.away_team_logo_url
                    and not why)
                else "drop"
            ),
        }
        if not bs:
            why.append("no broadcasters provided")
        if why:
            record["reasons"] = why
            rejected.append(record)
        else:
            accepted.append(record)

    out = {
        "would_accept": accepted,
        "would_reject": rejected,
        "totals": {"accept": len(accepted), "reject": len(rejected)},
    }
    json.dump(out, sys.stdout, default=str)
    sys.stdout.write("\n")
    return 0 if accepted else 2


if __name__ == "__main__":
    sys.exit(main())
