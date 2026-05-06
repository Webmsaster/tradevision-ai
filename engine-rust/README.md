# engine-rust

Rust port of `src/utils/ftmoLiveEngineV4.ts` — the persistent-state bar-by-bar
FTMO live engine. Goal: match the TS V4-Sim numerically while running fast
enough to stop sharding `vitest` for backtest sweeps.

## Status (Phase 3-8 + numerical-parity infrastructure + drift-debug session)

**129 tests green** across nine suites. Anchor-handling bug fixed (3/5 → 4/5
windows perfect parity). Per-asset stop_pct=0.05 + tp_pct cohort overrides
shipped. ATR pre-computation wired in all parity runners. CI drift-job +
determinism + cargo-fuzz + 60-day soak + architecture diagram all live.

### Suites

| Suite                               | Count |
| ----------------------------------- | ----- |
| Unit (`#[cfg(test)] mod tests`)     | 115   |
| Integration (passlock + v5r)        | 5     |
| Property (proptest, ×64 cases each) | 4     |
| Golden runner                       | 1     |
| Drift summary                       | 1     |
| Drift diagnose                      | 1     |
| Determinism                         | 1     |
| 60-day soak                         | 1     |

### Drift snapshot vs TS V4-Sim (R28_V6_PASSLOCK, post-anchor-fix)

