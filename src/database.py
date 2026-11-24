from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from .config import DATABASE_URL

Base = declarative_base()

# 20+10 connections (default was 5+10 for a 40-thread pool + scheduler jobs);
# fail fast (10s) instead of queueing requests for 30s when exhausted.
engine = create_engine(
    DATABASE_URL, pool_pre_ping=True, pool_recycle=3600,
    pool_size=20, max_overflow=10, pool_timeout=10,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
