import hmac
import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query

from ..config import ADMIN_SECRET
from ..services.goldenott_sync import run_sync

logger = logging.getLogger(__name__)

from ._admin_auth import require_admin  # noqa: E402

router = APIRouter(prefix="/admin/sync", tags=["admin-sync"])


def _require_admin(x_admin_secret: Optional[str]) -> None:
    """Delegates to the shared admin check (one implementation for all
    admin routers; header-secret path, same semantics as before)."""
    require_admin(x_admin_secret=x_admin_secret, authorization=None)


@router.post("/goldenott")
def trigger_goldenott_sync(
    provider_id: Optional[int] = Query(default=None),
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
):
    _require_admin(x_admin_secret)
    return run_sync(provider_id=provider_id)