After the anchor-handling fix (don't pre-set `challenge_start_ts` — let
`step_bar`'s first-call branch own it) AND wiring ATR pre-computation
through golden_runner / drift_summary / drift_diagnose:

| Window | TS eq   | Rust eq | Δeq             | TS / Rust pass | TS / Rust trades |
| ------ | ------- | ------- | --------------- | -------------- | ---------------- |
| w0     | +9.14%  | +9.14%  | **0.00pp** ✅   | true / true    | 25 / 25          |
| w1     | -15.07% | -15.07% | **0.00pp** ✅   | false / false  | 4 / 4            |
| w2     | +10.53% | -5.89%  | **-16.42pp** ❌ | true / false   | 64 / 32          |
| w3     | -12.79% | -12.79% | **0.00pp** ✅   | false / false  | 8 / 8            |
| w4     | -7.84%  | -7.84%  | **0.00pp** ✅   | false / false  | 2 / 2            |

**4/5 perfect parity** (was 3/5). w2 still drifts — `dailyPeakTrailingStop`
fires more aggressively in Rust on long-running windows due to per-bar
state divergence accumulating after many bars. The drift-diagnose test
(`tests/drift_diagnose.rs`) instruments per-bar skip-counter for further
debug. Hypothesis verified by stripping DPTS from the cfg → 25/25 trades
match TS exactly. The remaining gap is a state-tracking timing diff.

| Suite                                               | Count              | What it covers                                                                                       |
| --------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| Unit (`#[cfg(test)] mod tests`)                     | 108                | Per-module: types, helpers, exit branches, sizing, signals, persistence, drift, news, reconcile, v5r |
| Integration (`tests/integration_passlock.rs`)       | 3                  | PASSLOCK lifecycle, total-loss breach, idempotent replay                                             |
| Integration (`tests/integration_v5r.rs`)            | 2                  | dailyEquityGuardian force-close, reentry-after-stop bypass                                           |
| Property (`tests/property_invariants.rs`, proptest) | 4 (×64 cases each) | Monotone bars_seen, gap-tail floor, day-index DST, gap-fill stop                                     |
| Golden (`tests/golden_runner.rs`)                   | 1                  | JSON fixture in `tests/golden/` with hand-defined expected outcome                                   |

Release build + 8-thread rayon harness:

- **~8M bars/sec** without signal generation (idle bookkeeping)
- **~2-4M bars/sec** with breakout / trend / mean-rev signal driver, full V4+V5R entry-filter pipeline active

## Modules ported

### Core engine (15 modules)

| Module                | TS source                                         | Status                                                                 |
| --------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `candle.rs`           | `indicators.ts:Candle`                            | ✅ Full                                                                |
| `config.rs`           | `ftmoDaytrade24h.ts:FtmoDaytrade24hConfig`        | ✅ All V4 + V5R + R60 fields                                           |
| `position.rs`         | `OpenPositionV4`                                  | ✅                                                                     |
| `trade.rs`            | `ClosedTradeV4`                                   | ✅                                                                     |
| `state.rs`            | `FtmoLiveStateV4` (schema v3)                     | ✅ + ReentryState                                                      |
| `time_util.rs`        | `pragueOffsetMs`, `dayIndex`, etc.                | ✅ + DST cross-test                                                    |
| `indicators.rs`       | `sma`, `ema`, `rsi`, `atr`                        | ✅ R56 NaN self-heal                                                   |
| `detector_filters.rs` | rsi/adx/choppiness/htf/cross-asset                | ✅                                                                     |
| `pnl.rs`              | `computeEffPnl`, `computeMtmEquity`, `trimInline` | ✅ + GAP_TAIL_MULT                                                     |
| `exit.rs`             | `processPositionExit`                             | ✅ All branches + optional time-exit                                   |
| `sizing.rs`           | `resolveSizingFactor`                             | ✅ Adaptive + timeBoost + Kelly hysteresis + V5R dayProgressive + caps |
| `harness.rs`          | `pollLive` (subset)                               | ✅ 13-step pipeline                                                    |
| `persist.rs`          | `loadState`, `saveState`                          | ✅ Atomic write + v1→v2→v3 migrations + lockfile + multi-account       |
| `reconcile.rs`        | R57 `closed-during-offline.json` ingest           | ✅                                                                     |
| `drift.rs`            | `/api/drift-data` snapshot                        | ✅                                                                     |

### Signal sources (4)

| Module                | What                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `signals_breakout.rs` | Donchian-style                                                                                                    |
| `signals_trend.rs`    | R28-style SMA-fast/slow + pullback                                                                                |
| `signals_meanrev.rs`  | V5R-Style RSI-cross with cooldown                                                                                 |
| `signals_r28v6.rs`    | Composed R28_V6: SMA + ADX + choppiness + RSI + HTF + cross-asset + news + ATR-stop + vol-adaptive-tp + live-caps |

### Infrastructure (5)

| Module         | What                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `templates.rs` | `FTMO_TF` selector → `EngineConfig` (R28_V6_PASSLOCK, R28_V6, V5_TITANIUM, V5_AMBER, V5_TOPAZ) |
| `news.rs`      | News-blackout windows + 2026 default events                                                    |
| `v5r.rs`       | V5R sister-engine — thin wrapper, delegates to harness via flags                               |
| `engine.rs`    | Phase 0 stub `run_window` + WindowInput                                                        |
| `result.rs`    | Public WindowResult / FailReason                                                               |

## What `harness::step_bar` does

13-step pipeline matching V4 + R57/R58 + R60 + V5R:

1. Stopped-state short-circuit
2. Day-rollover (Prague-aware via `chrono-tz`, R51-FTMO-7 regression-guard)
3. Force-close on `max_days` (R57-V4-3)
4. MTM update + `dayPeak` / `challengePeak` recompute
5. **V5R `dailyEquityGuardian`** — force-close on intraday MTM drawdown trigger
6. Per-position exit-check loop (delegates to `process_position_exit`, with `bars_held`)
7. Total-loss / daily-loss fail-checks on REALISED equity
8. **Bar-level entry gates**: `dailyPeakTrailingStop`, `challengePeakTrailingStop`, `intradayDailyLossThrottle.hard`, `allowed_hours_utc`, `allowed_dows_utc`
9. `pause_at_target_reached` latch
10. **R60 PASSLOCK** — `close_all_on_target_reached` force-closes everything when target hits
11. Open new positions with **per-signal gates**:
    - `asset.activate_after_day` / `min_equity_gain` / `max_equity_gain`
    - `crossAssetFilter` + `crossAssetFiltersExtra`
    - V5R `reentryAfterStop` slot consumption (bypasses cooldown, scales risk)
    - `lossStreakCooldown` (skipped when reentry slot present)
    - `correlationFilter` (max same-direction)
    - `maxConcurrentTrades` (re-checked mid-bar)
12. Loss-streak update on close + V5R reentry-slot install on stop-loss
13. Bookkeeping (bars_seen, last_bar_open_time, trim_inline)

## Config coverage

**V4**: ✅ liveCaps · ✅ atrStop · ✅ chandelierExit · ✅ breakEven · ✅ partialTakeProfit + multi-level · ✅ dailyPeakTrailingStop · ✅ challengePeakTrailingStop · ✅ peakDrawdownThrottle · ✅ drawdownShield · ✅ adaptiveSizing · ✅ kellySizing (hysteresis) · ✅ timeBoost · ✅ maxConcurrentTrades · ✅ correlationFilter · ✅ pauseAtTargetReached · ✅ closeAllOnTargetReached (R60) · ✅ lossStreakCooldown · ✅ intradayDailyLossThrottle · ✅ allowedHoursUtc / allowedDowsUtc · ✅ asset.activateAfterDay / minEquityGain / maxEquityGain · ✅ crossAssetFilter / crossAssetFiltersExtra · ✅ volAdaptiveTpMult · ✅ pingReliability (config) · ✅ asset.holdBars / invertDirection · ✅ time-exit toggle

**V5R**: ✅ dailyEquityGuardian · ✅ bypassLiveCaps · ✅ dayProgressiveSizing · ✅ reentryAfterStop · ✅ meanReversionSource

## What's NOT ported yet

| Component                                       | Why deferred                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full `detectAsset` (all branches in 9.5kLOC TS) | The R28_V6 composed detector (`signals_r28v6.rs`) covers the most-used path. Forex / SMC / Donchian-MA-cross alt branches still need explicit ports. |
| `momentumRanking`                               | Pre-sort of trade candidates — not live-fähig per V4 docstring.                                                                                      |
| `pingReliability` runtime                       | Config field is parsed, but the Bernoulli-sim during pause-after-target phase isn't wired (handled by Python executor's ping cron).                  |
| TS-side `dumpRustGoldenFixture.ts` runtime      | Skeleton in `scripts/dumpRustGoldenFixture.ts` — needs the V4-Sim hookup wired.                                                                      |
| Phase 8 zero-copy refactor                      | See `PERF_NOTES.md` — gated on criterion measurement first.                                                                                          |

