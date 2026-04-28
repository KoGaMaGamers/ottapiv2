import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .routers import (
    admin_providers,
    admin_sync,
    auth,
    catalog,
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

app.include_router(admin_sync.router)
app.include_router(admin_providers.router)
app.include_router(auth.router)
app.include_router(me.router)
app.include_router(catalog.router)
app.include_router(play.router)
app.include_router(recommendations.router)
app.include_router(subtitles.router)


@app.get("/health")
def health():
    return {"status": "healthy"}
