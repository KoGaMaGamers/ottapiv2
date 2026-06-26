import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from ..config import GOLDENOTT_PROVIDER_ID
from ..database import SessionLocal
from ..models import IPTVUser, XtreamProvider
from .dns_health_service import (
    _extract_parent_domain,
    check_dns_health,
    is_domain_healthy,
    get_healthy_domain,
    upsert_domain,
)
from .goldenott_client import GoldenOTTClient

logger = logging.getLogger(__name__)

# On-demand domain refresh throttle: at most one GoldenOTT /domains call per
# provider per window, so a burst of plays hitting a rotated domain doesn't
# hammer the API (or trip its 429 limiter). The last-refresh time is persisted
# on xtream_providers.domains_refreshed_at so it survives restarts and is the
# throttle source of truth (no per-process in-memory state).
_DOMAIN_REFRESH_THROTTLE_SEC = 60


def last_domain_refresh_at(db: Session, provider_id: int) -> Optional[datetime]:
    """When GoldenOTT /domains was last fetched for this provider (on-demand or
    scheduled), or None. Read from the persisted provider row."""
    provider = db.get(XtreamProvider, provider_id)
    return provider.domains_refreshed_at if provider else None


def _register_domain_healthy(db: Session, provider_id: int, raw_domain: str) -> Optional[str]:
    """Upsert *raw_domain* into provider_dns_entries and probe it now so
    rewrite_to_healthy can immediately route through it. Returns the parent
    domain if it probed healthy, else None."""
    parent = _extract_parent_domain(raw_domain or "")
    if not parent:
        return None
    entry = upsert_domain(db, provider_id, parent)
    return parent if check_dns_health(db, entry) else None


def refresh_provider_domains_on_demand(
    db: Session, provider_id: int, *, force: bool = False,
) -> Optional[str]:
    """Ask GoldenOTT for the provider's CURRENT domain(s) — the authoritative
    rotation source — register/probe them in provider_dns_entries, refresh
    provider.base_url, and return a healthy domain (or None).

    Hot-path safe: only for the GoldenOTT-managed provider, throttled per
    provider, short timeout, fully guarded. Called when a donor stream URL is
    UNREACHABLE and no healthy domain is already known (likely a rotation to a
    brand-new domain the periodic sweep hasn't caught yet).
    """
    if provider_id != GOLDENOTT_PROVIDER_ID:
        return None
    now = datetime.utcnow()
    provider = db.get(XtreamProvider, provider_id)
    last = provider.domains_refreshed_at if provider else None
    if not force and last and (now - last).total_seconds() < _DOMAIN_REFRESH_THROTTLE_SEC:
        return get_healthy_domain(db, provider_id)
    # Stamp + commit the attempt up front so a failed/slow call still throttles
    # the next play (and the timestamp persists across restarts).
    if provider:
        provider.domains_refreshed_at = now
        db.commit()

    try:
        client = GoldenOTTClient(timeout=8)
        domains = client.get_domains()
    except Exception as exc:
        logger.warning("on-demand GoldenOTT get_domains failed: %s", exc)
        return get_healthy_domain(db, provider_id)
    if not domains:
        return get_healthy_domain(db, provider_id)

    healthy: Optional[str] = None
    for d in domains:
        got = _register_domain_healthy(db, provider_id, d.get("domain") or "")
        if got and healthy is None:
            healthy = got

    # Keep the provider brand URL current too.
    new_url = _normalize_domain_to_url(domains[0].get("domain") or "")
    provider = db.get(XtreamProvider, provider_id)
    if provider and new_url and (provider.base_url or "").rstrip("/") != new_url.rstrip("/"):
        logger.info("on-demand brand domain update provider=%d: %s -> %s",
                    provider_id, provider.base_url, new_url)
        provider.base_url = new_url

    db.commit()
    return healthy or get_healthy_domain(db, provider_id)

REMOVED_STATUS = "Removed"


