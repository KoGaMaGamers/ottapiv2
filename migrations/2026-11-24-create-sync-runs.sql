-- One row per background job run (catalog / movie_details / tmdb / goldenott)
-- so a failing sync is visible (/health/sync) instead of only in 7-day logs.
CREATE TABLE IF NOT EXISTS sync_runs (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  provider_id  INT NULL,
  phase        VARCHAR(32) NOT NULL,
  status       VARCHAR(16) NOT NULL,      -- running | ok | degraded | failed | skipped
  started_at   DATETIME NOT NULL,
  finished_at  DATETIME NULL,
  summary      TEXT NULL,                 -- JSON counts (errors trimmed)
  error        TEXT NULL,
  KEY ix_sync_runs_provider_phase_started (provider_id, phase, started_at)
);
