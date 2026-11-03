import logging
from datetime import datetime
from typing import Literal, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import IPTVUser, XtreamProvider
from ..services.auth_service import create_user_token, get_user_from_token
from ..services.catalog_sync import trigger_provider_sync
from ..services.dns_health_service import (
    _extract_parent_domain,
    get_healthy_domain,
    is_domain_healthy,
    rewrite_to_healthy,
)
from ..services.provider_service import match_or_create_provider, normalize_base_url
from ..services.xtream_client import XtreamClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


def get_current_user(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> IPTVUser:
    """FastAPI dependency: verify Bearer token, return the IPTVUser row."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[7:].strip()
    user = get_user_from_token(token, db)
    if user is None:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    return user


class LoginRequest(BaseModel):
    base_url: str = Field(..., description="Provider host, e.g. http://r656.vip")
    username: str
    password: str
    device_type: Optional[str] = None
    preferred_output: Optional[str] = "m3u8"


class LoginResponse(BaseModel):
    token: str
    user_id: int
    provider_id: int
    is_populated: bool
    view_mode: Literal["fallback", "curated"]
    is_new_user: bool
    sync_triggered: bool
    username: str
    base_url: str
    subscription_exp_date: Optional[datetime] = None
    max_connections: Optional[int] = None
    is_trial: Optional[bool] = None


def _ts_to_dt(value) -> Optional[datetime]:
    if value in (None, "", "0"):
        return None
    try:
        return datetime.utcfromtimestamp(int(value))
    except (TypeError, ValueError):
        return None


def _maybe_int(value) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _derive_base_stream_url(base_url: str, port: Optional[int]) -> str:
    parsed = urlparse(base_url)
    host = parsed.hostname or parsed.path.rstrip("/")
    scheme = parsed.scheme or "http"
    effective_port = parsed.port or port or 80
    if effective_port in (80, 443):
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{effective_port}"


def _build_new_user(
    *,
    req: LoginRequest,
    user_info: dict,
    server_info: dict,
    provider: XtreamProvider,
    norm_host: str,
) -> IPTVUser:
    port = _maybe_int(server_info.get("port"))
    return IPTVUser(
        username=req.username,
        password=req.password,
        base_url=norm_host,
        base_stream_url=_derive_base_stream_url(norm_host, port),
        provider_id=provider.id,
        status=user_info.get("status"),
        auth=True,
        is_trial=bool(_maybe_int(user_info.get("is_trial"))),
        max_connections=_maybe_int(user_info.get("max_connections")),
        allowed_output_formats=user_info.get("allowed_output_formats"),
        message=user_info.get("message"),
        provider_created_at=_ts_to_dt(user_info.get("created_at")),
        provider_exp_date=_ts_to_dt(user_info.get("exp_date")),
        subscription_exp_date=_ts_to_dt(user_info.get("exp_date")),
        subscription_enforced=False,
        port=port,
        https_port=_maybe_int(server_info.get("https_port")),
        server_protocol=server_info.get("server_protocol"),
        rtmp_port=_maybe_int(server_info.get("rtmp_port")),
        timezone=server_info.get("timezone"),
        provider_timestamp=_maybe_int(server_info.get("timestamp_now")),
        device_type=req.device_type,
        preferred_output=req.preferred_output or "m3u8",
        is_active=True,
    )


LOGIN_PROBE_TIMEOUT_SEC = 20
FALLBACK_PROBE_TIMEOUT_SEC = 10
MAX_FALLBACK_HOSTS = 3


def _fallback_hosts(db: Session, user: IPTVUser, provider: XtreamProvider, dead_host: str) -> list[str]:
    """Known-good hosts for a returning user's provider, best first.

    Credentials are valid on every domain of a provider, so any host the DB
    knows for it (and doesn't mark unhealthy) is a candidate.
    """
    raw = [provider.base_url or "", user.base_url or ""]
    if user.base_url:
        raw.append(rewrite_to_healthy(db, provider.id, user.base_url))
    healthy = get_healthy_domain(db, provider.id)
    if healthy:
        raw.append(f"http://{healthy}")

    dead_parent = _extract_parent_domain(dead_host)
    hosts: list[str] = []
    for h in raw:
        h = normalize_base_url(h)
        if not h or h == dead_host or h in hosts:
            continue
        parent = _extract_parent_domain(h)
        if parent == dead_parent or (parent and not is_domain_healthy(db, provider.id, parent)):
            continue
        hosts.append(h)
    return hosts[:MAX_FALLBACK_HOSTS]


def _try_dead_host_fallback(db: Session, req: LoginRequest, dead_host: str):
    """The sent host is unreachable (DNS/connect). For a returning user, retry
    on another domain of their provider. Returns (client, info, host, provider)
    or None. Never mutates the user row."""
    user = db.query(IPTVUser).filter(IPTVUser.username == req.username).one_or_none()
    if user is None or user.provider_id is None:
        return None
    provider = db.get(XtreamProvider, user.provider_id)
    if provider is None:
        return None
    for host in _fallback_hosts(db, user, provider, dead_host):
        client = XtreamClient(
            base_url=host, username=req.username, password=req.password,
            timeout=FALLBACK_PROBE_TIMEOUT_SEC,
        )
        info = client.get_account_info()
        if info:
            logger.warning(
                "login: dead host rotated provider_id=%s user_id=%s %s -> %s",
                provider.id, user.id, dead_host, host,
            )
            return client, info, host, provider
    logger.warning(
        "login: dead host and no working alternative provider_id=%s user_id=%s host=%s",
        provider.id, user.id, dead_host,
    )
    return None


@router.post("/login", response_model=LoginResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    norm_host = normalize_base_url(req.base_url)
    if not norm_host:
        raise HTTPException(status_code=400, detail="invalid base_url")

    client = XtreamClient(
        base_url=norm_host, username=req.username, password=req.password,
        timeout=LOGIN_PROBE_TIMEOUT_SEC,
    )
    info = client.get_account_info()
    fallback_provider: Optional[XtreamProvider] = None
    if not info and client.last_error == "network":
        fallback = _try_dead_host_fallback(db, req, norm_host)
        if fallback:
            client, info, norm_host, fallback_provider = fallback
    if not info:
        raise HTTPException(status_code=502, detail="upstream provider unreachable")

    user_info = info.get("user_info") or {}
    if int(user_info.get("auth") or 0) != 1:
        raise HTTPException(status_code=401, detail="invalid credentials")

    if fallback_provider is not None:
        # Hand back the host we just verified, so the app persists a live domain.
        provider = fallback_provider
        response_base_url = norm_host
    else:
        try:
            provider, _reason = match_or_create_provider(db, client, norm_host)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        response_base_url = None
    db.flush()

    existing = db.query(IPTVUser).filter(IPTVUser.username == req.username).one_or_none()
    if existing is not None:
        if existing.provider_id != provider.id:
            raise HTTPException(
                status_code=409,
                detail="username already linked to a different provider",
            )
        # Existing user: per spec, login does NOT mutate any iptv_users fields.
        db.commit()
        token = create_user_token(existing.username)
        view_mode = "curated" if provider.is_populated else "fallback"
        return LoginResponse(
            token=token,
            user_id=existing.id,
            provider_id=provider.id,
            is_populated=bool(provider.is_populated),
            view_mode=view_mode,
            is_new_user=False,
            sync_triggered=False,
            username=existing.username,
            base_url=response_base_url or provider.base_url,
            subscription_exp_date=existing.subscription_exp_date,
            max_connections=existing.max_connections,
            is_trial=existing.is_trial,
        )

    server_info = info.get("server_info") or {}
    new_user = _build_new_user(
        req=req,
        user_info=user_info,
        server_info=server_info,
        provider=provider,
        norm_host=norm_host,
    )
    db.add(new_user)
    db.flush()
    if not provider.active_master_user_id:
        provider.active_master_user_id = new_user.id
    db.commit()
    db.refresh(new_user)

    sync_triggered = False
    if not provider.is_populated:
        sync_triggered = trigger_provider_sync(provider.id)

    token = create_user_token(new_user.username)
    view_mode = "curated" if provider.is_populated else "fallback"
    return LoginResponse(
        token=token,
        user_id=new_user.id,
        provider_id=provider.id,
        is_populated=bool(provider.is_populated),
        view_mode=view_mode,
        is_new_user=True,
        sync_triggered=sync_triggered,
        username=new_user.username,
        base_url=provider.base_url,
        subscription_exp_date=new_user.subscription_exp_date,
        max_connections=new_user.max_connections,
        is_trial=new_user.is_trial,
    )