@dataclass
class SyncSummary:
    provider_id: int
    brand_domain_before: Optional[str] = None
    brand_domain_after: Optional[str] = None
    brand_domain_changed: bool = False
    lines_seen: int = 0
    users_created: int = 0
    users_updated: int = 0
    users_reactivated: int = 0
    users_removed: int = 0
    users_kept_enforced: int = 0
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "provider_id": self.provider_id,
            "brand_domain_before": self.brand_domain_before,
            "brand_domain_after": self.brand_domain_after,
            "brand_domain_changed": self.brand_domain_changed,
            "lines_seen": self.lines_seen,
            "users_created": self.users_created,
            "users_updated": self.users_updated,
            "users_reactivated": self.users_reactivated,
            "users_removed": self.users_removed,
            "users_kept_enforced": self.users_kept_enforced,
            "errors": self.errors,
        }


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except (ValueError, AttributeError):
        return None


def _derive_base_stream_url(dns_link: str, port: Optional[int]) -> str:
    parsed = urlparse(dns_link)
    host = parsed.hostname or parsed.path.rstrip("/")
    scheme = parsed.scheme or "http"
    effective_port = parsed.port or port or 80
    if effective_port in (80, 443):
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{effective_port}"


def _normalize_domain_to_url(domain: str) -> str:
    domain = (domain or "").strip().rstrip("/")
    if not domain:
        return ""
    if "://" in domain:
        return domain
    return f"http://{domain}"


def sync_brand_domain(
    db: Session,
    client: GoldenOTTClient,
    provider_id: int,
    summary: SyncSummary,
) -> None:
    domains = client.get_domains()
    if not domains:
        summary.errors.append("no domains returned by /v1/account/domains")
        return

    brand_domain = domains[0].get("domain")
    new_url = _normalize_domain_to_url(brand_domain or "")
    if not new_url:
        summary.errors.append("empty domain in /v1/account/domains response")
        return

    provider = db.get(XtreamProvider, provider_id)
    if provider is None:
        summary.errors.append(f"provider id={provider_id} not found")
        return

    # Record the GoldenOTT /domains fetch time (committed by run_sync).
    provider.domains_refreshed_at = datetime.utcnow()
    summary.brand_domain_before = provider.base_url
    summary.brand_domain_after = new_url

    # Register + probe the brand domain so provider_dns_entries tracks it and
    # rewrite_to_healthy can route through it immediately (previously the brand
    # domain was only health-tracked once a per-user line carried it).
    _register_domain_healthy(db, provider_id, brand_domain)

    if (provider.base_url or "").rstrip("/") == new_url.rstrip("/"):
        return

    provider.base_url = new_url
    summary.brand_domain_changed = True
    logger.info(
        "Brand domain updated for provider %d: %s -> %s",
        provider_id, summary.brand_domain_before, new_url,
    )


def _apply_line_to_user(
    db: Session, user: IPTVUser, detail: dict, provider_id: int, line_id: int,
) -> None:
    upstream_exp = _parse_iso_datetime(detail.get("exp_date"))

    user.reseller_line_id = line_id
    user.username = detail.get("username") or user.username
    if detail.get("password"):
        user.password = detail["password"]
    user.provider_id = provider_id

    user.is_trial = bool(detail.get("is_trial"))
    if detail.get("max_connections") is not None:
        try:
            user.max_connections = int(detail["max_connections"])
        except (TypeError, ValueError):
            pass

    dns_link = (detail.get("dns_link") or "").rstrip("/")
    if dns_link:
        # GoldenOTT's per-line dns_link is the AUTHORITATIVE server for this
        # account — accept it verbatim. Each donor lives on its own server, and
        # the creds are tied to it, so we never rewrite the domain to a shared
        # "healthy" one (that would corrupt the slot). A slot whose server is
        # down simply fails the play-time pre-check and rotation picks another.
        parent = _extract_parent_domain(dns_link)
        if parent:
            # Still track the domain for observability (admin donor-health).
            upsert_domain(db, provider_id, parent)
        user.base_url = dns_link
        user.base_stream_url = _derive_base_stream_url(dns_link, user.port)

    user.provider_exp_date = upstream_exp
    if not user.subscription_enforced:
        user.subscription_exp_date = upstream_exp


