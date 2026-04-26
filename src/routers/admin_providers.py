import hmac
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import ADMIN_SECRET
from ..database import get_db
from ..models import IPTVUser, XtreamProvider
from ..services.catalog_sync import trigger_provider_sync, trigger_movie_details_sync

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/providers", tags=["admin-providers"])


def _require_admin(x_admin_secret: Optional[str]) -> None:
    if not ADMIN_SECRET:
        raise HTTPException(status_code=503, detail="ADMIN_SECRET not configured")
    if not x_admin_secret or not hmac.compare_digest(x_admin_secret, ADMIN_SECRET):
        raise HTTPException(status_code=401, detail="invalid admin secret")


class SetMasterRequest(BaseModel):
    user_id: int


@router.get("/{provider_id}")
def get_provider(
    provider_id: int,
    db: Session = Depends(get_db),
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
):
    _require_admin(x_admin_secret)
    provider = db.get(XtreamProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="provider not found")

    master_username: Optional[str] = None
    if provider.active_master_user_id:
        master = db.get(IPTVUser, provider.active_master_user_id)
        master_username = master.username if master else None

    return {
        "id": provider.id,
        "base_url": provider.base_url,
        "name": provider.name,
        "is_populated": bool(provider.is_populated),
        "active_master_user_id": provider.active_master_user_id,
        "active_master_username": master_username,
        "last_synced_at": provider.last_synced_at.isoformat() if provider.last_synced_at else None,
        "last_refreshed_at": provider.last_refreshed_at.isoformat() if provider.last_refreshed_at else None,
        "sync_started_at": provider.sync_started_at.isoformat() if provider.sync_started_at else None,
    }


@router.post("/{provider_id}/master-account")
def set_master_account(
    provider_id: int,
    body: SetMasterRequest,
    db: Session = Depends(get_db),
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
):
    _require_admin(x_admin_secret)
    provider = db.get(XtreamProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="provider not found")

    user = db.get(IPTVUser, body.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")
    if user.provider_id != provider_id:
        raise HTTPException(
            status_code=400,
            detail=f"user id={body.user_id} is not on provider id={provider_id}",
        )

    previous = provider.active_master_user_id
    provider.active_master_user_id = user.id
    db.commit()

    logger.info(
        "Provider id=%s master account set: user_id %s -> %s (%s)",
        provider_id, previous, user.id, user.username,
    )
    return {
        "provider_id": provider_id,
        "previous_master_user_id": previous,
        "active_master_user_id": user.id,
        "active_master_username": user.username,
    }


@router.post("/{provider_id}/sync")
def trigger_sync(
    provider_id: int,
    db: Session = Depends(get_db),
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
):
    _require_admin(x_admin_secret)
    provider = db.get(XtreamProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="provider not found")
    if not provider.active_master_user_id:
        raise HTTPException(
            status_code=400,
            detail="provider has no active_master_user_id; set one before syncing",
        )

    trigger_provider_sync(provider_id)
    return {
        "provider_id": provider_id,
        "sync_triggered": True,
    }


@router.post("/{provider_id}/sync/movie-details")
def trigger_movie_details(
    provider_id: int,
    db: Session = Depends(get_db),
    x_admin_secret: Optional[str] = Header(default=None, alias="X-Admin-Secret"),
):
    _require_admin(x_admin_secret)
    provider = db.get(XtreamProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="provider not found")

    trigger_movie_details_sync(provider_id)
    return {
        "provider_id": provider_id,
        "movie_details_sync_triggered": True,
    }
