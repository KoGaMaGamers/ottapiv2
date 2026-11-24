-- Soft-delete for catalog rows the provider no longer lists. Rows with
-- removed_at set are hidden from every ORM query (models.py loader
-- criteria) and revived if they reappear upstream. MySQL 8: INSTANT.
ALTER TABLE live_streams   ADD COLUMN removed_at DATETIME NULL;
ALTER TABLE movie_streams  ADD COLUMN removed_at DATETIME NULL;
ALTER TABLE series_streams ADD COLUMN removed_at DATETIME NULL;
