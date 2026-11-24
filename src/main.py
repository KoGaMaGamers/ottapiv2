import logging
import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import log_redact
from .config import SPORT_EVENTS_STATIC_DIR
from .routers import (
    admin_landing,
    admin_pressure,
    admin_providers,
    admin_sport_events,
    admin_sync,
    admin_users,
    auth,
    catalog,
    legacy_compat,
    me,
    play,
    recommendations,
    sport_events,
    subtitles,
    user_streams,
)
from .services.scheduler import start_scheduler, stop_scheduler
from .services import memwatch
from datetime import datetime, timedelta

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .database import SessionLocal, engine
from .models import SyncRun, XtreamProvider
from .services.scheduler import scheduler_running
from .services.auth_service import assert_secret_configured

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stdout,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    force=True,
)
logging.getLogger("apscheduler.scheduler").setLevel(logging.WARNING)
logging.getLogger("apscheduler.executors.default").setLevel(logging.WARNING)
logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
# httpx logs every request URL at INFO (provider creds, API keys) — noise + risk.
logging.getLogger("httpx").setLevel(logging.WARNING)
log_redact.install()


@asynccontextmanager
async def lifespan(app: FastAPI):
    assert_secret_configured()   # refuse to run with forgeable tokens
    start_scheduler()
    memwatch.start_sampler()
    yield
    memwatch.stop_sampler()
    stop_scheduler()


# No public /docs, /redoc, /openapi.json: they mapped every admin endpoint.
app = FastAPI(
    title="OTTAPI", version="0.1.0", lifespan=lifespan,
    docs_url=None, redoc_url=None, openapi_url=None,
)
if memwatch.ENABLED:
    app.add_middleware(memwatch.MemWatchMiddleware)

# CORS — needed once the frontend stops relying on the Vite same-origin
# proxy. In Tauri Android the WebView is served from `http://tauri.localhost`
# and its `shouldInterceptRequest` interceptor mangles POST bodies on
# proxied paths, so we make the frontend call the backend directly.
# Browser dev keeps using the Vite proxy (no CORS needed there) but we
# whitelist the dev origins anyway so local builds don't surprise us.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://tauri.localhost",   # Android Tauri WebView
        "https://tauri.localhost",  # iOS / future-proof
        "http://localhost:5173",    # browser dev (Vite default)
        "http://localhost:1420",    # Tauri desktop default
        # Legacy tv_app_v2 (Capacitor) WebView origins — Capacitor 5+ on
        # Android serves the bundle from https://localhost by default;
        # iOS uses capacitor://localhost. Both must be allowlisted for
        # the legacy compat shim's cross-origin fetch to work.
        "https://localhost",
        "http://localhost",
        "capacitor://localhost",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(admin_sync.router)
app.include_router(admin_providers.router)
app.include_router(admin_sport_events.router)
app.include_router(admin_pressure.router)
app.include_router(admin_users.router)
app.include_router(admin_landing.router)
app.include_router(auth.router)
app.include_router(me.router)
app.include_router(catalog.router)
app.include_router(play.router)
app.include_router(recommendations.router)
app.include_router(sport_events.router)
app.include_router(subtitles.router)
app.include_router(user_streams.router)
app.include_router(legacy_compat.router)

# Serve composite cover JPGs the sport-events skill generates.
_static_root = os.path.dirname(SPORT_EVENTS_STATIC_DIR.rstrip("/"))
os.makedirs(SPORT_EVENTS_STATIC_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=_static_root), name="static")


@app.get("/health")
def health():
    """Liveness for uptime monitors: 503 if MySQL or the scheduler is down."""
    problems = []
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as exc:
        problems.append(f"db: {type(exc).__name__}")
    if not scheduler_running():
        problems.append("scheduler not running")
    if problems:
        return JSONResponse(status_code=503, content={"status": "unhealthy", "problems": problems})
    return {"status": "healthy"}


_SYNC_MAX_AGE = timedelta(hours=36)


@app.get("/health/sync")
def health_sync():
    """Catalog freshness for uptime monitors: 503 when a populated provider
    has no successful catalog sync in 36h, or its latest catalog run failed.
    (The provider-1 sync failed silently for 7 weeks before this existed.)"""
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        out, problems = [], []
        for p in db.query(XtreamProvider).filter(XtreamProvider.is_populated == True):  # noqa: E712
            last = (db.query(SyncRun)
                    .filter(SyncRun.provider_id == p.id, SyncRun.phase == "catalog",
                            SyncRun.status != "running")
                    .order_by(SyncRun.started_at.desc()).first())
            age_h = round((now - p.last_synced_at).total_seconds() / 3600, 1) if p.last_synced_at else None
            entry = {"provider_id": p.id, "last_synced_at": p.last_synced_at,
                     "age_hours": age_h, "last_run_status": last.status if last else None}
            out.append(entry)
            if p.last_synced_at is None or now - p.last_synced_at > _SYNC_MAX_AGE:
                problems.append(f"provider {p.id}: catalog older than 36h")
            if last is not None and last.status == "failed":
                problems.append(f"provider {p.id}: last catalog run failed")
        body = {"status": "stale" if problems else "fresh", "problems": problems, "providers": out}
        return JSONResponse(status_code=503 if problems else 200, content=jsonable_encoder(body))
    finally:
        db.close()
