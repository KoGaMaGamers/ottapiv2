# Sport-events curation — install & operate

This is a one-time install for the periodic Claude-driven sport-events
job. It runs OUT OF the uvicorn process so it can fire as `root` and
read `/root/.claude/.credentials.json` (Max-plan OAuth).

## Prerequisites

- `claude` CLI installed at `/root/.local/bin/claude` and logged in
  with the Max-plan account that should pay for the runs.
- `/home/ottapi/.venv/` exists with the project deps.
- `static/sport-events/` writable (created by the runner on first run).
- DB schema for `sport_events`, `live_stream_aliases`,
  `sport_events_runs`, `kv_settings` already migrated (run
  `Base.metadata.create_all` once if you haven't — the install commit
  notes the exact one-liner).

## Install systemd units

```bash
sudo install -m 0644 /home/ottapi/deploy/ottapi-sport-events.service /etc/systemd/system/
sudo install -m 0644 /home/ottapi/deploy/ottapi-sport-events.timer   /etc/systemd/system/
sudo install -m 0644 /home/ottapi/deploy/ottapi-sport-events-cleanup.service /etc/systemd/system/
sudo install -m 0644 /home/ottapi/deploy/ottapi-sport-events-cleanup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ottapi-sport-events.timer
sudo systemctl enable --now ottapi-sport-events-cleanup.timer
```

After this:

- The **refresh** runs ~5 min after every reboot, then every 72h.
- The **cleanup** runs every hour, deleting events whose `end_utc`
  has passed (and unlinking their composite cover JPGs from disk).

## Allow the admin endpoint to trigger refresh on demand

The admin endpoint at `POST /api/v1/admin/sport-events/refresh` shells
out to `sudo systemctl start ottapi-sport-events.service`. Without a
sudoers rule the call returns 503 with operator instructions.

```bash
sudo install -m 0440 /home/ottapi/deploy/sudoers.d-ottapi-sport-events \
    /etc/sudoers.d/ottapi-sport-events
sudo visudo -c   # syntax check
```

If you skip this step the timer still works; only the on-demand admin
endpoint is unavailable.

## First run + verification

```bash
# Fire one refresh manually (foreground, full logs)
sudo systemctl start ottapi-sport-events.service
sudo journalctl -u ottapi-sport-events.service -f

# When it finishes, inspect what landed
mysql -e "SELECT id,title,start_utc,broadcaster_name FROM sport_events
          ORDER BY start_utc"

# Or via the admin GET (no sudo needed):
curl -H "X-Admin-Secret: $ADMIN_SECRET" \
     http://127.0.0.1:8011/api/v1/admin/sport-events/last-run | jq
```

## Tuning

- Cadence — edit `OnUnitActiveSec=` in the timer files and reload.
- Cleanup cadence — same, on the cleanup timer.
- Subprocess timeout — `CLAUDE_SUBPROCESS_TIMEOUT_SEC` env var
  (default 900s).

## Uninstall

```bash
sudo systemctl disable --now ottapi-sport-events.timer ottapi-sport-events-cleanup.timer
sudo rm /etc/systemd/system/ottapi-sport-events*.{service,timer}
sudo rm /etc/sudoers.d/ottapi-sport-events
sudo systemctl daemon-reload
```
