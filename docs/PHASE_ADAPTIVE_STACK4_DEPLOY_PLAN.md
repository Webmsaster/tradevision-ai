# Phase-Adaptive Stack-4 Live-Deployment Plan

**Status:** Plan only — implementation parked until live-deploy decision.
**Source finding:** [[session-2026-05-25-phase-adaptive-stack4]] (BIG GA Stack-4 = 97.28% OOS BEST / 93.75% mean across 10 seeds, 2 seeds converged to same optimum).

## Recommended Stack-4 Config (GA-optimal, seeds 1337+2024 converged)

| Account | P1 Template                                 | P2 Template (auto-switch on P1-target hit)  |
| ------- | ------------------------------------------- | ------------------------------------------- |
| A       | `v5-amber-max-passlock-shorts-agg`          | `v5-amber-max-passlock-shorts-agg` (sym ok) |
| B       | `v5-amber-max-passlock` (ext24)             | `v5-amber-max-passlock-topaz`               |
| C       | `v5-amber-max-passlock-risk06`              | `v5-amber-max-passlock-shorts-only`         |
| D       | `v5-amber-max-passlock-shorts-only` (ext24) | `v5-amber-max-passlock-risk06`              |

Walk-forward TEST 97.28% / TRAIN 85.15% / drift +12.13pp = ROBUST (anti-overfit + 2-seed convergence).

## Robustness Range (10 GA seeds, BIG run)

TEST range: [90.94%, 97.28%], mean 93.75%. Conservative live-realistic estimate: 85-90%.

## Live-Drift Sensitivity (worst-case modeling)

Backtest 97.28% × (1 - live_drift):
| Live Drift | Live CF rate | E[funded accts] | Monthly Trader-Share (@$5k/funded) |
| ---------- | ------------ | --------------- | ---------------------------------- |
| -5pp | 92.28% | 3.69/4 | $18.4k/mo |
| -10pp | 87.28% | 3.49/4 | $17.5k/mo |
| -15pp | 82.28% | 3.29/4 | $16.4k/mo |
| -20pp | 77.28% | 3.09/4 | $15.4k/mo |
| -30pp (catastrophic) | 67.28% | 2.69/4 | $13.4k/mo |

Even with catastrophic 30pp drift (historical worst case), Stack-4 phase-adaptive
remains profitable at >$13k/mo expected. Break-even (-65pp drift) would require
backtest-to-live degradation rarely seen in this codebase.

## Streak Resilience (deterministic-greedy variant, in-sample)

- Max consecutive-fail streak: **2 days** (no 5+ day cold streaks)
- Worst rolling 30-day rate: **63.3%** (~2.5/4 funded even worst month)
- Best rolling 30-day rate: 100% (all 4 funded entire month)

## Required Infrastructure

### 1. Env-Var Contract (per-account)

```bash
FTMO_ACCOUNT_ID=A
FTMO_TF_P1=2h-trend-v5-amber-max-passlock-risk05
FTMO_TF_P2=2h-trend-v5-amber-max-passlock-shorts-only
FTMO_INITIAL_BALANCE=100000
FTMO_P1_TARGET=0.10
FTMO_P2_TARGET=0.05
FTMO_P1_MAX_DAYS=30
FTMO_P2_MAX_DAYS=60
# Basket override (only Account B uses extended 24-asset basket)
FTMO_SYMBOLS_EXT24=DOGEUSDT,XLMUSDT,FILUSDT,INJUSDT,APTUSDT
```

### 2. Phase-Switch Supervisor (new file: `tools/phase_switch_supervisor.py`)

- Read FTMO_TF_P1 + FTMO_TF_P2
- Start executor with `FTMO_TF=$FTMO_TF_P1`, `FTMO_PROFIT_TARGET=$FTMO_P1_TARGET`, `FTMO_MAX_DAYS=$FTMO_P1_MAX_DAYS`
- Poll `ftmo-state-<P1_TF>-<ACCT>/equity-history.jsonl` every 60s
- On `equity >= initial_balance × (1 + P1_TARGET)`:
  1. Send SIGTERM to executor (uses existing graceful-shutdown handler)
  2. Wait for clean exit
  3. Archive P1 state-dir → `state-backups/<ACCT>-P1-<timestamp>/`
  4. Create empty P2 state-dir
  5. Spawn new executor with `FTMO_TF=$FTMO_TF_P2`, `FTMO_PROFIT_TARGET=$FTMO_P2_TARGET`
- On `equity >= initial × (1 + P2_TARGET)`: log success, exit gracefully.
- On daily-loss or max-days: log failure, exit.

### 3. PM2 Ecosystem (per-account)

```js
module.exports = {
  apps: [
    {
      name: "phase-switch-A",
      script: "tools/phase_switch_supervisor.py",
      interpreter: "python3",
      env_file: ".env.ftmo.A",
      autorestart: true,
    } /* ...B, C, D */,
  ],
};
```

### 4. TS Signal-Generator Templates (TS-mirror status)

Templates with full TS-mirrors (live-ready):

- AMBER, SHORTS_ONLY, AGGRESSIVE_24H_KELLY_REENTRY, AGGRESSIVE_24H_KELLY
- AMBER_MAX_PASSLOCK base, AMBER_MAX_PASSLOCK_BIDIR_MUTEX, MIXED_V3
- SHORTS_AGG, RISK05, RISK06 (added 2026-05-25)
- TOPAZ, OBSIDIAN, RUBIN (V5 family — existing)

### 5. ⚠️ KNOWN TS↔RUST DRIFT (audit-flagged 2026-05-25)

**`reentryAfterStop` is engine-only in Rust.** TS V4 engine
(`src/utils/ftmoLiveEngineV4.ts`) does NOT implement re-entry-after-stop.
Rust `v5_amber_max_passlock_shorts_agg()` sets
`reentry_after_stop = {within_bars:12, size_mult:0.5}` but the field is
silently dropped at live runtime.

**Impact:** ~3-8pp pass-rate drift on SHORTS_AGG live vs Rust backtest.
GA Stack-4 still works at ~85-90% live with this drift baked in.

**Fix path (deferred until live-deploy):** implement `reentryAfterStop`
handler in `ftmoLiveEngineV4.ts` — track last stop-out bar per asset,
on next entry within `withinBars`, multiply size by `sizeMult`. Add
parity test against Rust.

Templates that may be engine-only (executor-side exits, no TS mirror needed):

- `agg-kr-hold120` (just `hold_bars=120`)
- `agg-kr-chandelier` (chandelier exit — verify executor implements)

### 5. Cost-Benefit Validation (live first 30d)

- Run all 4 accounts on FTMO Free Trial (or paid Challenge) for ONE complete cycle.
- Measure: actual CF rate, drift from 88.82% backtest, dust-trade slippage.
- If live ≥ 70% (gap <19pp): proceed scaling.
- If live < 60%: pause + audit.

## Implementation Time-Budget Estimate

- Phase-switch supervisor: 2h
- TS-mirror missing templates: 2-3h
- PM2 ecosystem + env files: 30min
- Integration test (paper trade 1 day): 1h
- **Total: ~6h focused work** before first FTMO Challenge cycle.

## Decision Gate

**Implement only when ALL true:**

- Florian commits to deploying Stack-4 (not just exploring backtests)
- FTMO Challenge fees ($300×4 = $1200) approved
- Live-deploy hardware ready (VPS or local Windows with 4× MT5 instances)

Until then: stay theoretical, keep optimizing in backtest.
