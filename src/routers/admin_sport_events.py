"""Admin endpoints for the sport-events curation pipeline.

POST /api/v1/admin/sport-events/refresh — shells out to systemctl to
                                          start the sport-events
                                          oneshot service, which runs
                                          as root and has access to
                                          /root/.claude/.
GET  /api/v1/admin/sport-events/last-run — inspect the most recent run

Auth follows the existing `admin_sync.py` pattern: an `X-Admin-Secret`
header HMAC-compared against the `ADMIN_SECRET` env var. Operator
auth, not user-Bearer.

The refresh trigger relies on a sudoers rule granting www-data
(uvicorn's user) permission to start *only* the sport-events oneshot
unit — see deploy/sudoers.d-ottapi-sport-events. If sudo isn't
configured, the endpoint returns 503 with operator instructions.
"""

from __future__ import annotations

import hmac
import logging
import shutil
import subprocess
from typing import Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import ADMIN_SECRET
from ..database import get_db
from ..models import SportEventsRun

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/admin/sport-events", tags=["admin-sport-events"])

REFRESH_UNIT = "ottapi-sport-events.service"
CLEANUP_UNIT = "ottapi-sport-events-cleanup.service"


def _require_admin(x_admin_secret: Optional[str]) -> None:
    if not ADMIN_SECRET:
        raise HTTPException(status_code=503, detail="ADMIN_SECRET not configured")
    if not x_admin_secret or not hmac.compare_digest(x_admin_secret, ADMIN_SECRET):
        raise HTTPException(status_code=401, detail="invalid admin secret")


def _start_unit(unit: str) -> None:
    """Best-effort `sudo systemctl start <unit>`. Surfaces a 503 with
    operator instructions if sudo isn't allowlisted for this unit."""
    sudo = shutil.which("sudo")
    systemctl = shutil.which("systemctl") or "/usr/bin/systemctl"
    if sudo is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "sudo not available on PATH. Trigger manually as root: "
                f"systemctl start {unit}"
            ),
        )
    try:
        proc = subprocess.run(
            [sudo, "-n", systemctl, "start", unit],
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="systemctl start timed out")

    if proc.returncode != 0:
        raise HTTPException(
            status_code=503,
            detail=(
                f"failed to start {unit}: {proc.stderr.strip()[:200]}. "
                "Check /etc/sudoers.d/ottapi-sport-events grants www-data NOPASSWD "
                f"for `systemctl start {unit}`."
            ),
        )


# ---------------------------------------------------------------------------
# Refresh trigger
# ---------------------------------------------------------------------------

class RefreshRequest(BaseModel):
    pass   # `dry_run` is no longer settable from the API; the systemd
           # service always runs the production refresh. Operator can
           # `systemctl start ottapi-sport-events.service` from CLI for
           # ad-hoc dry-runs by editing the unit's ExecStart.


class RefreshResponse(BaseModel):
    accepted: bool
    triggered_by: str
    unit: str


@router.post("/refresh", response_model=RefreshResponse, status_code=202)
def trigger_refresh(
    body: RefreshRequest = Body(default_factory=RefreshRequest),
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
):
    _require_admin(x_admin_secret)
    _start_unit(REFRESH_UNIT)
    return RefreshResponse(accepted=True, triggered_by="admin", unit=REFRESH_UNIT)


# ---------------------------------------------------------------------------
# Last-run inspection
# ---------------------------------------------------------------------------

class LastRunResponse(BaseModel):
    id: Optional[int]
    started_at: Optional[str]
    finished_at: Optional[str]
    status: Optional[str]
    triggered_by: Optional[str]
    events_written: Optional[int]
    error: Optional[str]


@router.get("/last-run", response_model=LastRunResponse)
def get_last_run(
    db: Session = Depends(get_db),
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
):
    _require_admin(x_admin_secret)
    row = (
        db.query(SportEventsRun)
        .order_by(SportEventsRun.id.desc())
        .first()
    )
    if row is None:
        return LastRunResponse(
            id=None, started_at=None, finished_at=None, status=None,
            triggered_by=None, events_written=None, error=None,
        )
    return LastRunResponse(
        id=row.id,
        started_at=row.started_at.isoformat() if row.started_at else None,
        finished_at=row.finished_at.isoformat() if row.finished_at else None,
        status=row.status,
        triggered_by=row.triggered_by,
        events_written=row.events_written,
        error=row.error,
    )
