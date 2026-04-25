"""Per-provider catalog sync.

Step 2 placeholder: the trigger machinery exists but the actual sync work is
filled in by step 3. For new providers, ``trigger_provider_sync`` records
intent on ``XtreamProvider.sync_started_at`` and returns True; the TV app
populates a fallback view from the upstream M3U playlist while we wait.
"""

import logging
import threading
from datetime import datetime

from ..database import SessionLocal
from ..models import XtreamProvider

logger = logging.getLogger(__name__)


def _run_sync(provider_id: int) -> None:
    db = SessionLocal()
    try:
        provider = db.get(XtreamProvider, provider_id)
        if provider is None:
            logger.warning("sync: provider id=%s not found", provider_id)
            return
        logger.info(
            "sync: provider id=%s base_url=%s — placeholder, step 3 will implement",
            provider_id, provider.base_url,
        )
        provider.sync_started_at = datetime.utcnow()
        db.commit()
    except Exception:
        logger.exception("sync: provider id=%s failed", provider_id)
        db.rollback()
    finally:
        db.close()


def trigger_provider_sync(provider_id: int) -> bool:
    """Kick off a background catalog sync for the given provider."""
    threading.Thread(
        target=_run_sync,
        args=(provider_id,),
        name=f"catalog-sync-{provider_id}",
        daemon=True,
    ).start()
    return True
