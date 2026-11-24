-- One-off ops cleanup (NOT auto-run). EXECUTED 2026-11-24 on the owner's request.
-- Provider 8 (r656.vip): domain no longer resolves (NXDOMAIN), its only user
-- (iptv_users.id=93) last heartbeat 2026-04-26; its "successful" syncs since
-- were empty fetches. Pre-removal copy: /var/backups/ottapi/daily/ottapi-20261124-1154.sql.gz
-- Child-first order (several FKs are NO ACTION; live_categories self-references).
START TRANSACTION;

UPDATE xtream_providers SET active_master_user_id = NULL WHERE id = 8;
DELETE FROM iptv_users WHERE provider_id = 8;

DELETE FROM live_stream_aliases WHERE provider_id = 8;

DELETE FROM movie_streams    WHERE provider_id = 8;   -- cascades movie_stream_genres
DELETE FROM movie_categories WHERE provider_id = 8;

DELETE FROM series_episodes  WHERE provider_id = 8;
DELETE FROM series_seasons   WHERE provider_id = 8;
DELETE FROM series_streams   WHERE provider_id = 8;   -- cascades series_stream_genres
DELETE FROM serie_categories WHERE provider_id = 8;

DELETE FROM live_streams WHERE provider_id = 8;
UPDATE live_categories SET parent_id = NULL WHERE provider_id = 8;
DELETE FROM live_categories WHERE provider_id = 8;

DELETE FROM provider_pressure_samples      WHERE provider_id = 8;
DELETE FROM provider_dns_entries           WHERE provider_id = 8;
DELETE FROM provider_identity_quarantines  WHERE provider_id = 8;
DELETE FROM provider_refresh_tasks         WHERE provider_id = 8;
DELETE FROM provider_drift_runs            WHERE provider_id = 8;
DELETE FROM sync_runs                      WHERE provider_id = 8;

DELETE FROM xtream_providers WHERE id = 8;

COMMIT;