def sync_lines(
    db: Session,
    client: GoldenOTTClient,
    provider_id: int,
    summary: SyncSummary,
) -> None:
    upstream_lines: list[dict] = []
    page = 1
    while True:
        body = client.list_lines_page(page=page, per_page=100)
        if not body or not body.get("success"):
            summary.errors.append(
                f"lines list fetch failed at page {page}; aborting (no removals applied)"
            )
            return
        upstream_lines.extend(body.get("data") or [])
        pag = body.get("pagination") or {}
        current = int(pag.get("current_page") or page)
        last = int(pag.get("last_page") or current)
        if current >= last:
            break
        page = current + 1

    summary.lines_seen = len(upstream_lines)
    upstream_line_ids: set[int] = set()
    upstream_usernames: set[str] = set()
    detail_failures = 0

    for line_summary in upstream_lines:
        raw_line_id = line_summary.get("id")
        username = line_summary.get("username")
        upstream_status = line_summary.get("status")
        if not raw_line_id or not username:
            continue
        line_id = int(raw_line_id)
        upstream_line_ids.add(line_id)
        upstream_usernames.add(username)

        detail = client.get_line(line_id)
        if not detail:
            summary.errors.append(f"line {line_id} ({username}): detail fetch failed")
            detail_failures += 1
            continue

        existing = (
            db.query(IPTVUser)
            .filter(IPTVUser.reseller_line_id == line_id)
            .one_or_none()
        )
        if existing is None:
            existing = (
                db.query(IPTVUser)
                .filter(IPTVUser.username == username)
                .one_or_none()
            )

        was_removed = existing is not None and (existing.status == REMOVED_STATUS)

        if existing is None:
            existing = IPTVUser(
                username=username,
                password=detail.get("password") or "",
                base_url="",
                provider_id=provider_id,
                subscription_enforced=False,
            )
            db.add(existing)
            summary.users_created += 1
        elif was_removed:
            summary.users_reactivated += 1
        else:
            summary.users_updated += 1

        _apply_line_to_user(db, existing, detail, provider_id, line_id)
        existing.status = upstream_status
        existing.last_checked_at = datetime.utcnow()

    if detail_failures > 0 and detail_failures == len(upstream_lines):
        summary.errors.append(
            "all line detail fetches failed; aborting removal phase"
        )
        return

    now = datetime.utcnow()
    locally_active = (
        db.query(IPTVUser)
        .filter(IPTVUser.provider_id == provider_id)
        .filter(IPTVUser.status != REMOVED_STATUS)
        .all()
    )
    for user in locally_active:
        in_upstream = (
            (user.reseller_line_id is not None and user.reseller_line_id in upstream_line_ids)
            or (user.reseller_line_id is None and user.username in upstream_usernames)
        )
        if in_upstream:
            continue
        if user.subscription_enforced and user.subscription_exp_date and user.subscription_exp_date > now:
            summary.users_kept_enforced += 1
            continue
        user.status = REMOVED_STATUS
        user.last_checked_at = now
        summary.users_removed += 1
        logger.info("Soft-removed user %s (no longer in upstream)", user.username)


def run_sync(provider_id: Optional[int] = None) -> dict:
    """Top-level entry point. Opens a session, runs both phases, commits, returns summary dict."""
    pid = provider_id if provider_id is not None else GOLDENOTT_PROVIDER_ID
    summary = SyncSummary(provider_id=pid)
    client = GoldenOTTClient()

    db: Session = SessionLocal()
    try:
        sync_brand_domain(db, client, pid, summary)
        sync_lines(db, client, pid, summary)
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.exception("GoldenOTT sync failed for provider %s", pid)
        summary.errors.append(f"unhandled: {exc}")
    finally:
        db.close()

    logger.info("GoldenOTT sync done: %s", summary.to_dict())
    return summary.to_dict()
