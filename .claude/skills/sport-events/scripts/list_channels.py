#!/home/ottapi/.venv/bin/python
"""List every live channel across every provider with normalized names.

Used by the sport-events skill so Claude can ground broadcaster
matching against real catalog rows rather than hallucination. Output
goes to stdout as a single JSON array; one row per channel.

Run:
    python3 .claude/skills/sport-events/scripts/list_channels.py
"""

from __future__ import annotations

import json
import sys

from _db import LiveStream, SessionLocal, XtreamProvider, normalize_channel_name


def main() -> int:
    db = SessionLocal()
    try:
        rows = (
            db.query(LiveStream, XtreamProvider)
            .join(XtreamProvider, LiveStream.provider_id == XtreamProvider.id)
            .all()
        )
        # Drop `###...###` rows defensively. Catalog sync already filters
        # them out at insert time, but a freshly-onboarded provider whose
        # first sync hasn't run yet could still leak some.
        out = [
            {
                "provider_id":     prov.id,
                "provider_name":   prov.name,
                "channel_id":      chan.id,
                "channel_name":    chan.name,
                "normalized_name": normalize_channel_name(chan.name),
            }
            for chan, prov in rows
            if chan.name and not chan.name.lstrip().startswith("###")
        ]
        json.dump(out, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
