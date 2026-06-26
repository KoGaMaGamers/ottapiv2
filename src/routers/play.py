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
    STREAM_OK,
    STREAM_UNREACHABLE,
    allocate_or_reuse,
    build_stream_url,
    heartbeat as do_heartbeat,
    is_eligible,
    pick_url_owner,
    probe_stream_url,
    release as do_release,
    resolve_stream_url,
)
from ..services.dns_health_service import recheck_domain_now
from ..services.goldenott_sync import refresh_provider_domains_on_demand
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


class ReportBadDonorRequest(BaseModel):
    allocation_token: str
    status_code: Optional[int] = None
    detail: Optional[str] = None


def _allocate_or_raise(db: Session, owner: IPTVUser) -> Allocation:
    alloc = allocate_or_reuse(db, owner)
    if alloc is not None:
        return alloc
    if not is_eligible(owner):
        raise HTTPException(status_code=403, detail="subscription expired or account inactive")
    raise HTTPException(status_code=503, detail="no slot available; try again shortly")


# How many slots to try before giving up. These are all legit accounts, so a
# failed pre-check is treated as transient (network/path glitch) — we rotate to
# the next slot but NEVER quarantine/disable a legit account.
_MAX_DONOR_TRIES = 8


def _allocate_validated(
    db: Session, owner: IPTVUser, kind: str, xtream_id, ext: str,
) -> tuple[Allocation, str]:
    """Allocate a slot whose built stream URL responds, rotating past slots that
    don't (this request only). Returns (allocation, url).

    The pool is all legit, served-as-is accounts, so a bad pre-check verdict is
    treated as transient — we simply release the slot (LRU then hands out a
    DIFFERENT one) and try the next. We do NOT quarantine: disabling a legit
    account for 30 min over a momentary network blip is never worth it.
    """
    for attempt in range(_MAX_DONOR_TRIES):
        alloc = _allocate_or_raise(db, owner)
        url = build_stream_url(alloc.slot, kind, xtream_id, ext, db=db)
        # Resolve the panel's 302 → CDN URL server-side and hand THAT to the
        # client: ISPs commonly block the panel domain but not the CDN node.
        verdict, resolved = resolve_stream_url(url)
        if verdict == STREAM_OK:
            return alloc, resolved
        logger.info(
            "play: slot=%s(id=%d) pre-check %s (attempt %d/%d) — release + rotate (no quarantine)",
            alloc.slot.username, alloc.slot.id, verdict, attempt + 1, _MAX_DONOR_TRIES,
        )
        do_release(db, owner, alloc.token)   # release only → next LRU pick is a different slot
    raise HTTPException(status_code=503, detail="no working stream slot; try again shortly")


def _validated_preview_url(db, user, kind: str, ref: str, xtream_id, ext: str) -> str:
    """Non-locking counterpart of _allocate_validated for the preview endpoints:
    pick a slot (own creds for non-enforced users), stream-validate the URL, and
    rotate past slots that don't respond — WITHOUT quarantining (tried slots are
    excluded for this request only). Raises 503 when none yields a working URL."""
    tried: set = set()
    for _ in range(_MAX_DONOR_TRIES):
        owner = pick_url_owner(db, user, exclude_ids=tried)
        if owner is None:
            if tried:
                break   # exhausted the pool this request
            raise HTTPException(status_code=503, detail="no preview source available")
        url = build_stream_url(owner, kind, xtream_id, ext, db=db)
        # Own creds (non-enforced user) → trust without a probe.
        if owner.id == user.id:
            return url
        verdict, resolved = resolve_stream_url(url)   # panel 302 → CDN url for the device
        if verdict == STREAM_OK:
            logger.info("preview_%s: requester=%s(id=%d) -> slot=%s(id=%d) ref=%s",
                        kind, user.username, user.id, owner.username, owner.id, ref)
            return resolved
        tried.add(owner.id)   # rotate past it this request; never quarantine
    raise HTTPException(status_code=503, detail="no working preview source")


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

    ext = movie.container_extension or "mp4"
    alloc, url = _allocate_validated(db, user, "movie", movie.xtream_id, ext)
    logger.info("play_movie: requester=%s(id=%d) -> donor=%s(id=%d) url=%s",
                user.username, user.id, alloc.slot.username, alloc.slot.id, url)
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

    ext = (user.preferred_output or "m3u8")
    alloc, url = _allocate_validated(db, user, "live", live.stream_id, ext)
    logger.info("play_live: requester=%s(id=%d) -> donor=%s(id=%d) url=%s",
                user.username, user.id, alloc.slot.username, alloc.slot.id, url)
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

    ext = ep.container_extension or "mkv"
    alloc, url = _allocate_validated(db, user, "series", ep.xtream_id, ext)
    logger.info("play_episode: requester=%s(id=%d) -> donor=%s(id=%d) url=%s",
                user.username, user.id, alloc.slot.username, alloc.slot.id, url)
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


@router.post("/report-bad-donor")
def report_bad_donor_endpoint(
    body: ReportBadDonorRequest,
    user: IPTVUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Client reports the slot it just played didn't work on the device.

    We RELEASE the allocation (so the next /play LRU-picks a different slot) but
    do NOT quarantine — these are all legit accounts and a device failure is
    usually a transient network/path glitch, not a reason to disable the account.
    Idempotent: a stale token is a no-op (200 not_found=True so the client keeps
    going)."""
    slot = (
        db.query(IPTVUser)
        .filter(IPTVUser.allocation_locked_by_user_id == user.id)
        .filter(IPTVUser.allocation_lock_token == body.allocation_token)
        .filter(IPTVUser.allocation_in_use == True)  # noqa: E712
        .first()
    )
    if slot is None:
        return {"released": False, "not_found": True}

    do_release(db, user, body.allocation_token)
    logger.info("report_bad_donor (release-only, no quarantine): requester=%s(id=%d) slot=%s(id=%d) status=%s",
                user.username, user.id, slot.username, slot.id, body.status_code)
    return {"released": True, "slot_id": slot.id}


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


def _preview_url_owner(db: Session, user: IPTVUser, kind: str, ref: str) -> IPTVUser:
    """Pick whose creds belong in the preview URL. Same donor swap as
    the locking play path — without claiming a slot, since previews
    don't need one. Raises 503 when an enforced user has no donor."""
    owner = pick_url_owner(db, user)
    if owner is None:
        raise HTTPException(status_code=503, detail="no preview source available")
    if owner.id != user.id:
        logger.info("preview_%s: requester=%s(id=%d) -> donor=%s(id=%d) ref=%s",
                    kind, user.username, user.id, owner.username, owner.id, ref)
    return owner


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
    url = _validated_preview_url(db, user, "movie", str(movie_id), movie.xtream_id, ext)
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
    url = _validated_preview_url(db, user, "episode", str(episode_id), ep.xtream_id, ext)
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
    url = _validated_preview_url(db, user, "live", str(live_id), live.stream_id, ext)
    return PreviewResponse(url=url)
