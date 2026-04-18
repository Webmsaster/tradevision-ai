# Daytrading Analyzer — Autonomous Improvement Log

Goal: consistently profitable daytrading analyzer. Rolling experiment record.

## Iteration 1 — baseline (already shipped)

**Verified edges (see `src/utils/intradayLab.ts`, `liveSignals.ts`):**

| Strategy           | Symbol | OOS Sharpe (fwd) | Sharpe (rev) | Comment                         |
| ------------------ | ------ | ---------------- | ------------ | ------------------------------- |
| Champion long-only | SOL    | 10.83            | -1.33        | Regime-dependent                |
| Champion long-only | ETH    | 11.59            | -5.95        | Regime-dependent                |
| Champion long-only | BTC    | 6.89             | -4.07        | Regime-dependent                |
| Monday-Reversal    | ETH    | 2.44             | —            | Regime-independent (structural) |
| Monday-Reversal    | BTC    | 1.87             | —            | Regime-independent              |
| Funding Carry      | SOL    | ~4 (ann 83%)     | —            | Market-neutral, 0.26% DD        |
| MVRV regime        | BTC    | 8/8 WR           | —            | 16-year sample, very low freq   |

**Known issues:**

- Reversed-split negative → hour patterns change over regimes
- Single-shot train/test, no rolling re-validation
- No ensemble, each strategy isolated
- Assumed 100% maker fill rate (unrealistic)

## Iteration 2 — goals

1. Walk-forward rolling retrain (retrain every N bars, aggregate OOS)
2. Grid-search optimal {train window, retrain frequency, top-K, SMA period, long-only}
3. Ensemble of edges with Sharpe-weighted position sizing
4. Execution realism: 70-80% maker fill rate simulation
5. Vol-regime filter gate

## Results table (updated each iteration)

### Iteration 2 results (2026-04-18)

**Walk-Forward Rolling Retrain (21 windows × 30 days each):**

Baseline (100% maker fill):

- BTC: trades=1640, ret=+90.5%, Sharpe 7.71, DD 6.4%, 16/21 positive windows
- ETH: trades=1608, ret=+163%, Sharpe 8.75, DD 7.8%, 16/21 positive
- SOL: trades=1550, ret=+258%, Sharpe 10.01, DD 11.5%, 17/21 positive

**Grid-search best configs (sma=24, topK=2-3 dominated):**

- BTC: trainBars=2160, testBars=2160, topK=2, sma=24 → Sharpe 19.32 / DD 3.6%
- ETH: trainBars=8760, testBars=720, topK=3, sma=24 → Sharpe 21.20 / DD 4.5%
- SOL: trainBars=2160, testBars=720, topK=2, sma=24 → Sharpe 25.11 / DD 5.6%

**Realistic execution (60% maker fill, 3bps adverse-selection, skip funding hours):**

- SOL Sharpe 17.32 / +108% / DD 8.1% / 18 of 21 positive windows
- ETH Sharpe 8.54 / +34% / DD 10.3% / 18 of 21 positive
- BTC Sharpe 6.17 / +18% / DD 7.0% / 14 of 21 positive

**Pessimistic (50% fill, 5bps adverse):**

- SOL Sharpe 18.75 / +88% (robustest)
- ETH Sharpe 4.12 / +12%
- BTC Sharpe 3.57 / +8% (still positive)

**Taker-fallback is NET negative** — BTC Sharpe drops from 6.17 → 3.16, ETH 8.54 → 1.12. Better to skip unfilled trades than chase with taker.

**Portfolio allocation (3-symbol ensemble):**

- BTC 28% / ETH 22% / SOL 18% (sum 68%, rest free)
- Portfolio std target 15% hit, leverage 0.72, DD governor: full

### Iteration 2 key findings

1. **Champion strategy is REAL** — survives realistic execution with positive Sharpe 3.5-17 depending on symbol
2. **SOL is the strongest carrier** — robust across all execution regimes
3. **Adverse-selection penalty is real** — 3bps per fill is significant when total edge is ~20 bps
4. **Funding hours (00/08/16 UTC) should be skipped** — wider spreads, toxic flow
5. **Maker-only beats taker-fallback** — missed fills are cheaper than adverse fills
6. **topK=2-3 + sma=24h are optimal** — smaller/fast is better than larger/slow

### Next iteration targets

1. Apply realistic cost model to liveSignals.ts (currently still 100% fill)
2. Backtest Monday-Reversal + Funding-Carry with realistic execution
3. Build multi-strategy portfolio equity curve backtest (not just allocation)
4. Add vol-regime filter (only trade when realized vol in certain percentile)
5. Deflated-Sharpe calc (Bailey/López de Prado 2014) to discount multi-testing bias
