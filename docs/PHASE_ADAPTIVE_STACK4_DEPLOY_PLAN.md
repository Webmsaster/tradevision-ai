# Phase-Adaptive Stack-4 Live-Deployment Plan

**Status:** ⚠️ NEEDS RE-BASELINE (Wave5 audit 2026-05-25 found MTM-DL bug that
inflated all prior pass-rate claims by ~26-29pp).
**Infrastructure:** Live-ready (supervisor + PM2 + envs + audit-hardened).
**Source finding:** [[session-2026-05-25-phase-adaptive-stack4]] (BUG-INFLATED 93.11% OOS pre-fix).

## ⚠️ WAVE5 CRITICAL UPDATE

20-agent parallel audit (2026-05-25) found ~25 KRIT bugs (~15 fixed). The
biggest: **harness.rs DL/TL was checking realised-only equity, not MIN(equity,
mtm_equity).** FTMO server enforces equity-based DL (every tick); the Rust
backtest was lenient. Fresh post-fix sweeps (`/tmp/seq_*_w5.jsonl`):

| Template    | Pre-fix P1 | Post-fix P1 | Drop     |
| ----------- | ---------- | ----------- | -------- |
| AMBER       | 52.10%     | 26.00%      | -26.10pp |
| SHORTS_AGG  | 52.60%     | 23.20%      | -29.40pp |
| SHORTS_ONLY | ~50%       | 24.10%      | -25.90pp |
| OBSIDIAN    | ~52%       | 25.60%      | -26.40pp |

**HONEST Stack-4 baseline (W5 GA + SMC + param-overrides, 48 templates, 10 seeds):**
**43.41% OOS BEST / 42.07% mean** (range [39.52%, 43.41%]). TRAIN 27.48%.

Progression:

- 42.51% (15 templates, pre-Step1)
- 42.81% (+0.30pp from SMC voter activation, Step 1)
- 43.41% (+0.60pp from parameter-overrides on AMBER, Step 1.5)
- TOTAL: +0.90pp validated lift over pre-Step1 baseline

Per Step-1 pattern (1/3 to 1/10 of agent projections), remaining Steps 2+3
would likely deliver another +0.5-1.5pp = realistic Stack-4 ceiling ~44-45%.

- Solo TRUE-SEQ CF: ~8-9% per template (was claimed ~30-36%)
- Live-realistic ~37-40% → E[funded] ~1.5-1.7/4 accounts
- Cost-research: backtest leicht konservativ → +1pp live-headroom
- **Expected trader-share: ~$7-8.5k/mo** (NOT $16-20k claimed pre-fix)

Honest Stack-4 config (5 seeds independently converged):
| Account | P1 Template | P2 Template |
|---|---|---|
| A | `mixed-v4-cvd-only` | `mixed-v2` |
| B | `mixed-v2` | `obsidian` |
| C | `agg-kr-combo` | `agg-kr-low-tp` |
| D | `obsidian` | `mixed-v4-cvd-only` |

(Earlier 36.23% config was on 15-template pool; expanding to 31 templates
unlocked +6.28pp by including mixed-detector + agg-kr variants.)

Path to 50%+: Forex-MR tuning (~2-4h work) projected +6-10pp Stack-lift
due to true cross-asset orthogonality. Documented in next-session plan.

**DECISION GATE:** Do NOT commit FTMO Challenge fees ($1200) until honest
Stack-4 number is established + cross-validated. Prior 97.28% claim was bug-
inflated, real number likely 35-50%.

## Recommended Stack-4 Config (live-deployable, no ext24 dependency)

| Account | P1 Template                         | P2 Template (auto-switch on P1-target hit) |
| ------- | ----------------------------------- | ------------------------------------------ |
| A       | `v5-amber-max-passlock-shorts-agg`  | `v5-amber-max-passlock-shorts-only`        |
| B       | `v5-obsidian-passlock`              | `v5-amber-max-passlock` (base)             |
| C       | `v5-amber-max-passlock-shorts-only` | `v5-amber-max-passlock-risk06`             |
| D       | `v5-amber-max-passlock-risk06`      | `v5-amber-max-passlock-shorts-agg`         |

Walk-forward TEST 93.11% / TRAIN 85.59% / drift +7.53pp = ROBUST (anti-overfit, 4 seeds converged to same optimum).

## Why NO EXT24 (audit-driven decision)

Original GA winner used `ext24_amber` / `ext24_shorts-only` (24-asset basket via DOGE/XLM/FIL/INJ/APT extension). Post-deploy audit found `FTMO_SYMBOLS_EXT24` env-var was declared in .env files but NOT WIRED into the live signal-service or executor. Wiring it = ~1d engineering work + asset-list maintenance burden. Re-running GA WITHOUT ext24 templates found a strong alternative at 93.11% OOS (vs 97.28% with ext24). Conservative deploy-ready config trades 4.17pp theoretical performance for zero implementation risk.

## Robustness Range (10 GA seeds, no-ext24 run)

TEST range: [88.92%, 93.11%], mean 91.38%. Conservative live-realistic estimate: 82-88%.

## Live-Drift Sensitivity (worst-case modeling)

Backtest 93.11% × (1 - live_drift):
| Live Drift | Live CF rate | E[funded accts] | Monthly Trader-Share (@$5k/funded) |
| ---------- | ------------ | --------------- | ---------------------------------- |
| -5pp | 88.11% | 3.52/4 | $17.6k/mo |
| -10pp | 83.11% | 3.32/4 | $16.6k/mo |
| -15pp | 78.11% | 3.12/4 | $15.6k/mo |
| -20pp | 73.11% | 2.92/4 | $14.6k/mo |
| -30pp (catastrophic) | 63.11% | 2.52/4 | $12.6k/mo |

Even with catastrophic 30pp drift (historical worst case), Stack-4 phase-adaptive
remains profitable at >$12k/mo expected.

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
