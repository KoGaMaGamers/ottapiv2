import os
from pathlib import Path

from dotenv import load_dotenv

_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_ENV_PATH)


def _get(key: str, default: str = "") -> str:
    return os.getenv(key, default)


def _get_int(key: str, default: int) -> int:
    raw = os.getenv(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


DB_HOST = _get("DB_HOST", "localhost")
DB_PORT = _get_int("DB_PORT", 3306)
DB_DATABASE = _get("DB_DATABASE", "ottapi")
DB_USERNAME = _get("DB_USERNAME", "")
DB_PASSWORD = _get("DB_PASSWORD", "")

DATABASE_URL = (
    os.getenv("DATABASE_URL")
    or f"mysql+pymysql://{DB_USERNAME}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_DATABASE}"
)

GOLDENOTT_API_URL = _get("GOLDENOTT_API_URL", "https://goldenott.net/api").rstrip("/")
GOLDENOTT_API_KEY = _get("GOLDENOTT_API_KEY", "")
GOLDENOTT_PROVIDER_ID = _get_int("GOLDENOTT_PROVIDER_ID", 1)
GOLDENOTT_SYNC_INTERVAL_HOURS = _get_int("GOLDENOTT_SYNC_INTERVAL_HOURS", 6)

CATALOG_SYNC_INTERVAL_HOURS = _get_int("CATALOG_SYNC_INTERVAL_HOURS", 24)

ALLOCATION_TTL_SEC = _get_int("ALLOCATION_TTL_SEC", 300)
HEARTBEAT_CADENCE_SEC = _get_int("HEARTBEAT_CADENCE_SEC", 120)
ALLOCATION_SWEEP_INTERVAL_SEC = _get_int("ALLOCATION_SWEEP_INTERVAL_SEC", 60)

SUBDL_API_KEY = _get("SUBDL_API_KEY", "")

TMDB_BEARER_TOKEN = _get("TMDB_BEARER_TOKEN", "")
TMDB_API_KEY = _get("TMDB_API_KEY", "")

ADMIN_SECRET = _get("ADMIN_SECRET", "")
