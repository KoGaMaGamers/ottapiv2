from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import IPTVUser, XtreamProvider
from ..services.donor_service import get_effective_exp_date
from .auth import get_current_user

router = APIRouter(prefix="/api/v1", tags=["me"])


class MeResponse(BaseModel):
    user_id: int
    username: str
    provider_id: int
    provider_name: Optional[str]
    provider_base_url: str
    is_populated: bool
    view_mode: Literal["fallback", "curated"]
    status: Optional[str]
    is_trial: Optional[bool]
    max_connections: Optional[int]
    subscription_enforced: bool
    subscription_exp_date: Optional[datetime]
    provider_exp_date: Optional[datetime]
    effective_exp_date: Optional[datetime]


@router.get("/me", response_model=MeResponse)
def me(
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    provider = db.get(XtreamProvider, user.provider_id) if user.provider_id else None
    return MeResponse(
        user_id=user.id,
        username=user.username,
        provider_id=user.provider_id,
        provider_name=provider.name if provider else None,
        provider_base_url=provider.base_url if provider else "",
        is_populated=bool(provider.is_populated) if provider else False,
        view_mode=("curated" if (provider and provider.is_populated) else "fallback"),
        status=user.status,
        is_trial=user.is_trial,
        max_connections=user.max_connections,
        subscription_enforced=bool(user.subscription_enforced),
        subscription_exp_date=user.subscription_exp_date,
        provider_exp_date=user.provider_exp_date,
        effective_exp_date=get_effective_exp_date(user),
    )


# Native player needs the user's xtream credentials to build live /
# catchup / preview URLs locally (no slot allocation, no round-trip
# per zap). Mirrors the legacy Capacitor app's pattern — credentials
# go to JS in-memory only, then forward to the native plugin via
# channelData. Never persisted client-side.
class CredentialsResponse(BaseModel):
    base_stream_url: str
    username: str
    password: str
    preferred_output: str


@router.get("/me/credentials", response_model=CredentialsResponse)
def me_credentials(
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    provider = db.get(XtreamProvider, user.provider_id) if user.provider_id else None
    return CredentialsResponse(
        base_stream_url=provider.base_url.rstrip("/") if provider else "",
        username=user.username,
        password=user.password or "",
        preferred_output=user.preferred_output or "m3u8",
    )
