import logging
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import HEARTBEAT_CADENCE_SEC
from ..database import get_db
from ..models import IPTVUser, LiveStream, MovieStream, SeriesEpisode
from ..services.donor_service import (
    Allocation,
    allocate_or_reuse,
    build_stream_url,
    heartbeat as do_heartbeat,
    is_eligible,
    release as do_release,
)
from .auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/play", tags=["play"])


class PlayResponse(BaseModel):
    stream_url: str
    allocation_token: str
    expires_at: datetime
    slot_username: str
    heartbeat_cadence_sec: int


class HeartbeatRequest(BaseModel):
    allocation_token: str
    is_streaming: bool
    stream_kind: Optional[Literal["live", "movie", "series"]] = None
    stream_ref: Optional[str] = None


class HeartbeatResponse(BaseModel):
    expires_at: Optional[datetime]
    is_streaming: bool


class ReleaseRequest(BaseModel):
    allocation_token: str


def _allocate_or_raise(db: Session, owner: IPTVUser) -> Allocation:
    alloc = allocate_or_reuse(db, owner)
    if alloc is not None:
        return alloc
    if not is_eligible(owner):
        raise HTTPException(status_code=403, detail="subscription expired or account inactive")
    raise HTTPException(status_code=503, detail="no slot available; try again shortly")


def _play_response(alloc: Allocation, url: str) -> PlayResponse:
    return PlayResponse(
        stream_url=url,
        allocation_token=alloc.token,
        expires_at=alloc.expires_at,
        slot_username=alloc.slot.username,
        heartbeat_cadence_sec=HEARTBEAT_CADENCE_SEC,
    )


@router.post("/movie/{movie_id}", response_model=PlayResponse)
def play_movie(
    movie_id: int,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    movie = db.get(MovieStream, movie_id)
    if movie is None or movie.provider_id != user.provider_id:
        raise HTTPException(status_code=404, detail="movie not found")

    alloc = _allocate_or_raise(db, user)
    ext = movie.container_extension or "mp4"
    url = build_stream_url(alloc.slot, "movie", movie.xtream_id, ext)
    return _play_response(alloc, url)


@router.post("/live/{live_id}", response_model=PlayResponse)
def play_live(
    live_id: int,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    live = db.get(LiveStream, live_id)
    if live is None or live.provider_id != user.provider_id:
        raise HTTPException(status_code=404, detail="live stream not found")

    alloc = _allocate_or_raise(db, user)
    ext = (user.preferred_output or "m3u8")
    url = build_stream_url(alloc.slot, "live", live.stream_id, ext)
    return _play_response(alloc, url)


@router.post("/episode/{episode_id}", response_model=PlayResponse)
def play_episode(
    episode_id: int,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ep = db.get(SeriesEpisode, episode_id)
    if ep is None or ep.provider_id != user.provider_id:
        raise HTTPException(status_code=404, detail="episode not found")

    alloc = _allocate_or_raise(db, user)
    ext = ep.container_extension or "mkv"
    url = build_stream_url(alloc.slot, "series", ep.xtream_id, ext)
    return _play_response(alloc, url)


@router.post("/heartbeat", response_model=HeartbeatResponse)
def heartbeat_endpoint(
    body: HeartbeatRequest,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    alloc = do_heartbeat(
        db, user, body.allocation_token, body.is_streaming,
        stream_kind=body.stream_kind, stream_ref=body.stream_ref,
    )
    if alloc is None:
        raise HTTPException(status_code=404, detail="allocation not found or already released")
    return HeartbeatResponse(expires_at=alloc.expires_at, is_streaming=body.is_streaming)


@router.post("/release")
def release_endpoint(
    body: ReleaseRequest,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not do_release(db, user, body.allocation_token):
        raise HTTPException(status_code=404, detail="allocation not found")
    return {"released": True}


# ---------------------------------------------------------------------------
# Preview URL — direct stream URL with the user's OWN credentials, no slot
# allocation. Used by hero carousels for hover-preview clips.
# ---------------------------------------------------------------------------
#
# The single-connection cap on a provider account is policy more than a hard
# limit (providers ban abusers, not occasional double-streams), so previews
# don't need to gate on slot availability. We just hand back the same kind
# of direct stream URL the legacy app built client-side, except now the
# creds stay on the server.

class PreviewResponse(BaseModel):
    url: str


@router.get("/preview/movie/{movie_id}", response_model=PreviewResponse)
def preview_movie(
    movie_id: int,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    movie = db.get(MovieStream, movie_id)
    if movie is None or movie.provider_id != user.provider_id:
        raise HTTPException(status_code=404, detail="movie not found")
    ext = movie.container_extension or "mp4"
    url = build_stream_url(user, "movie", movie.xtream_id, ext)
    return PreviewResponse(url=url)


@router.get("/preview/episode/{episode_id}", response_model=PreviewResponse)
def preview_episode(
    episode_id: int,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ep = db.get(SeriesEpisode, episode_id)
    if ep is None or ep.provider_id != user.provider_id:
        raise HTTPException(status_code=404, detail="episode not found")
    ext = ep.container_extension or "mkv"
    url = build_stream_url(user, "series", ep.xtream_id, ext)
    return PreviewResponse(url=url)


@router.get("/preview/live/{live_id}", response_model=PreviewResponse)
def preview_live(
    live_id: int,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    live = db.get(LiveStream, live_id)
    if live is None or live.provider_id != user.provider_id:
        raise HTTPException(status_code=404, detail="live stream not found")
    ext = user.preferred_output or "m3u8"
    url = build_stream_url(user, "live", live.stream_id, ext)
    return PreviewResponse(url=url)
