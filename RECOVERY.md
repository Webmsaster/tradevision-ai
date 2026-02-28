# Recovery Runbook

This runbook describes how to recover trading data after accidental deletion, browser reset, or failed sync.

## 1. Prepare a Backup (Before Incidents)

1. Open `Import & Export`.
2. Click `Export as JSON`.
3. Store the exported file in a safe location (cloud drive + local copy).

## 2. Restore from JSON Backup

1. Open `Import & Export`.
2. In `Import from JSON Backup`, choose your backup file.
3. Select a restore mode:
   - `Merge (keep existing trades)`: adds only missing trade IDs.
   - `Replace all existing trades`: overwrites the current dataset.
4. Click the import button.
5. If `Replace` is selected, confirm the warning dialog.

## 3. Verify Recovery

1. Check trade count in `Import & Export`.
2. Open `Trades` and confirm expected symbols/dates are present.
3. Open `Analytics` and confirm charts render without errors.

## 4. If Data Still Looks Wrong

1. Re-run restore using `Replace` mode with the latest known-good backup.
2. If using cloud sync, sign out and sign back in to refresh cloud state.
3. Re-run `Production Smoke Check` workflow to validate app health.

## 5. Operational Notes

- JSON import deduplicates duplicate trade IDs from malformed backups.
- Screenshots embedded in backup JSON entries are preserved on import.
- Keep at least one weekly backup for rollback safety.
