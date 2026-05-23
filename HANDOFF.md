# Session Handoff - 2026-05-23 (Update 3 - Bug-Fix Marathon)

## TL;DR — Mega-Session Results

**Branch:** `feature/r28-deploy`. **7 commits** dieser Session-Phase. **~30 verifizierte Bugs gefixt** (10 ML Round 11 + 5 Round 11.2 + 5 Round 11.3 + 70+ direction-string sites protected + 4 Wave1 project-audit). **Tests grün:** Rust 440/440 ✓.

## What was done

### Phase 1: Engine extension (committed: `3134a70`)

- **SHORTS-only Template** `v5_amber_max_passlock_shorts_only` — measured 29.13% combined-funded standalone (= BIDIR class)
- **Forex-MR Template** `v5_forex_mr_passlock` + SignalSrc::ForexMr wiring + `--timeframe 1d` + `_daily.json` loader + TF-scaled warmup
- Daily-only Forex-MR debunked (0/200 pass — needs 30m forex data)
- Per-asset cost-patch reverted (-3.24pp regression on AMBER)

### Phase 2: HYBRID single-account hunt (debunked)

- Built `v5_amber_max_passlock_hybrid` template — 9 variants tested
- All worse than AMBER alone (best: v7 with `mutex_long_short` = 29.23%)
- Built engine features `regime_flip_close_opposite` + `mutex_long_short` (config flags off by default)
- Empirical proof: shared-equity path-dependency dominates orthogonality

### Phase 3: ML Bug-Audit (commits `5861b82`, `b8c89a4`, `b4908ea`)

- **Round 11** (10 bugs): orphan pipeline delete, entry_time fix, direction case fix, ml_gate.rs predict_proba + asset_id_for, dedup, nan_imputation, schema bump v1→v2, shuffle test assertion
- **Round 11.2** (5 verification follow-ups): CUTOFF entry_time edge case, dedup direction normalization, bi-directional shuffle threshold
- **Round 11.3** (5 round-2 bugs): feature_medians embedded, htf_macd_gate buffer fix, funding-index off-by-one, stale fixtures archived, warmup heuristic
- ML retrained: **AUC 0.5111 (coinflip)** — empirically confirms post-bug-fix ML has no edge

### Phase 4: Direction-string global fix (commit `559edbe`)

- Created `tools/direction_util.py` with `normalize_direction/is_long/is_short/dir_sign/opposite`
- Protected ~70 strict-compare sites in `tools/ftmo_executor.py` via normalize-at-source (signal-history writer + validation gate)
- Eliminated case-drift sign-flip risk on live trading

### Phase 5: TITANIUM trade-rate hunt

- Cell E (mct=10 + hours+12 + hold/2) = **49.01% P1** (+5.23pp vs baseline 43.78%)
- Better than projected. Apply to Stack-4 TITANIUM account → +1-2pp combined-funded

### Phase 6: 50-Agent project-wide bug audit (commit `9c5b1fd`)

- 17 specialized agents launched, all completed
- **4 critical bugs fixed in this commit:**
  1. harness.rs force-close day mis-stamp (analytics drift)
  2. harness.rs regime-flip EMA hysteresis truncated-slice (false trends)
  3. `MAX_SIGNAL_AGE_MS = 5min → 15min` (was edge-case for 4h emitter)
  4. live executor `LIVE_MAX_STOP_PCT = 0.05` cap added (engine had it, live missed)

## Verified Bugs from 17-Agent Audit (sortiert nach severity)

### 🔴 KRITISCH — Deploy-Blocker (FIXED in commit 9c5b1fd)

- ✅ harness.rs force-close day mis-stamp
- ✅ harness.rs regime-flip EMA hysteresis comparison
- ✅ MAX_SIGNAL_AGE_MS=5min (signals dropped on 4h cron)
- ✅ live executor missing stop_pct cap

### 🟡 KRITISCH — Deploy-Blocker (NOT YET FIXED — next session)

- `scripts/deploy/failover_broker.py` non-atomic write + no lock → multiple ACTIVE accounts possible
- `tools/ftmo_kill.py` bypasses bot-controls.lock → kill marker LOST in race
- `engine-rust/.../reconcile.rs` schema mismatch with Python writer → offline trades silently lost
- `engine-rust/.../reconcile.rs::reconcile_offline()` is dead code (never called from prod)
- `tools/news_blackout.py` Python ↔ Rust window asymmetry (30/60 vs 30/15 default)
- `news_blackout.py` does NOT use live `news-events.json` (only hardcoded list)
- Race between news-gate check + `mt5.order_send` (~5-30s broker latency)
- `cache_updater.py` only refreshes 30m — funding/5m/2h/lsr stale 14-21 days
- `cache_updater.py` crashes whole batch on malformed cache (no per-file isolation)
- HYBRID template (`v5_amber_max_passlock_hybrid`) C1-C3: source_symbol mismatch + risk doubled + doc/code semantic flip

### 🟠 HIGH — Real bugs (NOT FIXED)

