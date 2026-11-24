-- One-off ops record (NOT auto-run). EXECUTED 2026-11-24.
-- provider_category_drift_snapshots (2.80M rows) and provider_usage_snapshots
-- (487k rows) were written only by the legacy v1 service (ottapi.service,
-- now stopped + disabled); nothing in v2 reads them and nothing had written
-- since 2026-10-02. Archived to /var/backups/ottapi/archive/<table>-20261124.sql.gz
-- (restore: zcat file | mysql ottapi), then:
TRUNCATE TABLE provider_category_drift_snapshots;
TRUNCATE TABLE provider_usage_snapshots;
-- provider_drift_runs (16k rows) kept: provider_refresh_tasks references it.
