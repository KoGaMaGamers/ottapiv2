#!/home/ottapi/.venv/bin/python
"""Atomic ingest of a sport-events JSON document into the database.

Reads JSON from stdin, validates, resolves cover images (HEAD-checking
remote URLs and falling back to a side-by-side composite via
compose_cover.py when needed), inserts a fresh batch, flips the
sport_events_current_batch pointer, and sweeps finished events.

Run:
    cat events.json | python3 .claude/skills/sport-events/scripts/ingest.py

Failure semantics: on any validation / DB error the transaction
rolls back and the batch pointer is unchanged — the previous run's
events keep serving. Exit code is non-zero so the scheduler logs
reflect the failure.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import traceback
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, List, Optional

import requests
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import text

from _db import (
    KvSettings,
    LiveStream,
    LiveStreamAlias,
    SessionLocal,
    SportEvent,
    SportEventsRun,
    XtreamProvider,
    normalize_channel_name,
)

# ---------------------------------------------------------------------------
# Config / constants
# ---------------------------------------------------------------------------

STATIC_DIR = os.getenv(
    "SPORT_EVENTS_STATIC_DIR",
    "/home/ottapi/static/sport-events",
)
# Sibling dir for covers we mirror locally from external URLs (Wikimedia,
# formula1.com, etc). Same /static/ mount serves both, so the public URL
# is always same-origin regardless of where the original art lives.
COVERS_DIR = os.path.join(
    os.path.dirname(STATIC_DIR.rstrip("/")),
    "sport-covers",
)
HEAD_TIMEOUT = 6
GET_TIMEOUT = 15
COMPOSE_SCRIPT = os.path.join(os.path.dirname(__file__), "compose_cover.py")

WINDOW_MIN = timedelta(hours=6)       # past tolerance
WINDOW_MAX = timedelta(days=14)       # future cap

# Browser-like UA — Wikimedia + several CDNs return 400 to bare
# bot identifiers. Compliant with Wikimedia's UA policy
# (descriptive name + contact URL inside parens).
HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; OttApiSportEvents/1.0; "
        "+https://github.com/appelungeek/ottapi)"
    ),
    "Accept": "*/*",
}

POINTER_KEY = "sport_events_current_batch"


# ---------------------------------------------------------------------------
# Pydantic schema
# ---------------------------------------------------------------------------

class BroadcasterIn(BaseModel):
    name:     str
    country:  Optional[str] = None    # ISO 3166-1 alpha-2
    language: Optional[str] = None    # ISO 639-1


class EventIn(BaseModel):
    title:               str
    description:         Optional[str] = None
    sport:               str
    league:              Optional[str] = None
    home_team:           Optional[str] = None
    away_team:           Optional[str] = None
    start_utc:           datetime
    end_utc:             Optional[datetime] = None

    # Multi-broadcaster: same event typically airs on different TV
    # channels per country. The skill collects ALL broadcasters it
    # finds; the read endpoint resolves each per the requesting
    # user's provider so the UI can offer a channel picker.
    broadcasters:        List[BroadcasterIn] = Field(default_factory=list)

    # Legacy singular fields — kept for back-compat with handcrafted
    # fixtures and the v1 SKILL.md contract. When `broadcasters` is
    # empty we synthesize a single-element list from these.
    broadcaster_name:    Optional[str] = None
    broadcaster_country: Optional[str] = None

    cover_url:           Optional[str] = None
    home_team_logo_url:  Optional[str] = None
    away_team_logo_url:  Optional[str] = None

    source_url:          str

    @field_validator("start_utc", "end_utc", mode="before")
    @classmethod
    def _parse_z(cls, v):
        if v is None or isinstance(v, datetime):
            return v
        # Accept "...Z" by swapping for "+00:00" so fromisoformat works
        # on Python < 3.11.
        if isinstance(v, str) and v.endswith("Z"):
            v = v[:-1] + "+00:00"
        return datetime.fromisoformat(v)

    def resolved_broadcasters(self) -> "list[BroadcasterIn]":
        """Return broadcasters[], synthesizing from singular legacy
        fields when the list is empty."""
        if self.broadcasters:
            return list(self.broadcasters)
        if self.broadcaster_name:
            return [BroadcasterIn(
                name=self.broadcaster_name,
                country=self.broadcaster_country,
            )]
        return []


class IngestPayload(BaseModel):
    events: List[EventIn] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)  # store naive UTC


def _to_utc_naive(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _head_ok(url: str) -> bool:
    if not url:
        return False
    try:
        r = requests.head(
            url, headers=HTTP_HEADERS, allow_redirects=True, timeout=HEAD_TIMEOUT,
        )
        if 200 <= r.status_code < 400:
            return True
        # Some CDNs reject HEAD; retry as a 1-byte ranged GET.
        r = requests.get(
            url, headers={**HTTP_HEADERS, "Range": "bytes=0-0"},
            allow_redirects=True, timeout=HEAD_TIMEOUT, stream=True,
        )
        return 200 <= r.status_code < 400
    except requests.RequestException:
        return False


_SLUG_PUNCT = re.compile(r"[^a-z0-9]+")


def _slugify(s: str) -> str:
    s = s.lower()
    s = _SLUG_PUNCT.sub("-", s).strip("-")
    return s[:80]


def _event_slug(ev: EventIn) -> str:
    parts = []
    if ev.home_team and ev.away_team:
        parts.append(f"{ev.home_team}-vs-{ev.away_team}")
    else:
        parts.append(ev.title)
    parts.append(ev.start_utc.strftime("%Y%m%d"))
    return _slugify("-".join(parts))


def _compose_cover(home_url: str, away_url: str, slug: str) -> Optional[str]:
    """Run compose_cover.py and return the public URL on success, None on failure."""
    try:
        proc = subprocess.run(
            [
                COMPOSE_SCRIPT,        # has its own venv shebang
                "--home-logo-url", home_url,
                "--away-logo-url", away_url,
                "--slug",          slug,
                "--out-dir",       STATIC_DIR,
            ],
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return None

    if proc.returncode != 0:
        return None
    try:
        out = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        return None
    return out.get("public_url")


def _localize_cover(url: str, slug: str) -> Optional[str]:
    """Mirror an external cover URL to /static/sport-covers/<slug>.jpg.

    Always re-encodes as JPEG via PIL: starlette's StaticFiles relies
    on Python's `mimetypes` module which returns `text/plain` for some
    formats (notably webp on older interpreters), and a wrong
    Content-Type makes the WebView refuse to render the image. Forcing
    jpg sidesteps that — every WebView handles jpg, and the cover is
    a hero backdrop where a tiny re-encode loss is invisible.

    Returns the public path on success, None on any failure (caller
    should fall back to the remote URL — that's still better than no
    cover at all). Hotlink-protected hosts and slow CDNs are exactly
    why we mirror: the device WebView hits a same-origin file and
    never blocks the hero on a third-party fetch.
    """
    if not url:
        return None
    try:
        os.makedirs(COVERS_DIR, exist_ok=True)
    except OSError:
        return None
    try:
        r = requests.get(
            url,
            headers=HTTP_HEADERS,
            allow_redirects=True,
            timeout=GET_TIMEOUT,
        )
        if not (200 <= r.status_code < 400):
            return None
        data = r.content
    except requests.RequestException:
        return None

    try:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        if img.mode not in ("RGB", "L"):
            # Flatten transparency onto white so jpg conversion doesn't
            # produce black halos around team logos / event posters.
            if img.mode in ("RGBA", "LA") or "transparency" in img.info:
                bg = Image.new("RGB", img.size, (255, 255, 255))
                bg.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
                img = bg
            else:
                img = img.convert("RGB")
        out_path = os.path.join(COVERS_DIR, f"{slug}.jpg")
        img.save(out_path, format="JPEG", quality=88, optimize=True)
    except (OSError, ValueError):
        return None
    return f"/static/sport-covers/{slug}.jpg"


# ---------------------------------------------------------------------------
# Broadcaster → channel matching (mirrors plan §5)
# ---------------------------------------------------------------------------

def _resolve_broadcaster_for_provider(
    db,
    provider_id: int,
    broadcaster: str,
) -> Optional[tuple[int, float]]:
    """Return (live_stream_id, confidence) on hit, None on miss.

    Confidence: 1.0 exact, 0.9 alias, 0.7 token-containment.
    """
    norm = normalize_channel_name(broadcaster)
    if not norm:
        return None

    # Layer 2 — exact normalized match.
    rows = (
        db.query(LiveStream)
        .filter(LiveStream.provider_id == provider_id)
        .all()
    )
    for r in rows:
        if normalize_channel_name(r.name) == norm:
            return (r.id, 1.0)

    # Layer 3 — alias hit.
    alias = (
        db.query(LiveStreamAlias)
        .filter(LiveStreamAlias.provider_id == provider_id)
        .filter(LiveStreamAlias.alias == norm)
        .first()
    )
    if alias is not None:
        return (alias.live_stream_id, 0.9)

    # Layer 4 — token containment. Pick the SHORTEST channel name that
    # contains every token from the broadcaster.
    tokens = norm.split()
    if not tokens:
        return None
    candidates: list[tuple[int, str]] = []
    for r in rows:
        rn = normalize_channel_name(r.name)
        rn_tokens = set(rn.split())
        if all(t in rn_tokens for t in tokens):
            candidates.append((r.id, rn))
    if not candidates:
        return None
    candidates.sort(key=lambda x: (len(x[1]), x[1]))
    return (candidates[0][0], 0.7)


def _seed_alias(db, provider_id: int, broadcaster: str, live_stream_id: int, confidence: float) -> None:
    """Record a fuzzy match so subsequent runs hit the alias path."""
    norm = normalize_channel_name(broadcaster)
    if not norm:
        return
    existing = (
        db.query(LiveStreamAlias)
        .filter(LiveStreamAlias.provider_id == provider_id)
        .filter(LiveStreamAlias.alias == norm)
        .first()
    )
    if existing is not None:
        return
    db.add(LiveStreamAlias(
        provider_id=provider_id,
        alias=norm,
        live_stream_id=live_stream_id,
        confidence=confidence,
    ))


# ---------------------------------------------------------------------------
# Pointer / batch helpers
# ---------------------------------------------------------------------------

def _read_pointer(db) -> int:
    row = db.query(KvSettings).filter(KvSettings.key == POINTER_KEY).first()
    if row is None:
        return 0
    try:
        return int(row.value)
    except (TypeError, ValueError):
        return 0


def _write_pointer(db, value: int) -> None:
    row = db.query(KvSettings).filter(KvSettings.key == POINTER_KEY).first()
    if row is None:
        db.add(KvSettings(key=POINTER_KEY, value=str(value)))
    else:
        row.value = str(value)


# ---------------------------------------------------------------------------
# Sweep finished events
# ---------------------------------------------------------------------------

def _sweep_finished(db, now: datetime) -> int:
    """Delete events whose end_utc has passed; unlink any local cover
    files we own (composite or mirrored). Returns count deleted."""
    finished = db.query(SportEvent).filter(SportEvent.end_utc < now).all()
    n = 0
    for ev in finished:
        _unlink_local_cover(ev.cover_url)
        db.delete(ev)
        n += 1
    return n


def _unlink_local_cover(cover_url: Optional[str]) -> None:
    """Best-effort unlink for a cover_url that points at our /static/.
    Handles both composite (sport-events) and mirrored (sport-covers)
    layouts; ignores remote URLs and missing files."""
    if not cover_url:
        return
    if cover_url.startswith("/static/sport-events/"):
        disk_dir = STATIC_DIR
    elif cover_url.startswith("/static/sport-covers/"):
        disk_dir = COVERS_DIR
    else:
        return
    disk = os.path.join(disk_dir, os.path.basename(cover_url))
    try:
        os.unlink(disk)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Main ingest flow
# ---------------------------------------------------------------------------

@contextmanager
def _run_row(db, triggered_by: str = "skill"):
    row = SportEventsRun(
        started_at=_now_utc(),
        status="running",
        triggered_by=triggered_by,
    )
    db.add(row)
    db.flush()
    try:
        yield row
    finally:
        row.finished_at = _now_utc()


def ingest(payload: IngestPayload, triggered_by: str = "skill") -> dict[str, Any]:
    db = SessionLocal()
    summary: dict[str, Any] = {
        "events_written":  0,
        "batch_id":        None,
        "covers_composed": 0,
        "swept_finished":  0,
        "unmatched":       [],
    }
    run_id: Optional[int] = None
    try:
        with _run_row(db, triggered_by) as run:
            run_id = run.id
            now = _now_utc()
            min_start = now - WINDOW_MIN
            max_start = now + WINDOW_MAX

            valid_events: list[tuple[EventIn, datetime, datetime, str]] = []
            for ev in payload.events:
                start = _to_utc_naive(ev.start_utc)
                end = _to_utc_naive(ev.end_utc) or (start + timedelta(hours=2))
                if start is None:
                    continue
                if end < min_start or start > max_start:
                    continue
                if not _head_ok(ev.source_url):
                    continue

                # Cover ladder.
                slug = _event_slug(ev)
                cover = None
                if _head_ok(ev.cover_url):
                    # Mirror the remote image so the frontend always
                    # gets a stable, same-origin URL. Fall back to the
                    # remote URL on download failure — still better
                    # than no cover.
                    cover = _localize_cover(ev.cover_url, slug) or ev.cover_url
                if cover is None:
                    if (ev.home_team_logo_url and ev.away_team_logo_url
                            and _head_ok(ev.home_team_logo_url)
                            and _head_ok(ev.away_team_logo_url)):
                        cover = _compose_cover(
                            ev.home_team_logo_url, ev.away_team_logo_url, slug,
                        )
                        if cover:
                            summary["covers_composed"] += 1
                if cover is None:
                    continue   # plan §3.4 branch 3 — drop

                valid_events.append((ev, start, end, cover))

            if not valid_events:
                run.status = "failure"
                run.error = "no valid events after validation"
                db.commit()
                return summary

            # Pre-resolve broadcaster→channel for every provider × every
            # broadcaster on every event, so alias-table fast-paths are
            # warm before the first read.
            providers = db.query(XtreamProvider).all()
            for ev, _start, _end, _cover in valid_events:
                for b in ev.resolved_broadcasters():
                    for prov in providers:
                        hit = _resolve_broadcaster_for_provider(
                            db, prov.id, b.name,
                        )
                        if hit is None:
                            continue
                        live_id, conf = hit
                        if conf < 1.0:
                            _seed_alias(db, prov.id, b.name, live_id, conf)

            current_batch = _read_pointer(db)
            next_batch = current_batch + 1

            from _db import SportEventBroadcaster
            for ev, start, end, cover in valid_events:
                broadcasters = ev.resolved_broadcasters()
                primary = broadcasters[0]   # back-compat denormalized fields
                row = SportEvent(
                    batch_id=next_batch,
                    title=ev.title,
                    description=ev.description,
                    sport=ev.sport,
                    league=ev.league,
                    home_team=ev.home_team,
                    away_team=ev.away_team,
                    start_utc=start,
                    end_utc=end,
                    broadcaster_name=primary.name,
                    broadcaster_country=primary.country,
                    cover_url=cover,
                    source_url=ev.source_url,
                )
                db.add(row)
                db.flush()  # populate row.id
                # Insert one broadcaster row per (event, broadcaster).
                seen = set()
                for b in broadcasters:
                    key = (b.name.lower(), (b.country or "").upper())
                    if key in seen:
                        continue
                    seen.add(key)
                    db.add(SportEventBroadcaster(
                        event_id=row.id,
                        broadcaster_name=b.name,
                        country=b.country.upper() if b.country else None,
                        language=b.language.lower() if b.language else None,
                    ))

            _write_pointer(db, next_batch)

            swept = _sweep_finished(db, now)
            summary["swept_finished"] = swept

            run.status = "success"
            run.events_written = len(valid_events)

            summary["events_written"] = len(valid_events)
            summary["batch_id"] = next_batch

            db.commit()
            return summary

    except Exception:
        db.rollback()
        # Update the run row OUTSIDE the rolled-back transaction.
        try:
            db2 = SessionLocal()
            row = db2.query(SportEventsRun).filter(SportEventsRun.id == run_id).first() if run_id else None
            if row is not None:
                row.status = "failure"
                row.finished_at = _now_utc()
                row.error = traceback.format_exc()[-2000:]
                db2.commit()
            db2.close()
        except Exception:
            pass
        raise
    finally:
        db.close()


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

    try:
        summary = ingest(payload)
    except Exception as e:
        json.dump({"error": str(e)}, sys.stdout)
        sys.stdout.write("\n")
        return 1

    json.dump(summary, sys.stdout, default=str)
    sys.stdout.write("\n")
    return 0 if summary["events_written"] > 0 else 2


if __name__ == "__main__":
    sys.exit(main())
