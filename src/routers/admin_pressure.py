"""Admin endpoints for provider pressure monitoring.

JSON endpoints + a browser-rendered Chart.js dashboard. Used to gauge
how much of the live-stream load is enforced renters (provider expired,
override-active) leaning on valid donor accounts.

Auth: hybrid `X-Admin-Secret` (curl) OR HTTP Basic (browser) via the
shared `require_admin` dependency.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..services.usage_stats_service import (
    build_provider_pressure_snapshot,
    collect_provider_pressure_samples,
    get_provider_pressure_history,
    get_provider_pressure_summary,
)
from ._admin_auth import require_admin


router = APIRouter(prefix="/api/v1/admin/providers/pressure", tags=["admin"])


@router.get("")
def pressure_snapshot(
    provider_id: Optional[int] = Query(None, ge=1),
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Live, computed-on-the-fly snapshot. Doesn't write anything."""
    return {"providers": build_provider_pressure_snapshot(db, provider_id=provider_id)}


@router.post("/snapshot-now")
def pressure_snapshot_now(
    provider_id: Optional[int] = Query(None, ge=1),
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Force-write a sample for the current minute (idempotent)."""
    now = datetime.utcnow()
    inserted = collect_provider_pressure_samples(db, provider_id=provider_id, now=now)
    db.commit()
    return {
        "status":      "ok",
        "snapshot_at": now.replace(second=0, microsecond=0).isoformat(),
        "inserted":    inserted,
    }


@router.get("/summary")
def pressure_summary(
    provider_id: Optional[int] = Query(None, ge=1),
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Last-hour + last-day rollup from the snapshots table."""
    return {"providers": get_provider_pressure_summary(db, provider_id=provider_id)}


@router.get("/history")
def pressure_history(
    provider_id: Optional[int] = Query(None, ge=1),
    range: Literal["hour", "day"] = Query("hour"),
    interval_minutes: int = Query(1, ge=1, le=240),
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Time-bucketed series for charting. interval=1 returns raw samples."""
    return get_provider_pressure_history(
        db,
        provider_id=provider_id,
        range_name=range,
        interval_minutes=interval_minutes,
    )


# ---------------------------------------------------------------------------
# HTML dashboard — Chart.js, self-contained, hits the JSON endpoints above
# ---------------------------------------------------------------------------

_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OTTAPI — Provider Pressure</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           margin: 0; background: #0f172a; color: #e2e8f0; }
    .wrap { max-width: 1300px; margin: 0 auto; padding: 24px 16px; }
    .top { display:flex; justify-content:space-between; align-items:center;
           gap:10px; flex-wrap: wrap; margin-bottom: 18px; }
    .top h1 { font-size: 22px; margin: 0; color: #f8fafc; }
    .top .muted { color: #94a3b8; font-size: 13px; margin-top: 4px; }
    .btn { background:#4453d6; color:#fff; border:0; border-radius:8px;
           padding:9px 14px; cursor:pointer; text-decoration:none;
           display:inline-block; font-size: 14px; }
    .btn.secondary { background:#334155; }
    .btn:hover { filter: brightness(1.1); }
    .bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center;
           margin-bottom:14px; }
    select, input { background:#1e293b; color:#e2e8f0; border:1px solid #334155;
            border-radius:8px; padding:8px 10px; font-size:14px; }
    .panel { background:#1e293b; border:1px solid #334155; border-radius:10px;
             padding:16px; margin-bottom:14px; }
    .cards { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
             gap:10px; margin-bottom:12px; }
    .card { background:#0f172a; border:1px solid #334155; border-radius:10px;
            padding:14px; }
    .card.alert { border-color: #f59e0b; }
    .label { color:#94a3b8; font-size:11px; text-transform:uppercase;
             letter-spacing:.05em; margin-bottom: 6px; }
    .value { font-size:24px; font-weight:700; line-height:1.1; color:#f8fafc; }
    .sub { color:#64748b; font-size:12px; margin-top:4px; }
    .pct { color:#fbbf24; }
    .pct.danger { color:#f87171; }
    canvas { background: #0f172a; border-radius: 8px; padding: 8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>Provider Pressure — GoldenOTT</h1>
        <div class="muted">Live and historical view of donor-borne pressure on provider 1.</div>
      </div>
      <div style="display:flex; gap:8px;">
        <a class="btn secondary" href="/api/v1/admin/users/page">Manage users</a>
        <button class="btn" onclick="reloadAll()">Refresh</button>
      </div>
    </div>

    <div class="bar">
      <select id="range">
        <option value="hour" selected>Last hour</option>
        <option value="day">Last 24 hours</option>
      </select>
      <select id="interval">
        <option value="1" selected>1-min buckets</option>
        <option value="5">5-min buckets</option>
        <option value="15">15-min buckets</option>
      </select>
      <label style="display:flex; align-items:center; gap:6px; color:#94a3b8; font-size:13px;">
        <input id="autoRefresh" type="checkbox" checked> auto refresh 30s
      </label>
      <button class="btn" onclick="snapshotNow()">Snapshot now</button>
    </div>

    <div class="panel">
      <div class="cards" id="cards"></div>
      <canvas id="chart" height="120"></canvas>
    </div>
  </div>

  <script>
    const PROVIDER_ID = 1;

    async function fetchJson(path) {
      const res = await fetch(path, { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    }

    function fmt(n) {
      if (n === null || n === undefined) return "—";
      if (typeof n === "number" && !Number.isInteger(n)) return n.toFixed(2);
      return String(n);
    }

    function renderCards(snap) {
      const p = (snap.providers || [])[0];
      const cards = document.getElementById("cards");
      if (!p) { cards.innerHTML = "<div class='card'><div class='label'>No data</div></div>"; return; }
      const enforcedDanger = p.enforced_pressure_pct >= 50;
      cards.innerHTML = `
        <div class="card">
          <div class="label">Eligible accounts</div>
          <div class="value">${fmt(p.eligible_accounts)}</div>
          <div class="sub">of ${fmt(p.total_accounts)} total · ${fmt(p.expired_accounts)} expired</div>
        </div>
        <div class="card">
          <div class="label">Enforced accounts</div>
          <div class="value">${fmt(p.subscription_enforced_accounts)}</div>
          <div class="sub">flagged subscription_enforced</div>
        </div>
        <div class="card">
          <div class="label">Active streams</div>
          <div class="value">${fmt(p.in_use_allocations)}</div>
          <div class="sub">${fmt(p.own_allocations)} own · ${fmt(p.donor_allocations)} donor</div>
        </div>
        <div class="card ${enforcedDanger ? 'alert' : ''}">
          <div class="label">Enforced renters now</div>
          <div class="value">${fmt(p.enforced_renter_allocations)}</div>
          <div class="sub">leaning on a donor</div>
        </div>
        <div class="card">
          <div class="label">Donor pressure</div>
          <div class="value pct">${fmt(p.donor_pressure_pct)}%</div>
          <div class="sub">in_use / eligible</div>
        </div>
        <div class="card ${enforcedDanger ? 'alert' : ''}">
          <div class="label">Enforced pressure</div>
          <div class="value pct ${enforcedDanger ? 'danger' : ''}">${fmt(p.enforced_pressure_pct)}%</div>
          <div class="sub">enforced renters / eligible</div>
        </div>
      `;
    }

    let chart = null;
    function renderChart(history) {
      const p = (history.providers || [])[0];
      const points = (p && p.points) || [];
      const labels = points.map(pt => {
        const d = new Date(pt.bucket_at);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      });
      const donor = points.map(pt => pt.peak_donor_pressure_pct);
      const enforced = points.map(pt => pt.peak_enforced_pressure_pct);
      const inUse = points.map(pt => pt.peak_in_use_allocations);
      const cfg = {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Donor pressure %',    data: donor,    borderColor: '#fbbf24',
              backgroundColor: 'rgba(251,191,36,0.15)', tension: 0.25, yAxisID: 'y' },
            { label: 'Enforced pressure %', data: enforced, borderColor: '#f87171',
              backgroundColor: 'rgba(248,113,113,0.18)', tension: 0.25, yAxisID: 'y', fill: true },
            { label: 'Active streams (peak)', data: inUse, borderColor: '#60a5fa',
              backgroundColor: 'rgba(96,165,250,0.10)', tension: 0.25, yAxisID: 'y2' },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { labels: { color: '#e2e8f0' } } },
          scales: {
            x:  { ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } },
            y:  { position: 'left',  ticks: { color: '#fbbf24' }, grid: { color: '#1e293b' },
                  title: { display: true, text: 'Pressure %', color: '#94a3b8' } },
            y2: { position: 'right', ticks: { color: '#60a5fa' }, grid: { display: false },
                  title: { display: true, text: 'Streams',    color: '#94a3b8' } },
          },
        },
      };
      if (chart) chart.destroy();
      chart = new Chart(document.getElementById('chart'), cfg);
    }

    async function reloadAll() {
      const range = document.getElementById('range').value;
      const interval = document.getElementById('interval').value;
      try {
        const [snap, hist] = await Promise.all([
          fetchJson(`/api/v1/admin/providers/pressure?provider_id=${PROVIDER_ID}`),
          fetchJson(`/api/v1/admin/providers/pressure/history?provider_id=${PROVIDER_ID}&range=${range}&interval_minutes=${interval}`),
        ]);
        renderCards(snap);
        renderChart(hist);
      } catch (e) {
        console.error(e);
      }
    }

    async function snapshotNow() {
      await fetch(`/api/v1/admin/providers/pressure/snapshot-now?provider_id=${PROVIDER_ID}`,
                  { method: 'POST', credentials: 'same-origin' });
      reloadAll();
    }

    document.getElementById('range').addEventListener('change', reloadAll);
    document.getElementById('interval').addEventListener('change', reloadAll);
    reloadAll();
    setInterval(() => {
      if (document.getElementById('autoRefresh').checked) reloadAll();
    }, 30000);
  </script>
</body>
</html>
"""


@router.get("/page", response_class=HTMLResponse)
def pressure_page(_: None = Depends(require_admin)) -> HTMLResponse:
    return HTMLResponse(content=_PAGE_HTML)
