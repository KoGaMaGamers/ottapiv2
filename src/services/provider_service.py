import hashlib
import json
import logging
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from ..config import GOLDENOTT_PROVIDER_ID
from ..models import XtreamProvider
from .xtream_client import XtreamClient

logger = logging.getLogger(__name__)

FINGERPRINT_SAMPLE_SIZE = 500


def normalize_base_url(raw: str) -> str:
    parsed = urlparse((raw or "").strip())
    scheme = (parsed.scheme or "http").lower()
    host = (parsed.hostname or parsed.path).lower().rstrip("/")
    if not host:
        return ""
    port = parsed.port
    if port and port not in (80, 443):
        return f"{scheme}://{host}:{port}"
    return f"{scheme}://{host}"


def _build_sample(streams: list[dict]) -> list[dict]:
    sorted_streams = sorted(streams, key=lambda s: (s.get("name") or "").lower())
    total = len(sorted_streams)
    if total == 0:
        return []
    step = max(1, total // FINGERPRINT_SAMPLE_SIZE)
    sampled = sorted_streams[::step][:FINGERPRINT_SAMPLE_SIZE]
    return [
        {"name": s.get("name"), "stream_id": s.get("stream_id"), "epg_channel_id": s.get("epg_channel_id")}
        for s in sampled
    ]


def generate_fingerprint(sample: list[dict]) -> str:
    sorted_sample = sorted(sample, key=lambda x: (x.get("name") or "").lower())
    raw = json.dumps(sorted_sample, sort_keys=True, ensure_ascii=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def compute_fingerprint(client: XtreamClient) -> tuple[Optional[str], list[dict]]:
    streams = client.get_live_streams() or []
    sample = _build_sample(streams)
    if not sample:
        return None, []
    return generate_fingerprint(sample), sample


def _auth_succeeds(base_url: str, username: str, password: str) -> bool:
    info = XtreamClient(base_url=base_url, username=username, password=password, timeout=15).get_account_info()
    if not info:
        return False
    user_info = info.get("user_info") or {}
    try:
        return int(user_info.get("auth") or 0) == 1
    except (TypeError, ValueError):
        return False


def match_or_create_provider(
    db: Session,
    client: XtreamClient,
    raw_base_url: str,
) -> tuple[XtreamProvider, str]:
    """
    Returns (provider, match_reason) where match_reason is one of:
      'url' | 'brand_domain_auth' | 'created'
    """
    norm = normalize_base_url(raw_base_url)
    if not norm:
        raise ValueError("invalid base_url")

    for p in db.query(XtreamProvider).all():
        if normalize_base_url(p.base_url or "") == norm:
            if (p.base_url or "") != norm:
                p.base_url = norm
            return p, "url"

    if GOLDENOTT_PROVIDER_ID:
        brand = db.get(XtreamProvider, GOLDENOTT_PROVIDER_ID)
        brand_url = normalize_base_url(brand.base_url) if brand and brand.base_url else ""
        if brand_url and brand_url != norm and _auth_succeeds(brand_url, client.username, client.password):
            logger.info(
                "Login: creds for %s authed against brand domain %s -> provider id=%s",
                client.username, brand_url, brand.id,
            )
            return brand, "brand_domain_auth"

    fp, sample = compute_fingerprint(client)
    provider = XtreamProvider(
        base_url=norm,
        fingerprint=fp,
        fingerprint_sample=sample,
        is_populated=False,
    )
    db.add(provider)
    db.flush()
    logger.info("Created provider id=%s base_url=%s", provider.id, norm)
    return provider, "created"
