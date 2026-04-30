---
name: sport-events
description: |
  Use this skill when the project's APScheduler invokes Claude with the
  prompt "Run the sport-events skill." It curates 5–8 broadcast-popular
  upcoming sport events from the next 14 days, resolves each event's
  broadcaster against the live-channel catalog, and writes the result
  to the database via the ingest helper. NEVER call this skill outside
  of that scheduler / its admin trigger.
allowed-tools:
  - WebSearch
  - WebFetch
  - Bash(.claude/skills/sport-events/scripts/list_channels.py)
  - Bash(.claude/skills/sport-events/scripts/ingest.py)
  - Bash(.claude/skills/sport-events/scripts/dry_run.py)
---

# Sport events curation

You are the curator for the Home page hero rail. Whatever you leave in
the `sport_events` table is what the user sees rotating at the top of
their app. Your job runs every ~72 h.

## Goal

Pick **5 to 8** broadcast-popular upcoming sport events that begin in
the next **14 days**. For each event, find the live TV channel that
broadcasts it, fetch a representative cover image, and a primary
source URL that grounds the event (Wikipedia, league site, ESPN, etc.).
Then run `ingest.py` once with the curated batch.

If you cannot produce **at least 5 valid events**, exit without
calling `ingest.py`. The previous batch will continue to serve.

## Procedure

### 1. Dump the channel catalog

```
.claude/skills/sport-events/scripts/list_channels.py
```

(The shebang pins `/home/ottapi/.venv/bin/python` so the script always
runs against the same SQLAlchemy / Pydantic the API uses.)

The script writes a JSON array of every live channel across every
provider, with normalized names (HD/UHD/region tokens stripped). Read
its output before searching the web — your job is to curate events
whose broadcaster appears in this catalog. **Do not invent broadcaster
names.** If "ESPN" is not in the catalog, do not return events on
ESPN.

### 2. Search broadly for upcoming events

Use `WebSearch` with queries like:

- `"top sport events this week site:espn.com"`
- `"upcoming football matches <next 7 days>"`
- `"tennis grand slam schedule 2026"`
- `"NBA games this week"`
- `"motorsports schedule next 14 days"`

Aim for **breadth across sports** — soccer, basketball, tennis,
motorsport, rugby, NFL, MMA, etc. — but **do not artificially cap a
popular sport for diversity's sake**: if soccer dominates the calendar
this week, soccer dominates the results. Quality first.

### 3. Verify each candidate with `WebFetch`

For every shortlisted event, fetch a primary source (league site,
Wikipedia event page, ESPN article, lequipe.fr…) and pull:

- exact UTC start time
- broadcaster name (the live TV channel for the event's region —
  bias toward names that already appear in the step 1 catalog)
- home / away teams (for team sports)
- league / competition
- a representative image URL (event poster, team kit shot, league
  logo composite, etc.)
- a one-sentence description

### 4. Resolve broadcaster against catalog

For each event, check whether the broadcaster name matches any channel
in the step-1 catalog under any provider. The match is loose: ignore
casing / "HD" suffixes / "+1" channel-shifts. If you cannot find a
catalog match, **drop the event** — the read endpoint will hide it
anyway.

The ingest script does its own matching (exact → alias → token-
containment) and will write alias rows when a fuzzy match succeeds, so
your role is just to filter out broadcasters that obviously don't
exist.

### 5. Cover-image fallback

For each event, prefer a single high-quality cover image. If you can't
find one but you do have the URLs of both teams' logos, set
`cover_url` to `null` and provide `home_team_logo_url` +
`away_team_logo_url`. The ingest script will compose a side-by-side
"VS" hero from the two logos. For non-team events (Roland Garros,
F1 race, etc.), you must supply a real `cover_url` — there's no
fallback.

### 6. Build the batch

Assemble a JSON document with shape:

```json
{
  "events": [
    {
      "title":               "Real Madrid vs Barcelona",
      "description":         "El Clásico — La Liga matchday 14.",
      "sport":               "football",
      "league":              "La Liga",
      "home_team":           "Real Madrid",
      "away_team":           "Barcelona",
      "start_utc":           "2026-05-12T19:00:00Z",
      "end_utc":             "2026-05-12T21:00:00Z",
      "broadcaster_name":    "ESPN",
      "broadcaster_country": "US",

      "cover_url":           "https://upload.wikimedia.org/...real-barca.jpg",
      "home_team_logo_url":  null,
      "away_team_logo_url":  null,

      "source_url":          "https://www.laliga.com/en-GB/match/2026-..."
    }
  ]
}
```

Required: `title`, `sport`, `start_utc`, `broadcaster_name`,
`source_url`, and a way to render a cover (either `cover_url` or both
team-logo URLs). Everything else nullable.

**Constraints**

- 5 ≤ events ≤ 8.
- Dedupe by `(home_team, away_team, start_utc)` or `(title, start_utc)`
  for non-team events.
- `start_utc` must be ISO-8601 with explicit `Z`.
- All times in UTC. Convert local kickoff times before submitting.
- Drop events more than 14 days in the future or already finished.

### 7. Ingest

Pipe the JSON to `ingest.py` via stdin, exactly once per session:

```
.claude/skills/sport-events/scripts/ingest.py < /dev/stdin
```

(In practice you'll use a heredoc or temp file — whichever your tools
allow.)

### 8. Report

Print the `ingest.py` JSON summary back to your operator:

```json
{"events_written": 6, "batch_id": 17, "covers_composed": 2,
 "swept_finished": 3, "unmatched": []}
```

Do not run ingest twice. Do not edit the database directly.

## Failure mode

If at any point you cannot produce at least 5 valid events that pass
the catalog-broadcaster filter and have a working cover path, **exit
without calling ingest**. The previous batch will keep serving. Print
a short reason ("not enough events with catalog-matching broadcasters
this week") so the operator sees it in the run log.
