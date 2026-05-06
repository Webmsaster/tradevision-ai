//! State persistence — atomic JSON load/save for `EngineState` with v1→v2→v3
//! schema migrations.
//!
//! Mirrors the cross-process write semantics of `ftmoLiveEngineV4.ts`:
//!   - Write to `<file>.tmp`, fsync, rename. Never partial-overwrite.
//!   - Reader retries once on JSON-parse failure (rename in flight).
//!   - Schema mismatch is migrated where possible; corrupt state is backed
//!     up to `<file>.bak.<ts>` and a fresh state returned via `LoadOutcome::Reset`.

use std::fs::{File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use crate::state::{EngineState, SCHEMA_VERSION};

const STATE_FILENAME: &str = "v4-engine.json";

/// Outcome of a `load_state_or_reset` call. Callers branch on this to log
/// "fresh start" vs "loaded persistent state" cleanly.
#[derive(Debug)]
pub enum LoadOutcome {
    /// State loaded as-is (schema_version matched).
    Loaded(EngineState),
    /// State migrated from an earlier schema version.
    Migrated { from: u32, state: EngineState },
    /// State was missing or unrecoverable; old file was backed up and a
    /// fresh state was synthesised.
    Reset { backed_up_to: Option<PathBuf>, state: EngineState },
}

/// Compute the canonical state file path for a state directory.
pub fn state_path(state_dir: &Path) -> PathBuf {
    state_dir.join(STATE_FILENAME)
}

/// Resolve the per-account state directory from a base + the
/// `FTMO_ACCOUNT_ID` env var. If unset, falls back to `base` directly.
/// Mirrors the R57 multi-account routing in `tools/ftmo_executor.py`.
pub fn account_state_dir(base: &Path) -> PathBuf {
    match std::env::var("FTMO_ACCOUNT_ID") {
        Ok(id) if !id.is_empty() => base.join(format!("account-{id}")),
        _ => base.to_path_buf(),
    }
}

/// Lockfile that prevents two processes from writing the state file
/// concurrently. Drop the returned guard to release the lock.
pub struct StateLock {
    _file: File,
}

pub fn acquire_state_lock(state_dir: &Path) -> Result<StateLock> {
    use fs2::FileExt;
    std::fs::create_dir_all(state_dir)?;
    let path = state_dir.join(format!("{STATE_FILENAME}.lock"));
    let f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .with_context(|| format!("opening lockfile {}", path.display()))?;
    f.try_lock_exclusive()
        .with_context(|| format!("acquiring exclusive lock on {}", path.display()))?;
    Ok(StateLock { _file: f })
}

/// Strict load — returns Err on missing file or schema mismatch.
pub fn load_state(state_dir: &Path) -> Result<EngineState> {
    let path = state_path(state_dir);
    let raw = read_with_retry(&path)?;
    let state: EngineState = serde_json::from_slice(&raw)
        .with_context(|| format!("parsing state file {}", path.display()))?;
    if state.schema_version != SCHEMA_VERSION {
        return Err(anyhow!(
            "state schema_version {} does not match expected {}",
            state.schema_version,
            SCHEMA_VERSION
        ));
    }
    Ok(state)
}

/// Lenient load — never panics, always produces a usable state. Migrations
/// are attempted; corrupt state is backed up and a fresh state returned.
pub fn load_state_or_reset(state_dir: &Path, cfg_label: &str) -> LoadOutcome {
    let path = state_path(state_dir);
    let raw = match read_with_retry(&path) {
        Ok(b) => b,
        Err(_) => {
            return LoadOutcome::Reset {
                backed_up_to: None,
                state: EngineState::initial(cfg_label),
            }
        }
    };
    // Step 1: parse as Value first so we can read the schema_version safely.
    let value: Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(_) => {
            let bak = backup_corrupt(&path).ok().flatten();
            return LoadOutcome::Reset {
                backed_up_to: bak,
                state: EngineState::initial(cfg_label),
            };
        }
    };
    let from_version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;

    // Step 2: try direct parse first for the happy path.
    if from_version == SCHEMA_VERSION {
        match serde_json::from_value::<EngineState>(value.clone()) {
            Ok(state) => return LoadOutcome::Loaded(state),
            Err(_) => {
                let bak = backup_corrupt(&path).ok().flatten();
                return LoadOutcome::Reset {
                    backed_up_to: bak,
                    state: EngineState::initial(cfg_label),
                };
            }
        }
    }

    // Step 3: migrate. Currently we know v1 → v2 (rename) → v3 (rebase).
    match migrate_to_current(value, from_version) {
        Some(state) => LoadOutcome::Migrated { from: from_version, state },
        None => {
            let bak = backup_corrupt(&path).ok().flatten();
            LoadOutcome::Reset {
                backed_up_to: bak,
                state: EngineState::initial(cfg_label),
            }
        }
    }
}

