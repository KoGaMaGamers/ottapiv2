"""Public-facing admin landing page.

Mounted at `/admin` (no v1 prefix) so the operator can hit
`https://ottapi.smartbunker.fr/admin` directly. The page is a tiny menu
that links to the existing dashboards under `/api/v1/admin/...`.

Auth is the shared Basic / X-Admin-Secret hybrid (see _admin_auth.py),
so the browser prompts on first visit and the operator never has to
paste headers.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse

from ._admin_auth import require_admin


router = APIRouter(tags=["admin"])


_LANDING_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OTTAPI — Admin</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           margin: 0; min-height: 100vh; background: #0f172a; color: #e2e8f0;
           display:flex; align-items:center; justify-content:center; padding: 24px; }
    .card { background:#1e293b; border:1px solid #334155; border-radius: 12px;
            padding: 32px; max-width: 540px; width: 100%; }
    h1 { margin: 0 0 8px 0; font-size: 22px; color: #f8fafc; }
    .muted { color: #94a3b8; font-size: 13px; margin-bottom: 24px; }
    a.tile { display:block; padding: 16px 18px; margin-bottom: 12px;
             background:#0f172a; border:1px solid #334155; border-radius: 10px;
             color:#e2e8f0; text-decoration:none; transition: border-color 0.15s; }
    a.tile:hover { border-color: #4453d6; }
    a.tile h2 { margin: 0 0 4px 0; font-size: 15px; color: #f8fafc;
                font-weight: 600; }
    a.tile p  { margin: 0; font-size: 13px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>OTTAPI Admin</h1>
    <div class="muted">Provider 1 — GoldenOTT operator console.</div>

    <a class="tile" href="/api/v1/admin/providers/pressure/page">
      <h2>Provider pressure dashboard</h2>
      <p>Live + historical view of donor-borne pressure during rush-hour windows.</p>
    </a>

    <a class="tile" href="/api/v1/admin/users/page">
      <h2>IPTV users management</h2>
      <p>Toggle <code>subscription_enforced</code> to keep provider-expired users active.</p>
    </a>
  </div>
</body>
</html>
"""


@router.get("/admin", response_class=HTMLResponse)
def admin_landing(_: None = Depends(require_admin)) -> HTMLResponse:
    return HTMLResponse(content=_LANDING_HTML)
