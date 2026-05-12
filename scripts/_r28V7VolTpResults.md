# R28_V7 Volatility-Adaptive TP Sweep — Results

## Setup

- **Base:** `FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6` (uniform tpMult ×0.55 of QUARTZ_LITE per-asset tpPct)
- **Engine:** V4 live engine `simulate()` — `ftmoLiveEngineV4.simulate()`
- **Data:** 9 cryptos (AAVE/ADA/BCH/BNB/BTC/ETC/ETH/LTC/XRP), 30m bars, ~5.55y
- **Windows:** 30-day max-hold, 14-day step, 5000-bar warmup → 136 windows total
- **Engine flags:** R28_V6 unchanged — atrStop p56m2, breakEven 3%, chandelier p56m2, partialTakeProfit triggerPct=0.012/closeFraction=0.7, dpt 0.012, peakDD throttle 0.03/0.15, liveCaps maxStopPct=0.05/maxRiskFrac=0.4
- **Vol scope:** 14d / 30d realized log-return stdev on 30m bars, measured at `start - 1` (no look-ahead). Cross-window per-asset MEDIANS used as scaling reference.

## Variants

| Variant | TP-Override Rule                                                           |
| ------- | -------------------------------------------------------------------------- |
| V0      | Baseline R28_V6 (control, no override) — must match 56.62%                 |
| V1      | tp = base × clip(vol_14d / med_14d, 0.5, 2.0)                              |
| V2      | tp = base × clip(vol_30d / med_30d, 0.5, 2.0)                              |
| V3      | 2-stage regime: tp × 1.3 if vol_14d > med else tp × 0.7                    |
| V4      | Per-asset class: BTC/ETH=0.50, AAVE=0.65, mid=0.55 (replaces uniform 0.55) |

## Per-Asset Median 14d Vol (annualized log-return stdev at 30m timeframe)

| Asset | med14 (raw stdev per-bar)  |
| ----- | -------------------------- |
| BTC   | 0.00376 (lowest)           |
| BNB   | 0.00433                    |
| ETH   | 0.00491                    |
| BCH   | 0.00568                    |
| XRP   | 0.00558                    |
| LTC   | 0.00579                    |
| ADA   | 0.00614                    |
| ETC   | 0.00632                    |
| AAVE  | 0.00735 (highest, ~2× BTC) |

Key insight: AAVE has roughly 2× the realized vol of BTC. R28_V6 still uses ×0.55 uniformly — V4 hypothesizes this leaves edge on the table.

## Results

(filled in by aggregator — see `scripts/cache_voltp_r28v7/aggregate.log` and below)

### Pass-rate summary

_Pending — populated when run completes._

### Failure reasons per variant

_Pending._

## Verdict

_Pending. Goal: ANY variant ≥58% beats baseline (56.62%)._
