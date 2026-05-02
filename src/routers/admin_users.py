"""Admin endpoints to manage IPTV user subscriptions.

The control surface that *creates* enforced-renter pressure: flipping
`subscription_enforced=True` on a provider-expired user keeps them
active in the app, and the next allocate they make from a same-provider
donor shows up on the pressure dashboard.

Auth: hybrid `X-Admin-Secret` (curl) OR HTTP Basic (browser) via the
shared `require_admin` dependency.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import IPTVUser, XtreamProvider
from ..services.donor_service import get_effective_exp_date
from ._admin_auth import require_admin


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/admin/users", tags=["admin"])


# ---------------------------------------------------------------------------
# Pydantic
# ---------------------------------------------------------------------------

class UserOut(BaseModel):
    id:                    int
    username:              str
    provider_id:           Optional[int] = None
    provider_name:         Optional[str] = None
    status:                Optional[str] = None
    is_active:             bool
    is_streaming:          bool
    provider_exp_date:     Optional[datetime] = None
    subscription_exp_date: Optional[datetime] = None
    subscription_enforced: bool
    admin_note:            Optional[str] = None
    last_heartbeat_at:     Optional[datetime] = None
    last_login_at:         Optional[datetime] = None
    expiry_state:          Literal["valid", "expired", "unknown"]
    effective_exp_date:    Optional[datetime] = None


class UsersListOut(BaseModel):
    count: int
    items: List[UserOut]


class UserPatch(BaseModel):
    subscription_enforced: Optional[bool] = Field(default=None)
    subscription_exp_date: Optional[datetime] = Field(default=None)
    admin_note:            Optional[str] = Field(default=None)
    is_active:             Optional[bool] = Field(default=None)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ALLOWED_ORDERS = {
    "last_heartbeat_at": IPTVUser.last_heartbeat_at,
    "username":          IPTVUser.username,
    "provider_exp_date": IPTVUser.provider_exp_date,
    "subscription_exp_date": IPTVUser.subscription_exp_date,
}


def _expiry_state(u: IPTVUser, now: datetime) -> str:
    if u.provider_exp_date is None:
        return "unknown"
    return "valid" if u.provider_exp_date > now else "expired"


def _to_out(u: IPTVUser, provider_name: Optional[str], now: datetime) -> UserOut:
    return UserOut(
        id=u.id,
        username=u.username,
        provider_id=u.provider_id,
        provider_name=provider_name,
        status=u.status,
        is_active=bool(u.is_active),
        is_streaming=bool(u.is_streaming),
        provider_exp_date=u.provider_exp_date,
        subscription_exp_date=u.subscription_exp_date,
        subscription_enforced=bool(u.subscription_enforced),
        admin_note=u.admin_note,
        last_heartbeat_at=u.last_heartbeat_at,
        last_login_at=u.last_login_at,
        expiry_state=_expiry_state(u, now),
        effective_exp_date=get_effective_exp_date(u),
    )


def _provider_names(db: Session, provider_ids: List[int]) -> Dict[int, str]:
    if not provider_ids:
        return {}
    rows = (
        db.query(XtreamProvider.id, XtreamProvider.name)
        .filter(XtreamProvider.id.in_(provider_ids))
        .all()
    )
    return {int(pid): (name or f"Provider {pid}") for pid, name in rows}


# ---------------------------------------------------------------------------
# JSON endpoints
# ---------------------------------------------------------------------------

@router.get("", response_model=UsersListOut)
def list_users(
    provider_id: Optional[int] = Query(1, ge=1),
    enforced: Optional[bool] = Query(None),
    expiry: Optional[Literal["valid", "expired"]] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    order: Literal[
        "last_heartbeat_at", "username", "provider_exp_date", "subscription_exp_date",
    ] = Query("last_heartbeat_at"),
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
) -> UsersListOut:
    now = datetime.utcnow()
    q = db.query(IPTVUser)
    if provider_id is not None:
        q = q.filter(IPTVUser.provider_id == provider_id)
    if enforced is not None:
        q = q.filter(IPTVUser.subscription_enforced == bool(enforced))
    if expiry == "expired":
        q = q.filter(IPTVUser.provider_exp_date.isnot(None))
        q = q.filter(IPTVUser.provider_exp_date <= now)
    elif expiry == "valid":
        q = q.filter(or_(
            IPTVUser.provider_exp_date.is_(None),
            IPTVUser.provider_exp_date > now,
        ))
    if search:
        q = q.filter(IPTVUser.username.ilike(f"%{search}%"))

    count = q.count()

    sort_col = _ALLOWED_ORDERS[order]
    # Default direction: newest activity first for time cols, asc for
    # username. MySQL puts NULLs last on DESC by default; no explicit
    # NULLS LAST hint (MySQL doesn't support that ANSI syntax).
    if order == "username":
        q = q.order_by(sort_col.asc())
    else:
        q = q.order_by(sort_col.desc())

    rows = q.offset(offset).limit(limit).all()
    pmap = _provider_names(db, list({r.provider_id for r in rows if r.provider_id}))
    return UsersListOut(
        count=count,
        items=[_to_out(r, pmap.get(int(r.provider_id) if r.provider_id else 0), now) for r in rows],
    )


@router.get("/page", response_class=HTMLResponse)
def users_page(_: None = Depends(require_admin)) -> HTMLResponse:
    return HTMLResponse(content=_PAGE_HTML)


@router.get("/{user_id}", response_model=UserOut)
def get_user(
    user_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
) -> UserOut:
    u = db.get(IPTVUser, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="User not found")
    pmap = _provider_names(db, [u.provider_id] if u.provider_id else [])
    return _to_out(u, pmap.get(int(u.provider_id) if u.provider_id else 0), datetime.utcnow())


@router.patch("/{user_id}", response_model=UserOut)
def patch_user(
    user_id: int,
    body: UserPatch,
    request: Request,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
) -> UserOut:
    u = db.get(IPTVUser, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="User not found")

    diff: Dict[str, Any] = {}

    if body.subscription_enforced is not None:
        if bool(u.subscription_enforced) != body.subscription_enforced:
            diff["subscription_enforced"] = (bool(u.subscription_enforced), body.subscription_enforced)
        u.subscription_enforced = body.subscription_enforced
        # On flip-to-true with no override expiry yet, default to the
        # upstream value so the user stays "valid" until the operator
        # picks a different date.
        if body.subscription_enforced and u.subscription_exp_date is None:
            u.subscription_exp_date = u.provider_exp_date
            diff.setdefault("subscription_exp_date", (None, u.subscription_exp_date))

    if body.subscription_exp_date is not None:
        if u.subscription_exp_date != body.subscription_exp_date:
            diff["subscription_exp_date"] = (u.subscription_exp_date, body.subscription_exp_date)
        u.subscription_exp_date = body.subscription_exp_date

    if body.admin_note is not None:
        new_note = body.admin_note.strip() if body.admin_note else None
        if (u.admin_note or None) != new_note:
            diff["admin_note"] = (u.admin_note, new_note)
        u.admin_note = new_note

    if body.is_active is not None:
        if bool(u.is_active) != body.is_active:
            diff["is_active"] = (bool(u.is_active), body.is_active)
        u.is_active = body.is_active

    db.commit()
    db.refresh(u)

    if diff:
        client = request.client.host if request.client else "?"
        logger.info(
            "admin patch user_id=%d from=%s diff=%s",
            user_id, client, {k: f"{v[0]!r}->{v[1]!r}" for k, v in diff.items()},
        )

    pmap = _provider_names(db, [u.provider_id] if u.provider_id else [])
    return _to_out(u, pmap.get(int(u.provider_id) if u.provider_id else 0), datetime.utcnow())


# ---------------------------------------------------------------------------
# HTML page
# ---------------------------------------------------------------------------

_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OTTAPI — IPTV Users</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           margin: 0; background: #0f172a; color: #e2e8f0; }
    .wrap { max-width: 1500px; margin: 0 auto; padding: 24px 16px; }
    .top { display:flex; justify-content:space-between; align-items:center;
           gap:10px; flex-wrap:wrap; margin-bottom: 18px; }
    .top h1 { font-size: 22px; margin: 0; color: #f8fafc; }
    .muted { color: #94a3b8; font-size: 13px; margin-top: 4px; }
    .btn { background:#4453d6; color:#fff; border:0; border-radius:6px;
           padding:7px 12px; cursor:pointer; text-decoration:none;
           display:inline-block; font-size: 13px; }
    .btn.secondary { background:#334155; }
    .btn.success { background:#16a34a; }
    .btn.danger { background:#dc2626; }
    .btn:hover { filter: brightness(1.1); }
    .bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center;
           margin-bottom:14px; }
    select, input { background:#1e293b; color:#e2e8f0; border:1px solid #334155;
            border-radius:6px; padding:7px 9px; font-size:13px; }
    .panel { background:#1e293b; border:1px solid #334155; border-radius:10px;
             padding: 4px; }
    table { width:100%; border-collapse: collapse; }
    th, td { text-align:left; padding:9px 10px; border-bottom:1px solid #334155;
             font-size:13px; vertical-align: middle; }
    th { background:#0f172a; font-size:11px; text-transform:uppercase;
         letter-spacing:.05em; color:#94a3b8; position: sticky; top: 0; }
    tr:hover td { background: #243044; }
    .pill { padding: 2px 8px; border-radius: 999px; font-size:11px; font-weight:600;
            display:inline-block; }
    .pill.valid    { background:#15803d; color:#dcfce7; }
    .pill.expired  { background:#9a3412; color:#fed7aa; }
    .pill.enforced { background:#92400e; color:#fef3c7; }
    .pill.muted    { background:#334155; color:#cbd5e1; }
    .count-pill { background:#0f172a; border:1px solid #334155; padding:4px 10px;
                  border-radius:999px; font-size:12px; color:#94a3b8; }
    .actions { display:flex; gap:4px; flex-wrap:wrap; }
    .note-input { width: 200px; }
    .pager { display:flex; gap:8px; align-items:center; margin-top: 12px;
             color:#94a3b8; font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>IPTV Users — GoldenOTT</h1>
        <div class="muted">Toggle <code>subscription_enforced</code> on provider-expired accounts to keep them active in the app.</div>
      </div>
      <div style="display:flex; gap:8px;">
        <a class="btn secondary" href="/api/v1/admin/providers/pressure/page">Pressure dashboard</a>
        <button class="btn" onclick="reload()">Refresh</button>
      </div>
    </div>

    <div class="bar">
      <select id="expiry">
        <option value="" selected>Expiry: any</option>
        <option value="valid">valid only</option>
        <option value="expired">expired only</option>
      </select>
      <select id="enforced">
        <option value="" selected>Enforced: any</option>
        <option value="true">enforced only</option>
        <option value="false">not enforced</option>
      </select>
      <input id="search" placeholder="search username" />
      <select id="order">
        <option value="last_heartbeat_at" selected>Last heartbeat</option>
        <option value="username">Username</option>
        <option value="provider_exp_date">Provider exp</option>
        <option value="subscription_exp_date">Subscription exp</option>
      </select>
      <select id="limit">
        <option value="25">25 / page</option>
        <option value="50" selected>50 / page</option>
        <option value="100">100</option>
        <option value="200">200</option>
      </select>
      <span class="count-pill" id="countPill">—</span>
    </div>

    <div class="panel">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Username</th>
            <th>Status</th>
            <th>Provider exp</th>
            <th>Sub exp</th>
            <th>Enforced</th>
            <th>Note</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="tbody">
          <tr><td colspan="8" style="padding:30px; text-align:center; color:#64748b;">Loading…</td></tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <button class="btn secondary" onclick="prevPage()">← Prev</button>
      <span id="pageLabel">Page 1</span>
      <button class="btn secondary" onclick="nextPage()">Next →</button>
    </div>
  </div>

  <script>
    const PROVIDER_ID = 1;
    let offset = 0;

    function fmtDate(s) {
      if (!s) return "—";
      const d = new Date(s);
      if (isNaN(d)) return s;
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function expiryPill(state) {
      if (state === "valid")   return '<span class="pill valid">valid</span>';
      if (state === "expired") return '<span class="pill expired">expired</span>';
      return '<span class="pill muted">unknown</span>';
    }
    function enforcedPill(b) {
      return b
        ? '<span class="pill enforced">ON</span>'
        : '<span class="pill muted">off</span>';
    }

    function row(u) {
      const enforceBtn = u.subscription_enforced
        ? `<button class="btn danger"  onclick="patch(${u.id}, {subscription_enforced:false})">Un-enforce</button>`
        : `<button class="btn success" onclick="patch(${u.id}, {subscription_enforced:true})">Enforce</button>`;
      const expVal = u.subscription_exp_date ? new Date(u.subscription_exp_date).toISOString().slice(0,10) : "";
      return `
        <tr id="row-${u.id}">
          <td>${u.id}</td>
          <td><strong>${u.username}</strong></td>
          <td>${u.status || '—'} ${u.is_active ? '' : '<span class="pill muted">disabled</span>'}</td>
          <td>${fmtDate(u.provider_exp_date)} ${expiryPill(u.expiry_state)}</td>
          <td>${fmtDate(u.subscription_exp_date)}</td>
          <td>${enforcedPill(u.subscription_enforced)}</td>
          <td><input class="note-input" id="note-${u.id}" value="${(u.admin_note || '').replace(/"/g,'&quot;')}" placeholder="(no note)"
                     onblur="patch(${u.id}, {admin_note: this.value})"/></td>
          <td class="actions">
            ${enforceBtn}
            <input type="date" value="${expVal}"
                   onchange="patch(${u.id}, {subscription_exp_date: this.value ? new Date(this.value).toISOString() : null})"/>
          </td>
        </tr>
      `;
    }

    async function load() {
      const params = new URLSearchParams({
        provider_id: PROVIDER_ID,
        limit: document.getElementById('limit').value,
        offset: String(offset),
        order: document.getElementById('order').value,
      });
      const expiry = document.getElementById('expiry').value;
      if (expiry) params.set('expiry', expiry);
      const enforced = document.getElementById('enforced').value;
      if (enforced) params.set('enforced', enforced);
      const search = document.getElementById('search').value.trim();
      if (search) params.set('search', search);

      try {
        const res = await fetch(`/api/v1/admin/users?${params}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        const tbody = document.getElementById('tbody');
        if (!json.items.length) {
          tbody.innerHTML = `<tr><td colspan="8" style="padding:30px; text-align:center; color:#64748b;">No users.</td></tr>`;
        } else {
          tbody.innerHTML = json.items.map(row).join('');
        }
        document.getElementById('countPill').textContent = `${json.count} total`;
        const limit = parseInt(document.getElementById('limit').value, 10);
        const page = Math.floor(offset / limit) + 1;
        const totalPages = Math.max(1, Math.ceil(json.count / limit));
        document.getElementById('pageLabel').textContent = `Page ${page} / ${totalPages}`;
      } catch (e) {
        console.error(e);
      }
    }

    function reload() { offset = 0; load(); }
    function prevPage() {
      const limit = parseInt(document.getElementById('limit').value, 10);
      offset = Math.max(0, offset - limit); load();
    }
    function nextPage() {
      const limit = parseInt(document.getElementById('limit').value, 10);
      offset += limit; load();
    }

    async function patch(userId, body) {
      try {
        const res = await fetch(`/api/v1/admin/users/${userId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          alert(`Update failed: HTTP ${res.status}`);
          return;
        }
        await load();
      } catch (e) {
        console.error(e);
        alert("Update failed: " + e.message);
      }
    }

    ["expiry","enforced","order","limit"].forEach(id =>
      document.getElementById(id).addEventListener('change', reload));
    document.getElementById('search').addEventListener('keyup', e => {
      if (e.key === 'Enter') reload();
    });
    load();
  </script>
</body>
</html>
"""