fn migrate_to_current(mut value: Value, from_version: u32) -> Option<EngineState> {
    // v1 → v2: rename `cdUntilBarIdx` → `cdUntilBarsSeen` inside
    // `lossStreakByAssetDir`. The bar-idx anchor is non-monotonic so we
    // conservatively reset the cooldown deadline (set to 0 — let the next
    // loss arm a fresh cooldown via state.barsSeen).
    if from_version <= 1 {
        if let Some(map) = value
            .get_mut("lossStreakByAssetDir")
            .and_then(Value::as_object_mut)
        {
            for (_, ls) in map.iter_mut() {
                if let Some(obj) = ls.as_object_mut() {
                    if obj.contains_key("cdUntilBarIdx") && !obj.contains_key("cdUntilBarsSeen") {
                        obj.remove("cdUntilBarIdx");
                        obj.insert("cdUntilBarsSeen".into(), Value::from(0u64));
                    }
                }
            }
        }
    }
    // v2 → v3: `entryBarIdx` was rebased on monotonic `bars_seen`. For any
    // persisted open positions, conservatively rewrite to the current
    // `barsSeen` value so future bar-elapsed accounting starts here.
    if from_version <= 2 {
        let bars_seen = value.get("barsSeen").and_then(Value::as_u64).unwrap_or(0);
        if let Some(arr) = value.get_mut("openPositions").and_then(Value::as_array_mut) {
            for pos in arr.iter_mut() {
                if let Some(obj) = pos.as_object_mut() {
                    obj.insert("entryBarIdx".into(), Value::from(bars_seen));
                }
            }
        }
    }
    // Force-bump schema_version so post-migration parse is happy.
    if let Some(obj) = value.as_object_mut() {
        obj.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
    }
    serde_json::from_value(value).ok()
}

fn backup_corrupt(path: &Path) -> Result<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }
    let ts = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let bak = path.with_extension(format!("json.bak.{ts}"));
    std::fs::rename(path, &bak)?;
    Ok(Some(bak))
}

fn read_with_retry(path: &Path) -> Result<Vec<u8>> {
    let attempt = |p: &Path| -> Result<Vec<u8>> {
        let f = File::open(p).with_context(|| format!("opening {}", p.display()))?;
        let mut reader = BufReader::new(f);
        let mut buf = Vec::with_capacity(64 * 1024);
        reader.read_to_end(&mut buf)?;
        Ok(buf)
    };
    match attempt(path) {
        Ok(b) => Ok(b),
        Err(_) => attempt(path),
    }
}

