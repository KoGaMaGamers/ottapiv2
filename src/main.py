import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import (
    admin_providers,
    admin_sync,
    auth,
    catalog,
    legacy_compat,
    me,
    play,
    recommendations,
    subtitles,
)
from .services.scheduler import start_scheduler, stop_scheduler

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


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(title="OTTAPI", version="0.1.0", lifespan=lifespan)

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
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(admin_sync.router)
app.include_router(admin_providers.router)
app.include_router(auth.router)
app.include_router(me.router)
app.include_router(catalog.router)
app.include_router(play.router)
app.include_router(recommendations.router)
app.include_router(subtitles.router)
app.include_router(legacy_compat.router)


@app.get("/health")
def health():
    return {"status": "healthy"}
