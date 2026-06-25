-- Migration: add is_adult flag to category tables.
--
-- Adult categories (provider names like "Adult 4K", "Adult FHD", "For Adults")
-- are excluded from every regular-content surface and surfaced only on the
-- dedicated PIN-gated Adult page. The catalog sync sets this flag on every run
-- via is_adult_category_name() (src/services/catalog_parser.py); this migration
-- adds the columns and backfills existing rows so the flag is correct before
-- the next sync.
--
-- Run once against the app's MySQL database, e.g.:
--   mysql <db> < migrations/2026-06-25-add-is-adult-to-categories.sql

ALTER TABLE movie_categories ADD COLUMN is_adult TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE serie_categories ADD COLUMN is_adult TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE live_categories  ADD COLUMN is_adult TINYINT(1) NOT NULL DEFAULT 0;

-- Backfill. Keep this REGEXP in sync with is_adult_category_name() in
-- src/services/catalog_parser.py (\bADULT\b | \bXXX\b | \b18+ | FOR ADULTS?).
UPDATE movie_categories SET is_adult = 1
  WHERE category_name REGEXP '(^|[^[:alnum:]])(ADULT|XXX|18\\+)([^[:alnum:]]|$)'
     OR category_name REGEXP 'FOR[[:space:]]+ADULTS?';
UPDATE serie_categories SET is_adult = 1
  WHERE category_name REGEXP '(^|[^[:alnum:]])(ADULT|XXX|18\\+)([^[:alnum:]]|$)'
     OR category_name REGEXP 'FOR[[:space:]]+ADULTS?';
UPDATE live_categories SET is_adult = 1
  WHERE category_name REGEXP '(^|[^[:alnum:]])(ADULT|XXX|18\\+)([^[:alnum:]]|$)'
     OR category_name REGEXP 'FOR[[:space:]]+ADULTS?';
