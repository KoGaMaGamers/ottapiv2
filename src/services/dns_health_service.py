"""Provider DNS health tracking.

Maintains ``provider_dns_entries`` — a table of known parent domains per
provider with periodic TCP health probes.  Other modules use this to:

- Guard against GoldenOTT sync overwriting a working base_url with a
  dead dns_link (``get_healthy_domain``).
- Build stream URLs through a live domain even when a slot's stored
  base_url points at dead infrastructure (``rewrite_to_healthy``).

The scheduler calls ``check_all_dns_health`` every 5 minutes; it probes
port 80 on a sample subdomain and flips ``is_healthy``.
"""

import logging
import socket
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy import update
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models import IPTVUser, ProviderDnsEntry

logger = logging.getLogger(__name__)

_TCP_PROBE_TIMEOUT = 3.5  # seconds
_PROBE_SUBDOMAIN = "healthcheck"  # arbitrary; wildcard DNS resolves any sub


# ---------------------------------------------------------------------------
# Seed / upsert
# ---------------------------------------------------------------------------

def _extract_parent_domain(url_or_host: str) -> Optional[str]:
    """'http://abc.kynetron.cc/…' → 'kynetron.cc'"""
    host = urlparse(url_or_host).hostname if "://" in url_or_host else url_or_host
    if not host:
        return None
    parts = host.split(".")
    if len(parts) < 2:
        return None
    return ".".join(parts[-2:])


def upsert_domain(db: Session, provider_id: int, domain: str) -> ProviderDnsEntry:
    """Ensure a row exists for (provider_id, domain). Returns the row."""
    entry = (
        db.query(ProviderDnsEntry)
        .filter(ProviderDnsEntry.provider_id == provider_id,
                ProviderDnsEntry.domain == domain)
        .first()
    )
    if entry is None:
        entry = ProviderDnsEntry(provider_id=provider_id, domain=domain)
        db.add(entry)
        db.flush()
        logger.info("dns_health: new domain provider=%d domain=%s", provider_id, domain)
    return entry


def seed_from_users(db: Session, provider_id: Optional[int] = None) -> int:
    """Walk iptv_users and upsert every distinct parent domain seen.
    Returns the number of new rows created."""
    q = db.query(IPTVUser.provider_id, IPTVUser.base_url)
    if provider_id is not None:
        q = q.filter(IPTVUser.provider_id == provider_id)
    q = q.filter(IPTVUser.base_url.isnot(None)).distinct()

    seen: set[tuple[int, str]] = set()
    for pid, base_url in q.all():
        domain = _extract_parent_domain(base_url)
        if domain and (pid, domain) not in seen:
            seen.add((pid, domain))

    before = db.query(ProviderDnsEntry).count()
    for pid, domain in seen:
        upsert_domain(db, pid, domain)
    db.commit()
    after = db.query(ProviderDnsEntry).count()
    created = after - before
    if created:
        logger.info("dns_health: seeded %d new domain(s)", created)
    return created


# ---------------------------------------------------------------------------
# Probe
# ---------------------------------------------------------------------------

def _probe_domain(domain: str, port: int = 80) -> tuple[bool, list[str]]:
    """TCP connect probe on ``{_PROBE_SUBDOMAIN}.{domain}:{port}``.
    Returns (reachable, resolved_ips)."""
    host = f"{_PROBE_SUBDOMAIN}.{domain}"
    ips: list[str] = []
    try:
        ips = [ai[4][0] for ai in socket.getaddrinfo(host, port, socket.AF_INET)]
        ips = list(dict.fromkeys(ips))  # dedupe, preserve order
    except socket.gaierror:
        return False, []

    if not ips:
        return False, []

    # Probe the first IP
    try:
        sock = socket.create_connection((ips[0], port), timeout=_TCP_PROBE_TIMEOUT)
        sock.close()
        return True, ips
    except (OSError, socket.timeout):
        return False, ips


def check_dns_health(db: Session, entry: ProviderDnsEntry) -> bool:
    """Probe one entry, update its state, return is_healthy."""
    now = datetime.utcnow()
    healthy, ips = _probe_domain(entry.domain)

    entry.is_healthy = healthy
    entry.last_checked_at = now
    entry.resolved_ips = ips
    if healthy:
        entry.last_healthy_at = now

    db.flush()
    return healthy