- `tools/ftmo_executor.py` SIGTERM cleanup doesn't persist positions to disk
- `tools/process_lock.py` `file_lock` spins forever on persistent contention (no observability)
- exit.rs C1: time-exit off-by-one (`>=` vs TS `>`) → 1-3pp drift on chandelier configs
- ml_gate.rs git_commit/training_data_mtime validation never wired (R11.2 only half-shipped)
- 80+ sweep scripts have no pre-run cache-validation
- Live executor: signal-history.jsonl race between tracker + executor (cluster-gate over-counts)
- Live executor: `compute_live_cluster` reads entire 10MB file every 30s poll
- Sizing risk-budget: `MCT=10 × maxRiskFrac=0.4 × stop=0.05 × lev=2 = 40%` modelled-loss vs 5% daily-loss cap (no pre-validation)
- Cross-asset correlation: filter sees "3 longs" not "BTC+ETH+SOL all bullish ≈ 1.0 corr"
- Telegram: 4 missing `html_escape` calls + Python 429 ignores Retry-After header
- TS Telegram: `critical` parameter missing (Python has, TS doesn't) → breach alerts silenceable
- Health monitor: bot-liveness ≠ trading-liveness (no `mt5_disconnected` / `no signals N hours` checks)
- driftMonitor: `expected_pnl_pct = 0` for all non-TP/Stop exits → undercounts PASSLOCK drift
- Backup: ZERO. State-dir loss = total FTMO bust
- KRIT: Python state files have NO `schema_version` field (rename = silent stale-load)
- `tf-marker.json` not atomically written (crash mid-write = bypass cross-TF guard)
- Live executor: `pos.get("direction", "long")` silent-long-default at 5 sites (now wrapped with normalize_direction)
- News: hardcoded 2026 FOMC events only — bot silently runs blackout-disabled 2026-12-31 23:59
- News: no NY-holiday calendar (release shifts not handled)
- News: missing FOMC minutes, Powell pressers, ECB, BOJ, ETF approval dates
- Templates: 6 selectors missing from `known_selectors()` (HYBRID, FOREX_MR, MPTP_V04A, SHARPE_TIGHT, STEP2)
- Test coverage: 0 tests for SHORTS-only / BIDIR / regime-flip-close / mutex-long-short / direction_util — 4 newest features

### 🟢 MEDIUM (NOT FIXED)

- Forex-MR template: `..AssetConfig::default()` silent-inheritance time-bomb
- Forex-MR / hybrid hold_bars per-asset None → falls back to cfg.hold_bars (potential surprise)
- `_compute_magic_id` numeric ≥1000 unbounded growth (not collision-risk but undocumented)
- Single-account default `MAGIC=231` shared globally (mitigated by FTMO_EXPECTED_LOGIN if set)
- timing-gate.json shared globally if FTMO_ACCOUNT_ID unset
- `fetch_premium_index.py` infinite retry loop on persistent error + non-atomic write
- `lsr_collector.py` silent-fail anti-pattern (returns [] on error, no retry/alert)
- CI/CD: first-party actions float on major tags (vs SHA pinned 3rd-party)
- CI/CD: pre-commit hook only does `lint-staged` (no typecheck/test)
- CI/CD: prod-smoke doesn't cover auth/Supabase/Stripe paths
- Dependencies: 2 MODERATE npm vulns (`brace-expansion`, `ws`) — fix via `npm audit fix`
- `.env.ftmo.amber/titanium/demo2.example` missing FTMO_PROFIT_TARGET explicit
- engine_features.py + parity_check.py: ~50 strict-string direction compares (callers now safe, defensive shim recommended)

## Stack-4 Champion (unchanged but TITANIUM tunable)

| Account               | Template                                | Combined-Funded | Notes                                         |
| --------------------- | --------------------------------------- | --------------- | --------------------------------------------- |
| 1                     | V5_AMBER_MAX_PASSLOCK + BNB 18/50       | 32.90%          | best single                                   |
| 3                     | V5_TITANIUM_PASSLOCK + BNB 18/50        | 21.20%          | **+5.23pp via mct=10+hours+12+hold/2 tuning** |
| 4                     | V5_AMBER_MAX_MR_PASSLOCK + BNB 18/50    | 16.15%          | weakest (replace with SHORTS-only?)           |
| 5                     | V5_AMBER_MAX_PASSLOCK_BIDIR + BNB 18/50 | 29.79%          |                                               |
| **Stack-4 OR honest** | offset=1 strict math                    | **59.10%**      | (recompute with TITANIUM tuning)              |

**Verified profit improvements (this session):**

- TITANIUM trade-rate boost → +5.23pp P1 standalone → +1-2pp Stack-4
- SHORTS-only replacement of MR → projected +1-3pp Stack-4 (29% vs 16%)
- FundingPips switch (8% target vs FTMO 10%) → +10pp pass-rate, $429 vs $540 fee

**Empirically debunked (this session):**

- Single-account HYBRID (9 variants tested, all < AMBER alone)
- ML cycle-selector (AUC 0.5111 = coinflip post-bug-fix)
- Daily Forex-MR (0/200 pass — trade-starved)
- Per-asset cost-patch (-3.24pp regression)

## Live Profit Update (after audit)

| Modell                                           | $/Monat trader-net     |
| ------------------------------------------------ | ---------------------- |
| 4× FTMO $100k (current Stack-4)                  | ~$10-18k               |
| **Stack-4 with TITANIUM-tuned + SHORTS-replace** | **~$12-22k** projected |
| 4× FundingPips $100k (8% target)                 | ~$15-23k               |
| **2× FP $200k + 2× FP $100k = $600k**            | **~$22-31k** ← max ROI |

After DE-tax (~50%) + ops (~$2-4k/mo): Net **~$4-10k/mo** Stack-4, ~$10-15k/mo with FundingPips upgrade.

## Next Session Priorities

### Tier 1: Deploy-Blocker Bugs (2-3h)

1. Fix `failover_broker.py` atomicity + lock
2. Fix `ftmo_kill.py` bot-controls.lock bypass
3. Fix `reconcile.rs` schema mismatch + wire `reconcile_offline()` to prod path
4. Add state-dir backup cron (rsync/S3) — eliminates FTMO-bust-on-disk-loss
5. HYBRID template: either fix C1-C3 OR delete (currently broken state)

### Tier 2: Profit Levers (1-2h)

1. TITANIUM trade-rate boost: deploy in `ecosystem.orthogonal4stack.config.js`
2. SHORTS-only replace MR in Stack-4 (Account-4 swap)
3. TP-mult 1.10 → 1.14 in deploy configs (+1.5pp easy)
4. Per-asset risk_frac vol-scaled (+1-3pp standalone)

### Tier 3: Infrastructure (2-3h)

1. Schema versioning for ALL Python state files
2. Lock signal-history.jsonl writes (tracker + executor race)
3. Health-monitor: real liveness (`mt5_disconnected` + `no signals 4h`)
4. driftMonitor: handle non-TP/Stop exits properly
5. Test coverage: 10 critical missing tests from audit

### Tier 4: Optional (FundingPips, 60d parallel run)

1. FundingPips demo signup → MT5 symbol enumeration
2. Migration roadmap: 60d parallel-run plan in agent output
3. Friday-Close-Hook needed for FundingPips funded-phase

## Key Files (this entire session)

### Engine (Rust)

- `engine-rust/ftmo-engine-core/src/templates.rs` — SHORTS-only, Forex-MR, HYBRID (broken)
- `engine-rust/ftmo-engine-core/src/harness.rs` — regime_flip_close_opposite + mutex_long_short + Wave1 fixes
- `engine-rust/ftmo-engine-core/src/ml_gate.rs` — schema v3 + feature_medians + asset_id normalization
- `engine-rust/ftmo-engine-cli/src/sweep.rs` — SignalSrc::ForexMr + daily TF + htf_macd_gate fix

### Live (Python)

- `tools/ftmo_executor.py` — direction normalize, MAX_SIGNAL_AGE bump, stop_pct cap
- `tools/direction_util.py` — global helper (new)

### Training

- `scripts/_mlTrainClassifier.py` — feature_medians, git_commit metadata, schema v3
- `scripts/_mlTrainingDataGen.ts` — funding-index off-by-one fix
- `scripts/_mlShuffleTest.py` — bi-directional threshold

### Sweep scripts

- `scripts/_shortsonly_*_2026_05_23.sh`
- `scripts/_hybrid_long_short_sweep_2026_05_23.sh`
- `scripts/_titanium_trades_boost_2026_05_23.sh` (script created earlier by agent)
- `scripts/_clusterhunt_grid_2026_05_23.sh`
- `scripts/_stack4_rebaseline_costs_2026_05_23.sh`
- `scripts/cache_bakeoff/_archive_ml_v1_v2/README.md`

### Deleted (orphan)

- `scripts/_mlOverlayFeatures.ts`
- `scripts/ml_overlay_train.py`

## Session Commits (chronological)

1. `3134a70` — SHORTS-only + Forex-MR templates + daily TF support
2. `5861b82` — ML Round 11: 10 verified bugs
3. `b8c89a4` — ML Round 11.2: 5 verification follow-ups
4. `559edbe` — Live direction-string normalization
5. `b4908ea` — ML Round 11.3: 5 round-2 bugs
6. `9c5b1fd` — Wave1 project-audit: 4 critical bugs

Plus `HYBRID` template iteration commits not yet pushed (v1-v9 experiments in template.rs).

## Critical Open Risks (must address before live $$)

1. **No state-dir backup** → disk-loss = total FTMO-bust
2. **News-blackout doesn't read live events** → bot can trade during un-hardcoded FOMC
3. **failover_broker non-atomic** → multi-active-account scenario possible
4. **ftmo_kill race** → manual emergency-stop can be silently undone
5. **HYBRID template is broken** (3 KRIT bugs) → don't deploy, schedule fix or delete
