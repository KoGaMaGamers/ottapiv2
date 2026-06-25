-- Migration: persist the GoldenOTT /domains last-refresh time on the provider.
--
-- The admin donor-health panel shows when GoldenOTT's authoritative domain list
-- was last fetched (on-demand rotation recovery + the scheduled brand-domain
-- sync). It previously lived in an in-memory dict that reset on every restart;
-- this column persists it (and doubles as the on-demand refresh throttle).
--
-- Run once against the app's MySQL database, e.g.:
--   mysql <db> < migrations/2026-06-25-add-domains-refreshed-at-to-providers.sql

ALTER TABLE xtream_providers ADD COLUMN domains_refreshed_at DATETIME NULL;