def check_all_dns_health(db: Optional[Session] = None) -> dict:
    """Probe every domain in the table. Returns summary dict."""
    own_session = db is None
    if own_session:
        db = SessionLocal()
    try:
        entries = db.query(ProviderDnsEntry).all()
        results = {"total": len(entries), "healthy": 0, "unhealthy": 0, "changed": []}

        for entry in entries:
            was_healthy = entry.is_healthy
            now_healthy = check_dns_health(db, entry)
            if now_healthy:
                results["healthy"] += 1
            else:
                results["unhealthy"] += 1
            if was_healthy != now_healthy:
                direction = "UP" if now_healthy else "DOWN"
                results["changed"].append(f"{entry.domain} -> {direction}")
                logger.warning("dns_health: %s provider=%d domain=%s ips=%s",
                               direction, entry.provider_id, entry.domain, entry.resolved_ips)

        db.commit()
        if results["changed"]:
            logger.info("dns_health check: %s", results)
        return results
    except Exception:
        logger.exception("dns_health check failed")
        if own_session:
            db.rollback()
        return {"error": True}
    finally:
        if own_session:
            db.close()


# ---------------------------------------------------------------------------
# Lookup helpers (used by sync + donor_service)
# ---------------------------------------------------------------------------

def recheck_domain_now(db: Session, provider_id: int, url_or_host: str) -> Optional[bool]:
    """On-demand re-probe of the parent domain behind *url_or_host*.

    Used when a donor stream URL comes back unreachable: instead of waiting up
    to 5 min for the scheduled sweep, probe the domain immediately and persist
    its health. Returns the new is_healthy (True/False), or None if no parent
    domain could be parsed. After this, ``build_stream_url`` /
    ``rewrite_to_healthy`` will route around a domain that just rotated away.
    """
    parent = _extract_parent_domain(url_or_host)
    if not parent:
        return None
    entry = upsert_domain(db, provider_id, parent)
    healthy = check_dns_health(db, entry)
    db.commit()
    if not healthy:
        logger.warning("dns recheck: provider=%d domain=%s is DOWN (rotation?)",
                       provider_id, parent)
    return healthy


def get_healthy_domain(db: Session, provider_id: int) -> Optional[str]:
    """Return any healthy parent domain for this provider, or None."""
    entry = (
        db.query(ProviderDnsEntry)
        .filter(ProviderDnsEntry.provider_id == provider_id,
                ProviderDnsEntry.is_healthy == True)  # noqa: E712
        .order_by(ProviderDnsEntry.last_healthy_at.desc())
        .first()
    )
    return entry.domain if entry else None


def is_domain_healthy(db: Session, provider_id: int, domain: str) -> bool:
    """Check if a specific parent domain is currently marked healthy."""
    entry = (
        db.query(ProviderDnsEntry)
        .filter(ProviderDnsEntry.provider_id == provider_id,
                ProviderDnsEntry.domain == domain)
        .first()
    )
    if entry is None:
        return True  # unknown domain — don't block, let it through
    return entry.is_healthy


def rewrite_to_healthy(db: Session, provider_id: int, base_url: str) -> str:
    """If *base_url*'s parent domain is unhealthy, swap it to a healthy
    one keeping the original subdomain prefix. Returns the URL unchanged
    when the domain is healthy or no alternative exists."""
    parsed = urlparse(base_url)
    host = parsed.hostname or ""
    parts = host.split(".")
    if len(parts) < 2:
        return base_url

    parent = ".".join(parts[-2:])
    if is_domain_healthy(db, provider_id, parent):
        return base_url

    alt = get_healthy_domain(db, provider_id)
    if alt is None or alt == parent:
        return base_url  # no alternative — nothing we can do

    subdomain = ".".join(parts[:-2])
    new_host = f"{subdomain}.{alt}" if subdomain else alt
    port_str = f":{parsed.port}" if parsed.port and parsed.port not in (80, 443) else ""
    scheme = parsed.scheme or "http"
    new_url = f"{scheme}://{new_host}{port_str}"
    logger.debug("dns rewrite: %s -> %s", base_url, new_url)
    return new_url
