#!/usr/bin/env bash
# Apply pending SQL migrations in name order and record them.
#   scripts/migrate.sh                 apply pending
#   scripts/migrate.sh --status        list applied / pending
#   scripts/migrate.sh --mark-applied F   record F without running it
# Files named ops-*.sql are one-off operational scripts and are never auto-run.
# Credentials: DB_* from /home/ottapi/.env (run as root).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export MYSQL_PWD="$DB_PASSWORD"
M=(mysql -u"$DB_USERNAME" -h"${DB_HOST:-127.0.0.1}" -P"${DB_PORT:-3306}" "$DB_DATABASE")

"${M[@]}" -e "CREATE TABLE IF NOT EXISTS schema_migrations (
  filename VARCHAR(255) PRIMARY KEY,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)"

applied() { "${M[@]}" -N -e "SELECT filename FROM schema_migrations"; }
record()  { "${M[@]}" -e "INSERT IGNORE INTO schema_migrations (filename) VALUES ('$1')"; }

case "${1:-}" in
  --status)
    done_list=$(applied)
    for f in $(ls migrations/*.sql | xargs -n1 basename | grep -v '^ops-' | sort); do
      grep -qx "$f" <<<"$done_list" && echo "applied  $f" || echo "PENDING  $f"
    done ;;
  --mark-applied)
    record "$(basename "$2")"; echo "marked $2" ;;
  "")
    done_list=$(applied)
    for f in $(ls migrations/*.sql | xargs -n1 basename | grep -v '^ops-' | sort); do
      grep -qx "$f" <<<"$done_list" && continue
      echo "applying $f"
      "${M[@]}" < "migrations/$f"
      record "$f"
    done
    echo "up to date" ;;
  *) echo "usage: $0 [--status | --mark-applied FILE]" >&2; exit 2 ;;
esac
