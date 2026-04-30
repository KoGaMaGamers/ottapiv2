"""Admin endpoints for the sport-events curation pipeline.

POST /api/v1/admin/sport-events/refresh — kick off Claude on demand
GET  /api/v1/admin/sport-events/last-run — inspect the most recent run

Auth follows the existing `admin_sync.py` pattern: an `X-Admin-Secret`
header HMAC-compared against the `ADMIN_SECRET` env var. Operator
auth, not user-Bearer.
"""

from __future__ import annotations

import hmac
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import ADMIN_SECRET
from ..database import get_db
from ..models import SportEventsRun
from ..services import sport_events_runner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/admin/sport-events", tags=["admin-sport-events"])


def _require_admin(x_admin_secret: Optional[str]) -> None:
    if not ADMIN_SECRET:
        raise HTTPException(status_code=503, detail="ADMIN_SECRET not configured")
    if not x_admin_secret or not hmac.compare_digest(x_admin_secret, ADMIN_SECRET):
        raise HTTPException(status_code=401, detail="invalid admin secret")


# ---------------------------------------------------------------------------
# Refresh trigger
# ---------------------------------------------------------------------------

class RefreshRequest(BaseModel):
    dry_run: bool = False


class RefreshResponse(BaseModel):
    accepted: bool
    triggered_by: str
    dry_run: bool


@router.post("/refresh", response_model=RefreshResponse, status_code=202)
def trigger_refresh(
    body: RefreshRequest = Body(default_factory=RefreshRequest),
    background: BackgroundTasks = None,
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
):
    _require_admin(x_admin_secret)
    background.add_task(
        sport_events_runner.run_sport_events_refresh,
        triggered_by="admin",
        dry_run=body.dry_run,
    )
    return RefreshResponse(accepted=True, triggered_by="admin", dry_run=body.dry_run)


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
