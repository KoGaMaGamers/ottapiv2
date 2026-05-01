#!/home/ottapi/.venv/bin/python
"""Dump the upcoming sport_events rows so the skill can dedupe.

Used by the skill's Step 0: before doing any web research, claude
reads this list and skips events that are already curated (matched by
home/away teams + start date, or by title for non-team events). Saves
budget AND avoids batch-pointer churn that would invalidate composite
cover JPGs already on disk.

Output: JSON array, one object per upcoming event. Empty array when
the table is empty / pointer is unset.

Run:
    .claude/skills/sport-events/scripts/current_events.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime

from _db import KvSettings, SessionLocal, SportEvent


POINTER_KEY = "sport_events_current_batch"


def main() -> int:
    db = SessionLocal()
    try:
        ptr = db.query(KvSettings).filter(KvSettings.key == POINTER_KEY).first()
        if ptr is None:
            json.dump([], sys.stdout)
            sys.stdout.write("\n")
            return 0
        try:
            current_batch = int(ptr.value)
        except (TypeError, ValueError):
            json.dump([], sys.stdout)
            sys.stdout.write("\n")
            return 0

        now = datetime.utcnow()
        rows = (
            db.query(SportEvent)
            .filter(SportEvent.batch_id == current_batch)
            .filter(SportEvent.end_utc > now)
            .order_by(SportEvent.start_utc.asc())
            .all()
        )
        out = [
            {
                "title":            ev.title,
                "sport":            ev.sport,
                "league":           ev.league,
                "home_team":        ev.home_team,
                "away_team":        ev.away_team,
                "start_utc":        ev.start_utc.isoformat() + "Z",
                "broadcaster_name": ev.broadcaster_name,
            }
            for ev in rows
        ]
        json.dump(out, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
