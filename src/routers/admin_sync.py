import hmac
import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query

from ..config import ADMIN_SECRET
from ..services.goldenott_sync import run_sync

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/sync", tags=["admin-sync"])


def _require_admin(x_admin_secret: Optional[str]) -> None:
    if not ADMIN_SECRET:
        raise HTTPException(status_code=503, detail="ADMIN_SECRET not configured")
    if not x_admin_secret or not hmac.compare_digest(x_admin_secret, ADMIN_SECRET):
        raise HTTPException(status_code=401, detail="invalid admin secret")


@router.post("/goldenott")
def trigger_goldenott_sync(
    provider_id: Optional[int] = Query(default=None),
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
):
    _require_admin(x_admin_secret)
    return run_sync(provider_id=provider_id)
