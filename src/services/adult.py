"""Adult-category resolution + query filtering.

Adult content lives in categories flagged `is_adult` (set at sync time by
`is_adult_category_name`). It must be excluded from every regular-content
surface (browse, search, recommendations, home rails, genre counts) and is
reachable only via the dedicated PIN-gated Adult page (`adult_only=True`) or by
direct id (detail / play, which the Adult page reuses).

These helpers centralize "which category ids are adult for this provider" and
the include/exclude predicate so the routers stay uniform.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import false, or_
from sqlalchemy.orm import Session

from ..models import LiveCategory, MovieCategory, SerieCategory


def adult_movie_category_ids(db: Session, provider_id: int) -> set[int]:
    rows = (
        db.query(MovieCategory.id)
        .filter(MovieCategory.provider_id == provider_id, MovieCategory.is_adult.is_(True))
        .all()
    )
    return {r[0] for r in rows}


def adult_serie_category_ids(db: Session, provider_id: int) -> set[int]:
    rows = (
        db.query(SerieCategory.id)
        .filter(SerieCategory.provider_id == provider_id, SerieCategory.is_adult.is_(True))
        .all()
    )
    return {r[0] for r in rows}


def adult_live_category_ids(db: Session, provider_id: int) -> set[int]:
    rows = (
        db.query(LiveCategory.id)
        .filter(LiveCategory.provider_id == provider_id, LiveCategory.is_adult.is_(True))
        .all()
    )
    return {r[0] for r in rows}


def apply_adult_filter(q, category_fk_col, adult_ids: set[int], adult_only: bool):
    """Filter a stream query by its category FK against the adult id set.

    - adult_only=True  → only rows in an adult category (empty set ⇒ no rows).
    - adult_only=False → exclude adult categories; NULL-category rows are kept
      (they're uncategorized, treated as non-adult).
    """
    if adult_only:
        return q.filter(category_fk_col.in_(adult_ids)) if adult_ids else q.filter(false())
    if adult_ids:
        return q.filter(or_(category_fk_col.notin_(adult_ids), category_fk_col.is_(None)))
    return q
