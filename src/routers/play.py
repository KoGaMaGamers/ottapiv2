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
    report_bad_donor,
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


# How many donors to try before giving up. Each bad donor (stream URL the panel
# rejects with 406/4xx — dead, expired, or at its connection limit) is
# quarantined and we rotate to the next, so the client never sees the 406.
_MAX_DONOR_TRIES = 4


def _allocate_validated(
    db: Session, owner: IPTVUser, kind: str, xtream_id, ext: str,
) -> tuple[Allocation, str]:
    """Allocate a donor whose built stream URL actually responds, rotating past
    donors the panel rejects. Returns (allocation, url).

    Pre-validating server-side turns the old client-visible 406/ERR_NET_IO
    (intermittent, retry-to-win) into a single request that already holds a
    working URL — without consuming the donor's connection slot (see
    check_stream_url). Self-heals: rejected donors are quarantined so later
    plays skip them.
    """
    for attempt in range(_MAX_DONOR_TRIES):
        alloc = _allocate_or_raise(db, owner)
        url = build_stream_url(alloc.slot, kind, xtream_id, ext, db=db)
        verdict, url = _probe_with_recovery(db, alloc.slot, kind, xtream_id, ext, url)
        if verdict == STREAM_OK:
            return alloc, url
        logger.info(
            "play: donor=%s(id=%d) failed stream pre-check (%s, attempt %d/%d) — rotating",
            alloc.slot.username, alloc.slot.id, verdict, attempt + 1, _MAX_DONOR_TRIES,
        )
        report_bad_donor(db, alloc.slot, reason=f"stream pre-check {verdict}")
        do_release(db, owner, alloc.token)
    raise HTTPException(status_code=503, detail="no working stream slot; try again shortly")


def _probe_with_recovery(db, slot, kind, xtream_id, ext, url):
    """Probe a built donor stream URL and, on an UNREACHABLE verdict (provider
    domain rotation), try to recover it through a healthy sibling domain or a
    fresh GoldenOTT /domains fetch. Returns (verdict, url) — verdict is
    STREAM_OK with the working (possibly rewritten) url, else the failing
    verdict with the original url."""
    verdict = probe_stream_url(url)
    if verdict == STREAM_OK:
        return STREAM_OK, url
    if verdict == STREAM_UNREACHABLE:
        # (1) Cheap: re-probe this donor's domain; if it just died,
        # build_stream_url routes through a healthy sibling we already know.
        recheck_domain_now(db, slot.provider_id, url)
        url2 = build_stream_url(slot, kind, xtream_id, ext, db=db)
        if url2 != url and probe_stream_url(url2) == STREAM_OK:
            logger.info("play: donor=%s(id=%d) recovered via known healthy domain",
                        slot.username, slot.id)
            return STREAM_OK, url2
        # (2) Authoritative: the provider may have rotated to a brand-new domain
        # we don't know yet — ask GoldenOTT (throttled), register it, rebuild.
        if refresh_provider_domains_on_demand(db, slot.provider_id):
            url3 = build_stream_url(slot, kind, xtream_id, ext, db=db)
            if url3 not in (url, url2) and probe_stream_url(url3) == STREAM_OK:
                logger.info("play: donor=%s(id=%d) recovered via GoldenOTT domain refresh",
                            slot.username, slot.id)
                return STREAM_OK, url3
    return verdict, url


def _validated_preview_url(db, user, kind: str, ref: str, xtream_id, ext: str) -> str:
    """Non-locking counterpart of _allocate_validated for the preview endpoints:
    pick a donor (own creds for non-enforced users), stream-validate the URL, and
    rotate past donors the panel rejects. Quarantine makes the next pick skip the
    bad one. Raises 503 when no donor yields a working URL."""
    for _ in range(_MAX_DONOR_TRIES):
        owner = pick_url_owner(db, user)
        if owner is None:
            raise HTTPException(status_code=503, detail="no preview source available")
        url = build_stream_url(owner, kind, xtream_id, ext, db=db)
        # Own creds (non-enforced user) → trust without a probe.
        if owner.id == user.id:
            return url
        verdict, url = _probe_with_recovery(db, owner, kind, xtream_id, ext, url)
        if verdict == STREAM_OK:
            logger.info("preview_%s: requester=%s(id=%d) -> donor=%s(id=%d) ref=%s",
                        kind, user.username, user.id, owner.username, owner.id, ref)
            return url
        report_bad_donor(db, owner, reason=f"preview pre-check {verdict}")
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
    """Client tells us the donor URL it just played returned 401.

    We quarantine that slot and release the allocation so the next /play
    call lands on a different donor. Idempotent — a stale token after a
    sweeper-driven release is treated as a no-op (200 with not_found=True
    rather than 404, since the client wants to keep going)."""
    slot = (
        db.query(IPTVUser)
        .filter(IPTVUser.allocation_locked_by_user_id == user.id)
        .filter(IPTVUser.allocation_lock_token == body.allocation_token)
        .filter(IPTVUser.allocation_in_use == True)  # noqa: E712
        .first()
    )
    if slot is None:
        return {"quarantined": False, "released": False, "not_found": True}

    if slot.id == user.id:
        # Client reported a 401 against the user's *own* slot. That's not
        # a donor-pool problem to fix here — release the lock so the next
        # /play forces the enforced-renter donor swap to re-evaluate.
        do_release(db, user, body.allocation_token)
        return {"quarantined": False, "released": True, "self": True}

    reason = f"client {body.status_code or '401'}"
    if body.detail:
        reason = f"{reason}: {body.detail[:100]}"
    report_bad_donor(db, slot, reason=reason)
    do_release(db, user, body.allocation_token)
    logger.info("report_bad_donor: requester=%s(id=%d) slot=%s(id=%d) reason=%s",
                user.username, user.id, slot.username, slot.id, reason)
    return {"quarantined": True, "released": True, "slot_id": slot.id}


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
