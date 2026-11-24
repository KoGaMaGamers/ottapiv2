-- TMDB enrichment backoff: unmatched titles were retried on every daily run
-- forever (~18k misses/day, most of the 45-min run). Track attempts and retry
-- after 1d, 7d, 30d, then every 90d. MySQL 8: ADD COLUMN is INSTANT.
ALTER TABLE movie_streams
  ADD COLUMN tmdb_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN tmdb_last_attempt_at DATETIME NULL;
ALTER TABLE series_streams
  ADD COLUMN tmdb_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN tmdb_last_attempt_at DATETIME NULL;
