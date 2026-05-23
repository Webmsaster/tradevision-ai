#!/bin/bash
# 2026-05-23 Wave1 audit fix (HIGH): hourly state-dir backup. Without this
# a single disk-loss event (VPS crash, accidental rm -rf, drive failure)
# wipes:
#   - account.json + day-peak.json (DL anchor lost → FTMO daily-loss baseline
#     resets to current equity at restart, can trip 5% breach on first bar)
#   - executor.pid (singleton lock orphaned)
#   - open-positions.json (position-engine state ↔ MT5 broker drift)
#   - signal-history.jsonl (live-cluster detector loses 24h memory)
#   - bot-controls.json (kill marker lost → bot resumes trading)
#   - executor-log.jsonl (audit trail lost)
#   - timing-gate.json (start-gate window lost)
#
# Result: total FTMO-bust within 1 cycle of restart.
#
# Schedule: every hour via cron (or PM2 cron-restart of a tiny watcher).
# Backups land in $BACKUP_DIR/<account>/<YYYYMMDD-HH>.tar.gz with 7-day
# retention. For off-VPS durability, add `aws s3 cp` / `rsync` after the
# local archive (commented below).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${FTMO_BACKUP_DIR:-$ROOT/state-backups}"
KEEP_DAYS="${FTMO_BACKUP_KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

ts=$(date -u +"%Y%m%d-%H%M%S")

# Snapshot every ftmo-state-* directory we can find.
for state_dir in "$ROOT"/ftmo-state-* "$ROOT"/state; do
  [ -d "$state_dir" ] || continue
  base=$(basename "$state_dir")
  account_backup="$BACKUP_DIR/$base"
  mkdir -p "$account_backup"
  archive="$account_backup/${ts}.tar.gz"
  # Exclude lock files (no point backing up) and large rotated archives.
  tar -czf "$archive" \
      --exclude='*.lock' \
      --exclude='*.tmp.*' \
      --exclude='executor-log.*.jsonl.gz' \
      --exclude='signal-history.*.jsonl.gz' \
      -C "$ROOT" "$base" 2>/dev/null || {
    echo "[backup_state] WARN: tar failed for $state_dir" >&2
    continue
  }
  echo "[backup_state] $base → $(basename "$archive") ($(stat -c%s "$archive" 2>/dev/null || stat -f%z "$archive") bytes)"
done

# Retention: delete archives older than KEEP_DAYS.
find "$BACKUP_DIR" -name "*.tar.gz" -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

# Off-VPS durability (recommended for production):
#   aws s3 sync "$BACKUP_DIR" "s3://my-bucket/ftmo-state-backups/" --exclude '*' --include '*.tar.gz'
#   OR: rsync -a "$BACKUP_DIR/" remote-host:/srv/backups/ftmo/

echo "[backup_state] done (kept last $KEEP_DAYS days in $BACKUP_DIR)"