/// Atomically save engine state to `<state_dir>/v4-engine.json`.
pub fn save_state(state: &EngineState, state_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(state_dir)
        .with_context(|| format!("creating state dir {}", state_dir.display()))?;
    let final_path = state_path(state_dir);
    let tmp_path = state_dir.join(format!("{STATE_FILENAME}.tmp"));
    let json = serde_json::to_vec_pretty(state).context("serialising state")?;
    {
        let mut tmp = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp_path)
            .with_context(|| format!("opening tmp file {}", tmp_path.display()))?;
        tmp.write_all(&json)?;
        tmp.flush()?;
        tmp.sync_all()?;
    }
    std::fs::rename(&tmp_path, &final_path)
        .with_context(|| format!("renaming {} → {}", tmp_path.display(), final_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("ftmo_engine_persist_{}", std::process::id()));
        p.push(format!("{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn round_trip_save_load() {
        let dir = tempdir();
        let mut s = EngineState::initial("R28_V6_PASSLOCK");
        s.equity = 1.0234;
        s.day = 5;
        s.bars_seen = 1234;
        save_state(&s, &dir).unwrap();
        let back = load_state(&dir).unwrap();
        assert_eq!(back.cfg_label, s.cfg_label);
        assert_eq!(back.equity, s.equity);
        assert_eq!(back.day, s.day);
        assert_eq!(back.bars_seen, s.bars_seen);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn schema_version_mismatch_errors_strict() {
        let dir = tempdir();
        let path = state_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = EngineState::initial("x");
        s.schema_version = 999;
        let raw = serde_json::to_vec(&s).unwrap();
        std::fs::write(&path, raw).unwrap();
        let err = load_state(&dir).unwrap_err();
        assert!(err.to_string().contains("schema_version"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_yields_reset() {
        let dir = tempdir();
        match load_state_or_reset(&dir, "x") {
            LoadOutcome::Reset { backed_up_to, state } => {
                assert!(backed_up_to.is_none());
                assert_eq!(state.schema_version, SCHEMA_VERSION);
            }
            o => panic!("expected Reset, got {o:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrates_v1_loss_streak_rename() {
        let dir = tempdir();
        let path = state_path(&dir);
        // Synthesise a minimum-viable v1 payload.
        let payload = serde_json::json!({
            "schemaVersion": 1,
            "cfgLabel": "x",
            "createdAt": 0,
            "updatedAt": 0,
            "lastBarOpenTime": 0,
            "challengeStartTs": 0,
            "equity": 1.0,
            "mtmEquity": 1.0,
            "day": 0,
            "dayStart": 1.0,
            "dayPeak": 1.0,
            "challengePeak": 1.0,
            "openPositions": [],
            "tradingDays": [],
            "firstTargetHitDay": null,
            "pausedAtTarget": false,
            "lossStreakByAssetDir": {
                "BTC|long": { "streak": 2, "cdUntilBarIdx": 99 }
            },
            "kellyPnls": [],
            "closedTrades": [],
            "barsSeen": 0,
            "stoppedReason": null
        });
        std::fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();
        match load_state_or_reset(&dir, "x") {
            LoadOutcome::Migrated { from, state } => {
                assert_eq!(from, 1);
                assert_eq!(state.schema_version, SCHEMA_VERSION);
                let ls = state.loss_streak_by_asset_dir.get("BTC|long").unwrap();
                // Cooldown deadline conservatively reset to 0 by migration.
                assert_eq!(ls.cd_until_bars_seen, 0);
                assert_eq!(ls.streak, 2);
            }
            o => panic!("expected Migrated, got {o:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_payload_is_backed_up_and_resets() {
        let dir = tempdir();
        let path = state_path(&dir);
        std::fs::write(&path, b"this is not valid json {{{").unwrap();
        match load_state_or_reset(&dir, "x") {
            LoadOutcome::Reset { backed_up_to, state } => {
                assert!(backed_up_to.is_some());
                assert_eq!(state.schema_version, SCHEMA_VERSION);
            }
            o => panic!("expected Reset, got {o:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn partial_writes_never_visible() {
        let dir = tempdir();
        let s = EngineState::initial("x");
        save_state(&s, &dir).unwrap();
        assert!(state_path(&dir).exists());
        let tmp = dir.join(format!("{STATE_FILENAME}.tmp"));
        assert!(!tmp.exists(), "rename should remove .tmp");
        std::fs::remove_dir_all(&dir).ok();
    }
}