## CLI binaries

```bash
# Phase 0 stub binary
cargo run --release --bin ftmo-engine

# Multi-window parallel bench (idle path)
cargo run --release --bin ftmo-bench -- \
  --candles ../scripts/cache_bakeoff/ARBUSDT_30m.json \
  --windows 16 --threads 8

# End-to-end: signal-driven backtest with JSONL output
cargo run --release --bin ftmo-sweep -- \
  --candles ../scripts/cache_bakeoff/ARBUSDT_30m.json \
  --config 2h-trend-v5-r28-v6-passlock \
  --signals breakout --windows 16 --threads 8 \
  --out /tmp/sweep_results.jsonl

# List available config selectors
cargo run --release --bin ftmo-sweep -- --list-configs
```

## Tests

```bash
cargo test --workspace                    # 110 unit + 5 integration + 4 property + 1 golden + 1 drift
cargo test --test drift_summary -- --nocapture   # quantitative TS↔Rust drift report
cargo bench --bench step_bar_throughput   # criterion micro-benches
```

## Regenerating golden fixtures

The 5 R28_V6 fixtures (~16MB each) are `.gitignored`. To regenerate after
pulling:

```bash
engine-rust/scripts/regen-golden-fixtures.sh
```

This runs `scripts/dumpRustGoldenFixture.ts` for windows 0..4 against the
cached 30m candles in `scripts/cache_bakeoff/`. Each fixture captures the
exact bars + emitted V4-Sim entry signals + expected outcome so the Rust
runner can replay them and compare numerically.

## CI

`.github/workflows/rust.yml` runs `fmt --check`, `clippy -D warnings`,
`cargo test --workspace`, and a release build smoke on every push that
touches `engine-rust/`.

## Roadmap status (per `PERF_NOTES.md` + the original 9-phase plan)

| Phase | Scope                                                                        | Status                                                                     |
| ----- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1     | Foundation types, helpers, exit logic                                        | ✅                                                                         |
| 2     | step_bar harness + V4 entry filters                                          | ✅                                                                         |
| 3     | Signal generation                                                            | ✅ Subset (R28_V6 + meanrev + breakout + trend), full detectAsset deferred |
| 4     | V4 config restposten (xAsset, volAdapt, holdBars, invertDir, timeExit, ping) | ✅                                                                         |
| 5     | Live infra (multi-account, lockfile, reconcile, drift, news)                 | ✅                                                                         |
| 6     | Tooling (CSV, sweep orchestrator, config-selector loader, golden dump)       | ✅ (TS dump = skeleton)                                                    |
| 7     | Tests/Validation (CI, property+, criterion)                                  | ✅                                                                         |
| 8     | Performance                                                                  | 🟡 Documented, criterion-gated implementation                              |
| 9     | Live-Executor-Bridge (MT5 in Rust)                                           | ⏸️ Deferred — Python executor remains the MT5 frontend                     |
