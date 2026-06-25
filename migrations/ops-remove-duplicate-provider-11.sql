-- One-off ops cleanup: remove duplicate provider id=11 (entve.candymarta.com).
-- EXECUTED 2026-06-25 — kept for the record. ~334k catalog rows + ~104k
-- telemetry rows removed; providers 1 (poatan.org) and 8 (r656.vip) untouched.
--
-- Context: provider 11 was a duplicate of provider 1 (poatan.org) reached via a
-- different domain. Provider matching is by normalized base_url (NOT by the
-- stored fingerprint, which is computed from live streams and never compared),
-- so the different domain spawned a second provider row. Provider 11 had ZERO
-- iptv_users, so it served nobody. Because creds are domain-agnostic, the
-- GoldenOTT brand-domain auth (GOLDENOTT_PROVIDER_ID=1) consolidates future
-- entve.candymarta.com logins back onto provider 1.
--
-- A plain `DELETE FROM xtream_providers WHERE id=11` FAILS: the provider-level
-- CASCADE cannot resolve live_categories' self-referential parent_id FK, and
-- several catalog FKs are NO ACTION (streams must go before their categories,
-- aliases before streams). So delete child-first explicitly, then the provider
-- row (which by then has nothing left to cascade).
--
--   mysql <db> < migrations/ops-remove-duplicate-provider-11.sql

START TRANSACTION;

-- aliases reference live_streams (NO ACTION) — clear before live_streams
DELETE FROM live_stream_aliases WHERE provider_id = 11;

-- movies: streams (cascades movie_stream_genres) then categories (NO ACTION)
DELETE FROM movie_streams     WHERE provider_id = 11;
DELETE FROM movie_categories  WHERE provider_id = 11;

-- series: streams cascade genres + seasons + episodes; then categories
DELETE FROM series_streams    WHERE provider_id = 11;
DELETE FROM series_seasons    WHERE provider_id = 11;   -- normally cascaded; defensive
DELETE FROM series_episodes   WHERE provider_id = 11;   -- normally cascaded; defensive
DELETE FROM serie_categories  WHERE provider_id = 11;

-- live: streams then categories (break the self-referential parent_id first)
DELETE FROM live_streams WHERE provider_id = 11;
UPDATE live_categories SET parent_id = NULL WHERE provider_id = 11;
DELETE FROM live_categories WHERE provider_id = 11;

-- telemetry + remaining NO ACTION children (last, to minimize the race with the
-- live pressure/usage sampler still polling the provider)
DELETE FROM provider_pressure_samples       WHERE provider_id = 11;
DELETE FROM provider_usage_snapshots        WHERE provider_id = 11;
DELETE FROM provider_dns_entries            WHERE provider_id = 11;
DELETE FROM flagged_stream_events           WHERE provider_id = 11;
DELETE FROM provider_baseline_snapshots     WHERE provider_id = 11;
DELETE FROM provider_category_drift_snapshots WHERE provider_id = 11;
DELETE FROM provider_drift_runs             WHERE provider_id = 11;
DELETE FROM provider_identity_quarantines   WHERE provider_id = 11;
DELETE FROM provider_master_accounts        WHERE provider_id = 11;
DELETE FROM provider_refresh_tasks          WHERE provider_id = 11;
DELETE FROM stream_allocations              WHERE provider_id = 11;

DELETE FROM xtream_providers WHERE id = 11;

COMMIT;
