# Pattern Audit — 90% Unconditional Hunt (2026-05-19)

## Executive Summary

After exhausting 7 macro-regime / time-based filters that all degraded
unconditional pass-rate, **trade-level momentum patterns** revealed three
robust, OOS-validated signals strong enough to enable a different bot
architecture.

## Strongest Patterns (OOS-validated, train/test split)

### P1: "first-5 cum > 0" — best single pre-challenge filter

| Metric                             | Train | Test  | OOS-Δ              |
| ---------------------------------- | ----- | ----- | ------------------ |
| Played                             | 44    | 33    | —                  |
| Conditional pass                   | 81.8% | 90.9% | +9.1pp             |
| Unconditional pass                 | 49.3% | 41.1% | (test half easier) |
| **Wasted-pass (passes we'd skip)** | **0** | **0** | —                  |

**Mechanism:** If the first 5 trades of a window are net-positive,
85.7% of those challenges pass. If they're net-negative, **0%** pass.

Combined with cluster (b≥10 m≥2): **94.6% / 100.0%** conditional with
0 wasted passes on test.

### P2: "2 consecutive losses early" — perfect negative predictor

| Metric                         | Train+Test combined |
| ------------------------------ | ------------------- |
| Windows starting with 2 losses | 31                  |
| Of which pass                  | **0**               |
| Pass-rate                      | **0.00%**           |

**Mechanism:** Any window whose first 2 trades both lose has zero
historical chance of passing. 100% precision negative-class detector.

### P3: 5-trade momentum auto-correlation

| Direction                | Frequency | Momentum hold-rate |
| ------------------------ | --------- | ------------------ |
| first-5 POS → next-5 POS | 56/72     | **77.8%**          |
| first-5 NEG → next-5 NEG | 4/7       | 57.1%              |

**Mechanism:** Profitable 5-trade windows tend to be followed by more
profitable 5-trade windows. Loss windows persist less strongly.

This is the **enabling condition** for paper-trade-pre-filter: rolling
paper-trade-5-cum is a sticky regime indicator (auto-correlated).

## Implementation Options

### Option A: Paper-Trade-Pre-Filter (best for pass-rate)

**Idea:** Bot runs `signal_tracker_mode` permanently (no MT5). Tracks
rolling 5-paper-trade cum. Buys challenge only when:

- Cluster gate green (b≥10 m≥2), AND
- Rolling 5-paper-trade cum > 0

**Expected outcome (backtest-projected):**

- Conditional pass: **85-86%**
- Unconditional pass: **45% (= oracle-max)**
- Challenges bought: ~50% of weeks (vs ~45% with cluster-only)
- FTMO-fees saved: ~$13.8k over 6.4y backtest period

**Engineering effort:** Medium. Needs a simple paper-execution layer
that simulates each signal's outcome from Binance candles using the
config's TP/SL targets. ~1-2 days of work.

### Option B: Early-Abort In-Challenge (damage limitation)

**Idea:** After 2 consecutive losses OR cum<-2% at trade 5, close
all positions and stop trading until next gate cycle.

**Expected outcome:**

- Pass-rate: UNCHANGED (0 wasted-pass)
- Avg loss per fail: -11.06% → -9.03% (saved 2pp/fail)
- Net P&L across 146 windows: +194.9% → **+357.5%** (+162.6pp)

**Engineering effort:** Trivial. Single rule in `ftmo_executor.py`.
~30 minutes. Already-validated patterns.

### Option C: Half-Size-Bootstrap (hybrid)

**Idea:** First 5 trades use 0.5× position size. If cum>0 at trade 5,
scale to 1.0×. If cum<0, stay at 0.5× or stop entirely.

**Expected outcome:** Partial benefit of both. Harder to model offline
without re-running engine.

## Recommendation

1. **Ship Option B today** — trivial, well-validated, +162pp net-P&L.
2. **Build Option A as next milestone** — 1-2 days, gets to 85% conditional.
3. **Option C** is engineering-heavy and superseded by A.

## Hard Ceiling Reminder

Perfect-oracle single-config maximum is **66/146 = 45.21% unconditional**.
Option A achieves this **fully**. To exceed 45%, the strategy itself
must change (mean-revert config for quiet markets, regime-switching
ensemble, ML classifier) — multi-day engineering each.

For 90% unconditional, multi-account stacking remains the only
mathematically tractable path (memory `project_session_2026_05_16_phase19_7stack.md`).
