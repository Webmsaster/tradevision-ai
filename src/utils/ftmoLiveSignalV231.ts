/**
 * Live iter231 multi-asset signal detector.
 *
 * Checks ETH/BTC/SOL for mean-reversion signals on their MOST RECENTLY
 * CLOSED 4h bar. Returns all triggered signals with exact entry/stop/tp
 * levels and position-size multiplier based on current equity state.
 *
 * This is iter231-aware: it knows about the delayed BTC/SOL activation
 * (minEquityGain 4%), the ETH pyramid (earlyPyr 5x @ +0.3%), the 5-tier
 * adaptive sizing curve, the timeBoost, and Kelly sizing.
 *
 * The caller must pass current account state (equity, day in challenge,
 * recent PnLs for Kelly) so we can compute the exact risk multiplier.
 */
import type { Candle } from "@/utils/indicators";
import { ema, atr } from "@/utils/indicators";
import {
  FTMO_DAYTRADE_24H_CONFIG_V231,
  FTMO_DAYTRADE_24H_CONFIG_V236,
  FTMO_DAYTRADE_24H_CONFIG_V238,
  FTMO_DAYTRADE_24H_CONFIG_V239,
  FTMO_DAYTRADE_24H_CONFIG_V240,
  FTMO_DAYTRADE_24H_CONFIG_V241,
  FTMO_DAYTRADE_24H_CONFIG_V242,
  FTMO_DAYTRADE_24H_CONFIG_V243,
  FTMO_DAYTRADE_24H_CONFIG_V244,
  FTMO_DAYTRADE_24H_CONFIG_V245,
  FTMO_DAYTRADE_24H_CONFIG_V246,
  FTMO_DAYTRADE_24H_CONFIG_V247,
  FTMO_DAYTRADE_24H_CONFIG_V248,
  FTMO_DAYTRADE_24H_CONFIG_V249,
  FTMO_DAYTRADE_24H_CONFIG_V250,
  FTMO_DAYTRADE_24H_CONFIG_V251,
  FTMO_DAYTRADE_24H_CONFIG_V251_FAST,
  FTMO_DAYTRADE_24H_CONFIG_V252,
  FTMO_DAYTRADE_24H_CONFIG_V253,
  FTMO_DAYTRADE_24H_CONFIG_V254,
  FTMO_DAYTRADE_24H_CONFIG_V255,
  FTMO_DAYTRADE_24H_CONFIG_V256,
  FTMO_DAYTRADE_24H_CONFIG_V257,
  FTMO_DAYTRADE_24H_CONFIG_V258,
  FTMO_DAYTRADE_24H_CONFIG_V259,
  FTMO_DAYTRADE_24H_CONFIG_V260,
  FTMO_DAYTRADE_24H_CONFIG_V261,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V11_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
  FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V2,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GOLD,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM_30M,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ENSEMBLE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PARETO,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FUND,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIGH,
  FTMO_DAYTRADE_24H_CONFIG_V13_15M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_BULL,
} from "@/utils/ftmoDaytrade24h";
import type { NewsEvent } from "@/utils/forexFactoryNews";
import { isNewsBlackout } from "@/utils/forexFactoryNews";
import { LIVE_MAX_RISK_FRAC, LIVE_MAX_STOP_PCT } from "@/utils/ftmoLiveCaps";

export type Regime = "BULL" | "BEAR_CHOP";

/**
 * LIVE_MAX_RISK_FRAC is account-risk fraction at stop, not raw exposure.
 * LIVE_MAX_STOP_PCT caps ATR-adaptive stop widening before sending to MT5.
 *
 * 2026-04-26 update: tightened originally to 2% / 3% (ultra-safe), but those
 * caps made the 30d FTMO challenge mathematically unprofitable for crypto
 * mean-reversion. Loosened to 4% / 5%, so a single stop costs at most 4%.
 */

export interface AccountState {
  /** Current equity as fraction of starting capital (1.0 = break even, 1.05 = +5%). */
  equity: number;
  /** Day in challenge (0 = day 1). */
  day: number;
  /** PnL fractions of last N completed trades (most recent last). */
  recentPnls: number[];
  /** Start-of-day equity for daily-loss check. */
  equityAtDayStart: number;
}

export interface LiveSignal {
  assetSymbol: string; // iter231: ETH-MR/ETH-PYR/BTC-MR/SOL-MR; BULL: ETH-BULL/ETH-BULL-PYRAMID
  sourceSymbol: string;
  direction: "short" | "long";
  regime: Regime;
  entryPrice: number; // market-bar close; exec price will be next-bar open
  stopPrice: number;
  tpPrice: number;
  stopPct: number;
  tpPct: number;
  /** Risk as fraction of account equity (e.g. 0.01 = 1% risk). */
  riskFrac: number;
  /** Effective multiplier applied (adaptive x timeBoost x kelly). */
  sizingFactor: number;
  maxHoldHours: number;
  maxHoldUntil: number;
  signalBarClose: number;
  reasons: string[];
  /** Trailing-stop config (Python executor will activate at activatePct profit). */
  trailingStop?: {
    activatePct: number;
    trailPct: number;
  };
  /**
   * Round 11 — Live versions of engine-only exit features.
   * All optional, no-ops when missing (V5 / legacy configs unaffected).
   *
   * partialTakeProfit: close `closeFraction` of lot when unrealized P&L
   *   crosses `triggerPct`. One-shot, sets a flag so it never re-fires.
   * partialTakeProfitLevels: multi-stage variant — each level fires once
   *   in order. Total closed across all levels must stay < 1.0.
   * chandelierExit: ATR-based trailing stop. ATR seeded with `atrAtEntry`
   *   from signal time so executor doesn't need to refetch a candle series.
   *   Stop = highest_close − mult × atrAtEntry (long).
   *   Only ratchets, never widens.
   * breakEvenAtProfit: when profit ≥ threshold, move SL to entry. One-shot.
   * timeExit: if `bars` bars elapse without minGainR × stopPct unrealized,
   *   close at market. Mirrors engine's triple-barrier semantics.
   */
  partialTakeProfit?: {
    triggerPct: number;
    closeFraction: number;
  };
  partialTakeProfitLevels?: Array<{
    triggerPct: number;
    closeFraction: number;
  }>;
  chandelierExit?: {
    /** ATR computed at signal time (price units, NOT fraction). */
    atrAtEntry: number;
    mult: number;
    minMoveR: number;
    /** stopPct used for minMoveR gating (price-fraction units). */
    stopPct: number;
  };
  breakEvenAtProfit?: {
    threshold: number;
  };
  timeExit?: {
    /** Max bars to wait for unrealized gain ≥ minGainR × stopPct. */
    maxBarsWithoutGain: number;
    minGainR: number;
    /** Bar duration in ms — executor uses to clock barsHeld. */
    barDurationMs: number;
  };
}

export interface DetectionResult {
  timestamp: number;
  regime: Regime;
  activeBotConfig: string;
  signals: LiveSignal[];
  skipped: Array<{ asset: string; reason: string }>;
  notes: string[];
  account: AccountState;
  btc: {
    close: number;
    ema10: number;
    ema15: number;
    uptrend: boolean;
    mom24h: number;
  };
}

// CFG selection via ENV var FTMO_TF:
// LIVE-CAP-VALIDATED (production-ready, with stopPct ≤ 5% + riskFrac ≤ 4%):
//   - "15m-live"  → LIVE_15M_V1 (82.41% / med 1d / p90 6d / EV $3197) ← CHAMPION
//   - "30m-live"  → LIVE_30M_V1 (71.74% / med 1d / p90 12d / EV $2771)
//   - "1h-live"   → LIVE_1H_V1  (74.89% / med 1d / p90 12d / EV $2897)
//   - "2h-live"   → LIVE_2H_V1  (71.68% / med 1d / p90 8d  / EV $2768) ← best tail
//   - "4h-live"   → LIVE_4H_V1  (61.17% / med 3d / p90 10d / EV $2348)
// LEGACY (no-cap configs — DIE at 0% under live caps, do NOT use live):
//   - "15m"       → V16 (no-cap 94.38%)
//   - "30m"       → V12 (no-cap 95.09%)
//   - "30m-turbo" → V12_TURBO (no-cap 93.28%)
//   - "1h"        → V7 (no-cap 94.10%)
//   - "2h"        → V6 (no-cap 94-96%)
//   - else        → V261 4h (no-cap 94.31%)
const USE_2H_TREND_V5_ENSEMBLE = process.env.FTMO_TF === "2h-trend-v5-ensemble";
const USE_2H_TREND_V5_STEP2 = process.env.FTMO_TF === "2h-trend-v5-step2";
const USE_2H_TREND_V5_FASTMAX = process.env.FTMO_TF === "2h-trend-v5-fastmax";
const USE_2H_TREND_V5_HIWIN = process.env.FTMO_TF === "2h-trend-v5-hiwin";
const USE_2H_TREND_V5_PRO = process.env.FTMO_TF === "2h-trend-v5-pro";
const USE_2H_TREND_V5_GOLD = process.env.FTMO_TF === "2h-trend-v5-gold";
const USE_2H_TREND_V5_DIAMOND = process.env.FTMO_TF === "2h-trend-v5-diamond";
const USE_2H_TREND_V5_PLATINUM = process.env.FTMO_TF === "2h-trend-v5-platinum";
const USE_2H_TREND_V5_PLATINUM_30M =
  process.env.FTMO_TF === "2h-trend-v5-platinum-30m";
const USE_2H_TREND_V5_TITANIUM = process.env.FTMO_TF === "2h-trend-v5-titanium";
const USE_2H_TREND_V5_OBSIDIAN = process.env.FTMO_TF === "2h-trend-v5-obsidian";
const USE_2H_TREND_V5_ZIRKON = process.env.FTMO_TF === "2h-trend-v5-zirkon";
const USE_2H_TREND_V5_AMBER = process.env.FTMO_TF === "2h-trend-v5-amber";
const USE_2H_TREND_V5_QUARTZ = process.env.FTMO_TF === "2h-trend-v5-quartz";
const USE_2H_TREND_V5_TOPAZ = process.env.FTMO_TF === "2h-trend-v5-topaz";
const USE_2H_TREND_V5_RUBIN = process.env.FTMO_TF === "2h-trend-v5-rubin";
const USE_2H_TREND_V5_PRIMEX = process.env.FTMO_TF === "2h-trend-v5-primex";
const USE_2H_TREND_V5_PRIME = process.env.FTMO_TF === "2h-trend-v5-prime";
const USE_2H_TREND_V5_NOVA = process.env.FTMO_TF === "2h-trend-v5-nova";
const USE_2H_TREND_V5_TITAN_REAL =
  process.env.FTMO_TF === "2h-trend-v5-titan-real";
const USE_2H_TREND_V5_LEGEND = process.env.FTMO_TF === "2h-trend-v5-legend";
const USE_2H_TREND_V5_TITAN = process.env.FTMO_TF === "2h-trend-v5-titan";
const USE_2H_TREND_V5_APEX = process.env.FTMO_TF === "2h-trend-v5-apex";
const USE_2H_TREND_V5_ELITE = process.env.FTMO_TF === "2h-trend-v5-elite";
const USE_2H_TREND_V5_HIGH = process.env.FTMO_TF === "2h-trend-v5-high";
const USE_2H_TREND_V5_ULTRA = process.env.FTMO_TF === "2h-trend-v5-ultra";
const USE_2H_TREND_V5_FUND = process.env.FTMO_TF === "2h-trend-v5-fund";
const USE_2H_TREND_V5_PARETO = process.env.FTMO_TF === "2h-trend-v5-pareto";
const USE_2H_TREND_V5_RECENT = process.env.FTMO_TF === "2h-trend-v5-recent";
const USE_2H_TREND_V5_ROBUST = process.env.FTMO_TF === "2h-trend-v5-robust";
const USE_2H_TREND_V15 = process.env.FTMO_TF === "2h-trend-v15";
const USE_2H_TREND_V14 = process.env.FTMO_TF === "2h-trend-v14";
const USE_2H_TREND_V13 = process.env.FTMO_TF === "2h-trend-v13";
const USE_2H_TREND_V12 = process.env.FTMO_TF === "2h-trend-v12";
const USE_2H_TREND_V11 = process.env.FTMO_TF === "2h-trend-v11";
const USE_2H_TREND_V10 = process.env.FTMO_TF === "2h-trend-v10";
const USE_2H_TREND_V9 = process.env.FTMO_TF === "2h-trend-v9";
const USE_2H_TREND_V8 = process.env.FTMO_TF === "2h-trend-v8";
const USE_2H_TREND_V7 = process.env.FTMO_TF === "2h-trend-v7";
const USE_2H_TREND_V6 = process.env.FTMO_TF === "2h-trend-v6";
const USE_2H_TREND_V5 = process.env.FTMO_TF === "2h-trend-v5";
const USE_2H_TREND_V4 = process.env.FTMO_TF === "2h-trend-v4";
const USE_2H_TREND_V3 = process.env.FTMO_TF === "2h-trend-v3";
const USE_2H_TREND_V2 = process.env.FTMO_TF === "2h-trend-v2";
const USE_2H_TREND = process.env.FTMO_TF === "2h-trend";
const USE_4H_TREND = process.env.FTMO_TF === "4h-trend";
const USE_5M_LIVE = process.env.FTMO_TF === "5m-live";
// "*-live" defaults to V2 (current best), "*-live-v1" pins legacy V1.
const USE_15M_LIVE_V1 = process.env.FTMO_TF === "15m-live-v1";
const USE_30M_LIVE_V1 = process.env.FTMO_TF === "30m-live-v1";
const USE_1H_LIVE_V1 = process.env.FTMO_TF === "1h-live-v1";
const USE_2H_LIVE_V1 = process.env.FTMO_TF === "2h-live-v1";
const USE_4H_LIVE_V1 = process.env.FTMO_TF === "4h-live-v1";
const USE_15M_LIVE = process.env.FTMO_TF === "15m-live";
const USE_30M_LIVE = process.env.FTMO_TF === "30m-live";
const USE_1H_LIVE = process.env.FTMO_TF === "1h-live";
const USE_2H_LIVE = process.env.FTMO_TF === "2h-live";
const USE_4H_LIVE = process.env.FTMO_TF === "4h-live";
const USE_15M = process.env.FTMO_TF === "15m";
const USE_30M_TURBO = process.env.FTMO_TF === "30m-turbo";
const USE_30M = process.env.FTMO_TF === "30m";
const USE_1H = process.env.FTMO_TF === "1h";
const USE_2H = process.env.FTMO_TF === "2h";
const CFG = USE_2H_TREND_V5_ENSEMBLE
  ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ENSEMBLE
  : USE_2H_TREND_V5_STEP2
    ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2
    : USE_2H_TREND_V5_RUBIN
      ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN
      : USE_2H_TREND_V5_TOPAZ
        ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ
        : USE_2H_TREND_V5_QUARTZ
          ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ
          : USE_2H_TREND_V5_AMBER
            ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER
            : USE_2H_TREND_V5_ZIRKON
              ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON
              : USE_2H_TREND_V5_OBSIDIAN
                ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN
                : USE_2H_TREND_V5_TITANIUM
                  ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM
                  : USE_2H_TREND_V5_PLATINUM_30M
                    ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM_30M
                    : USE_2H_TREND_V5_PLATINUM
                      ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM
                      : USE_2H_TREND_V5_DIAMOND
                        ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND
                        : USE_2H_TREND_V5_GOLD
                          ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GOLD
                          : USE_2H_TREND_V5_PRO
                            ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO
                            : USE_2H_TREND_V5_HIWIN
                              ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN
                              : USE_2H_TREND_V5_FASTMAX
                                ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX
                                : USE_2H_TREND_V5_PRIMEX
                                  ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX
                                  : USE_2H_TREND_V5_PRIME
                                    ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME
                                    : USE_2H_TREND_V5_NOVA
                                      ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA
                                      : USE_2H_TREND_V5_TITAN_REAL
                                        ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL
                                        : USE_2H_TREND_V5_LEGEND
                                          ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND
                                          : USE_2H_TREND_V5_TITAN
                                            ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN
                                            : USE_2H_TREND_V5_APEX
                                              ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX
                                              : USE_2H_TREND_V5_ELITE
                                                ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE
                                                : USE_2H_TREND_V5_HIGH
                                                  ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIGH
                                                  : USE_2H_TREND_V5_ULTRA
                                                    ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA
                                                    : USE_2H_TREND_V5_FUND
                                                      ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FUND
                                                      : USE_2H_TREND_V5_PARETO
                                                        ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PARETO
                                                        : USE_2H_TREND_V5_RECENT
                                                          ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT
                                                          : USE_2H_TREND_V5_ROBUST
                                                            ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST
                                                            : USE_2H_TREND_V15
                                                              ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT
                                                              : USE_2H_TREND_V14
                                                                ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14
                                                                : USE_2H_TREND_V13
                                                                  ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY
                                                                  : USE_2H_TREND_V12
                                                                    ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12
                                                                    : USE_2H_TREND_V11
                                                                      ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11
                                                                      : USE_2H_TREND_V10
                                                                        ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10
                                                                        : USE_2H_TREND_V9
                                                                          ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9
                                                                          : USE_2H_TREND_V8
                                                                            ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8
                                                                            : USE_2H_TREND_V7
                                                                              ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7
                                                                              : USE_2H_TREND_V6
                                                                                ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6
                                                                                : USE_2H_TREND_V5
                                                                                  ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5
                                                                                  : USE_2H_TREND_V4
                                                                                    ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4
                                                                                    : USE_2H_TREND_V3
                                                                                      ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3
                                                                                      : USE_2H_TREND_V2
                                                                                        ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V2
                                                                                        : USE_2H_TREND
                                                                                          ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1
                                                                                          : USE_4H_TREND
                                                                                            ? FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2
                                                                                            : USE_5M_LIVE
                                                                                              ? FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3
                                                                                              : USE_15M_LIVE
                                                                                                ? FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3
                                                                                                : USE_30M_LIVE
                                                                                                  ? FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2
                                                                                                  : USE_1H_LIVE
                                                                                                    ? FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2
                                                                                                    : USE_2H_LIVE
                                                                                                      ? FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V2
                                                                                                      : USE_4H_LIVE
                                                                                                        ? FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V2
                                                                                                        : USE_15M_LIVE_V1
                                                                                                          ? FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1
                                                                                                          : USE_30M_LIVE_V1
                                                                                                            ? FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1
                                                                                                            : USE_1H_LIVE_V1
                                                                                                              ? FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1
                                                                                                              : USE_2H_LIVE_V1
                                                                                                                ? FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1
                                                                                                                : USE_4H_LIVE_V1
                                                                                                                  ? FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V1
                                                                                                                  : USE_15M
                                                                                                                    ? FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT
                                                                                                                    : USE_30M_TURBO
                                                                                                                      ? FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT
                                                                                                                      : USE_30M
                                                                                                                        ? FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT
                                                                                                                        : USE_1H
                                                                                                                          ? FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT
                                                                                                                          : USE_2H
                                                                                                                            ? FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT
                                                                                                                            : FTMO_DAYTRADE_24H_CONFIG_V261; // ← default fallback if no flag matches

// BUGFIX 2026-04-28: warn loudly if FTMO_TF is set but didn't match any flag.
// Trailing whitespace, typos (v6 vs V6), or unknown variants previously
// silently fell through to V261 4h config — wrong strategy + wrong asset universe.
if (process.env.FTMO_TF && process.env.FTMO_TF.trim() !== process.env.FTMO_TF) {
  console.error(
    `[ftmo-live] WARNING: FTMO_TF=\"${process.env.FTMO_TF}\" has trailing whitespace — strip it!`,
  );
}
if (
  process.env.FTMO_TF &&
  ![
    USE_5M_LIVE,
    USE_15M_LIVE_V1,
    USE_15M_LIVE,
    USE_30M_LIVE_V1,
    USE_30M_LIVE,
    USE_30M_TURBO,
    USE_1H_LIVE_V1,
    USE_1H_LIVE,
    USE_2H_LIVE_V1,
    USE_2H_LIVE,
    USE_4H_LIVE,
    USE_15M,
    USE_30M,
    USE_1H,
    USE_2H,
    USE_2H_TREND,
    USE_2H_TREND_V2,
    USE_2H_TREND_V3,
    USE_2H_TREND_V4,
    USE_2H_TREND_V5,
    USE_2H_TREND_V5_NOVA,
    USE_2H_TREND_V5_PRIME,
    USE_2H_TREND_V5_PRIMEX,
    USE_2H_TREND_V5_TITAN,
    USE_2H_TREND_V5_TITAN_REAL,
    USE_2H_TREND_V5_LEGEND,
    USE_2H_TREND_V5_APEX,
    USE_2H_TREND_V5_ELITE,
    USE_2H_TREND_V5_HIGH,
    USE_2H_TREND_V5_ULTRA,
    USE_2H_TREND_V5_FUND,
    USE_2H_TREND_V5_PARETO,
    USE_2H_TREND_V5_RECENT,
    USE_2H_TREND_V5_ROBUST,
    USE_2H_TREND_V5_FASTMAX,
    USE_2H_TREND_V5_HIWIN,
    USE_2H_TREND_V5_PRO,
    USE_2H_TREND_V5_GOLD,
    USE_2H_TREND_V5_DIAMOND,
    USE_2H_TREND_V5_PLATINUM,
    USE_2H_TREND_V5_PLATINUM_30M,
    USE_2H_TREND_V5_TITANIUM,
    USE_2H_TREND_V5_OBSIDIAN,
    USE_2H_TREND_V5_ZIRKON,
    USE_2H_TREND_V5_AMBER,
    USE_2H_TREND_V5_QUARTZ,
    USE_2H_TREND_V5_TOPAZ,
    USE_2H_TREND_V5_RUBIN,
    USE_2H_TREND_V5_STEP2,
    USE_2H_TREND_V5_ENSEMBLE,
    USE_2H_TREND_V6,
    USE_2H_TREND_V7,
    USE_2H_TREND_V8,
    USE_2H_TREND_V9,
    USE_2H_TREND_V10,
    USE_2H_TREND_V11,
    USE_2H_TREND_V12,
    USE_2H_TREND_V13,
    USE_2H_TREND_V14,
    USE_2H_TREND_V15,
    USE_4H_TREND,
  ].some((f) => f)
) {
  console.error(
    `[ftmo-live] WARNING: FTMO_TF=\"${process.env.FTMO_TF}\" did not match any known config — falling back to V261 4h. Check spelling!`,
  );
}
void FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V11_30M_OPT; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V13_15M_OPT; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V231; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V236; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V238; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V239; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V240; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V241; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V242; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V243; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V244; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V245; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V246; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V247; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V248; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V249; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V250; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V251; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V251_FAST; // alternative speed variant
void FTMO_DAYTRADE_24H_CONFIG_V252; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V253; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V254; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V255; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V256; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V257; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V258; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V259; // rollback reference
void FTMO_DAYTRADE_24H_CONFIG_V260; // rollback reference

/**
 * Resolve human-readable config label from FTMO_TF env var.
 * Single source of truth — keep in sync with the CFG selection ladder
 * in this file. Bug-fix (Round 15): the LIVE_*_V1 labels lied: tf=15m-live
 * actually loads LIVE_15M_V3 (V2/V3 added later but the label string was
 * never updated). Now reflects the actually-loaded config.
 */
function resolveCfgLabel(tfLabel: string): string {
  const map: Record<string, string> = {
    "2h-trend-v5-nova": "TREND_2H_V5_NOVA",
    "2h-trend-v5-titan-real": "TREND_2H_V5_TITAN_REAL",
    "2h-trend-v5-titan": "TREND_2H_V5_TITAN",
    "2h-trend-v5-legend": "TREND_2H_V5_LEGEND",
    "2h-trend-v5-apex": "TREND_2H_V5_APEX",
    "2h-trend-v5-elite": "TREND_2H_V5_ELITE",
    "2h-trend-v5-high": "TREND_2H_V5_HIGH",
    "2h-trend-v5-ultra": "TREND_2H_V5_ULTRA",
    "2h-trend-v5-fund": "TREND_2H_V5_FUND",
    "2h-trend-v5-pareto": "TREND_2H_V5_PARETO",
    "2h-trend-v5-recent": "TREND_2H_V5_RECENT",
    "2h-trend-v5-robust": "TREND_2H_V5_ROBUST",
    "2h-trend-v5-prime": "TREND_2H_V5_PRIME",
    "2h-trend-v5-primex": "TREND_2H_V5_PRIMEX",
    "2h-trend-v5-fastmax": "TREND_2H_V5_FASTMAX",
    "2h-trend-v5-hiwin": "TREND_2H_V5_HIWIN",
    "2h-trend-v5-pro": "TREND_2H_V5_PRO",
    "2h-trend-v5-gold": "TREND_2H_V5_GOLD",
    "2h-trend-v5-diamond": "TREND_2H_V5_DIAMOND",
    "2h-trend-v5-platinum": "TREND_2H_V5_PLATINUM",
    "2h-trend-v5-platinum-30m": "TREND_2H_V5_PLATINUM_30M",
    "2h-trend-v5-titanium": "TREND_2H_V5_TITANIUM",
    "2h-trend-v5-obsidian": "TREND_2H_V5_OBSIDIAN",
    "2h-trend-v5-zirkon": "TREND_2H_V5_ZIRKON",
    "2h-trend-v5-amber": "TREND_2H_V5_AMBER",
    "2h-trend-v5-quartz": "TREND_2H_V5_QUARTZ",
    "2h-trend-v5-topaz": "TREND_2H_V5_TOPAZ",
    "2h-trend-v5-rubin": "TREND_2H_V5_RUBIN",
    "2h-trend-v5-step2": "TREND_2H_V5_STEP2",
    "2h-trend-v5-ensemble": "TREND_2H_V5_ENSEMBLE",
    "2h-trend-v5": "TREND_2H_V5",
    "2h-trend-v6": "TREND_2H_V6",
    "2h-trend-v7": "TREND_2H_V7",
    "2h-trend-v8": "TREND_2H_V8",
    "2h-trend-v9": "TREND_2H_V9",
    "2h-trend-v10": "TREND_2H_V10",
    "2h-trend-v11": "TREND_2H_V11",
    "2h-trend-v12": "TREND_2H_V12",
    "2h-trend-v13": "TREND_2H_V13",
    "2h-trend-v14": "TREND_2H_V14",
    "2h-trend-v15": "TREND_2H_V15",
    "2h-trend-v4": "TREND_2H_V4",
    "2h-trend-v3": "TREND_2H_V3",
    "2h-trend-v2": "TREND_2H_V2",
    "2h-trend": "TREND_2H_V1",
    "4h-trend": "TREND_4H_V2",
    "5m-live": "LIVE_5M_V3",
    "15m-live": "LIVE_15M_V3",
    "30m-live": "LIVE_30M_V2",
    "1h-live": "LIVE_1H_V2",
    "2h-live": "LIVE_2H_V2",
    "4h-live": "LIVE_4H_V2",
    "15m-live-v1": "LIVE_15M_V1",
    "30m-live-v1": "LIVE_30M_V1",
    "1h-live-v1": "LIVE_1H_V1",
    "2h-live-v1": "LIVE_2H_V1",
    "4h-live-v1": "LIVE_4H_V1",
    "15m": "V16",
    "30m-turbo": "V12-TURBO",
    "30m": "V12",
    "1h": "V7",
    "2h": "V6",
  };
  return map[tfLabel] ?? "V261";
}

/**
 * Compute current sizing factor from adaptiveSizing + timeBoost + Kelly.
 * Mirrors the engine's logic at src/utils/ftmoDaytrade24h.ts.
 */
function computeSizingFactor(account: AccountState): {
  factor: number;
  notes: string[];
} {
  const notes: string[] = [];
  let factor = 1;

  // Adaptive sizing tiers (sorted ascending; highest matching tier wins)
  if (CFG.adaptiveSizing && CFG.adaptiveSizing.length > 0) {
    for (const tier of CFG.adaptiveSizing) {
      if (account.equity - 1 >= tier.equityAbove) factor = tier.factor;
    }
    notes.push(
      `adaptiveSizing: equity=${((account.equity - 1) * 100).toFixed(2)}% → factor=${factor}`,
    );
  }

  // timeBoost override (only INCREASES)
  if (
    CFG.timeBoost &&
    account.day >= CFG.timeBoost.afterDay &&
    account.equity - 1 < CFG.timeBoost.equityBelow &&
    CFG.timeBoost.factor > factor
  ) {
    factor = CFG.timeBoost.factor;
    notes.push(
      `timeBoost: day=${account.day}, eq<${(CFG.timeBoost.equityBelow * 100).toFixed(0)}% → factor=${factor}`,
    );
  }

  // Kelly sizing multiplier
  if (
    CFG.kellySizing &&
    account.recentPnls.length >= CFG.kellySizing.minTrades
  ) {
    const wins = account.recentPnls.filter((p) => p > 0).length;
    const wr = wins / account.recentPnls.length;
    let kMult = 1;
    const sortedTiers = [...CFG.kellySizing.tiers].sort(
      (a, b) => b.winRateAbove - a.winRateAbove,
    );
    for (const tier of sortedTiers) {
      if (wr >= tier.winRateAbove) {
        kMult = tier.multiplier;
        break;
      }
    }
    factor *= kMult;
    notes.push(
      `kelly: wr=${(wr * 100).toFixed(0)}% (${wins}/${account.recentPnls.length}) → mult=${kMult} (combined factor=${factor.toFixed(3)})`,
    );
  } else if (CFG.kellySizing) {
    notes.push(
      `kelly: warming up (${account.recentPnls.length}/${CFG.kellySizing.minTrades} trades)`,
    );
  }

  return { factor, notes };
}

/**
 * Check if a 4h bar shows the N-red or N-green close sequence
 * (mean-reversion: N green closes → short signal).
 */
/**
 * Detect N consecutive close pattern.
 *
 * For trend-following longs (invert=true): N consecutive GREEN closes → long.
 * For mean-reversion (invert=false, MR mode): also checks GREEN by default
 *   because the engine's MR-mode triggers SHORT on N greens. The CALLER
 *   determines direction = invert ? "long" : "short" based on this same
 *   green-pattern (see line 702-703).
 *
 * For both directions in same call, pass `direction` argument.
 */
function hasSignalPattern(
  candles: Candle[],
  triggerBars: number,
  invert: boolean,
  direction: "long" | "short" = "short",
): boolean {
  const last = candles.length - 1;
  if (last < triggerBars) return false;
  // In MR mode (invert=false): longs need N reds, shorts need N greens
  // In trend mode (invert=true): longs need N greens, shorts need N reds
  // Compute "needsGreen" from direction + invert truth-table:
  //   direction=long, invert=true   → greens
  //   direction=long, invert=false  → reds
  //   direction=short, invert=true  → reds
  //   direction=short, invert=false → greens
  const needsGreen = (direction === "long") === invert;
  for (let k = 0; k < triggerBars; k++) {
    const cur = candles[last - k];
    const prev = candles[last - k - 1];
    if (!cur || !prev) return false;
    const isGreen = cur.close > prev.close;
    if (needsGreen ? !isGreen : isGreen) return false;
  }
  return true;
}

export function detectLiveSignalsV231(
  ethCandles: Candle[],
  btcCandles: Candle[],
  solCandles: Candle[],
  account: AccountState,
  newsEvents: NewsEvent[] = [],
  extraCandles?: Record<string, Candle[]>,
): DetectionResult {
  // BUGFIX 2026-04-28: filter out non-final (still-forming) candles before
  // detection. Binance returns the current incomplete bar at index [-1] when
  // polling close to bar boundary → would create phantom signals on partial
  // data that re-trigger on bar close.
  btcCandles = btcCandles.filter((c) => c.isFinal !== false);
  ethCandles = ethCandles.filter((c) => c.isFinal !== false);
  if (extraCandles) {
    const filtered: Record<string, Candle[]> = {};
    for (const [k, v] of Object.entries(extraCandles)) {
      filtered[k] = v.filter((c) => c.isFinal !== false);
    }
    extraCandles = filtered;
  }
  // Guard against empty/tiny candle arrays — prevents -1 / -2 index crashes.
  // BUGFIX 2026-04-28 (Live audit Bug 7): BULL detector reads
  // ethCandles[lastIdx-2], so we need at least 3 candles to be safe;
  // also need ≥3 BTC candles for momentum/EMA seeds.
  if (btcCandles.length < 3 || ethCandles.length < 3) {
    return {
      timestamp: Date.now(),
      regime: "BEAR_CHOP",
      activeBotConfig: "n/a",
      signals: [],
      skipped: [],
      notes: ["Empty candle arrays — skipping detection cycle"],
      account,
      btc: { close: 0, ema10: 0, ema15: 0, uptrend: false, mom24h: 0 },
    };
  }
  // BTC regime for cross-asset filter + regime-switching.
  // Read EMA periods + momentum threshold from CFG.crossAssetFilter
  // (was hardcoded 10/15/0.02 — broke for V6/V7 with EMA 12/16 mom 0.04).
  const caf = CFG.crossAssetFilter;
  const fastP = caf?.emaFastPeriod ?? 10;
  const slowP = caf?.emaSlowPeriod ?? 15;
  const momBars = caf?.momentumBars ?? 6;
  const momThr = caf?.momSkipShortAbove ?? 0.02;

  const btcCloses = btcCandles.map((c) => c.close);
  const btcEmaFastArr = ema(btcCloses, fastP);
  const btcEmaSlowArr = ema(btcCloses, slowP);
  const lastIdx = btcCandles.length - 1;
  const btcClose = btcCandles[lastIdx].close;
  const btcEma10 = btcEmaFastArr[lastIdx] ?? btcClose; // kept name for backwards-compat
  const btcEma15 = btcEmaSlowArr[lastIdx] ?? btcClose;
  const btcMom24h =
    lastIdx >= momBars
      ? (btcClose - btcCandles[lastIdx - momBars].close) /
        btcCandles[lastIdx - momBars].close
      : 0;
  const btcUptrend = btcClose > btcEma10 && btcEma10 > btcEma15;
  const btcBullMom = btcMom24h > momThr;
  const regime: Regime = btcUptrend && btcBullMom ? "BULL" : "BEAR_CHOP";

  const tfLabel = process.env.FTMO_TF ?? "4h";
  const cfgLabel = resolveCfgLabel(tfLabel);
  const shortBot = `${cfgLabel} (${tfLabel})`;
  // Detect if active CFG is trend-long (any asset has invertDirection=true and disableShort=true)
  const cfgIsTrendLong = (CFG.assets ?? []).some(
    (a) => a.invertDirection && a.disableShort,
  );
  const dirLabel = cfgIsTrendLong ? "LONG" : "SHORT";
  const result: DetectionResult = {
    timestamp: Date.now(),
    regime,
    activeBotConfig: regime === "BULL" ? "iter213-bull" : shortBot,
    signals: [],
    skipped: [],
    notes: [
      `Regime: ${regime} → active bot: ${regime === "BULL" ? "iter213-bull (LONG)" : `${shortBot} (${dirLabel})`}`,
    ],
    account,
    btc: {
      close: btcClose,
      ema10: btcEma10,
      ema15: btcEma15,
      uptrend: btcUptrend,
      mom24h: btcMom24h,
    },
  };

  // In BULL regime we delegate to BULL-bot logic (see below).
  if (regime === "BULL") {
    return detectBullSignals(
      ethCandles,
      btcCandles,
      account,
      newsEvents,
      result,
    );
  }

  // BEAR/CHOP regime: use iter231 short-only mean-reversion (original logic).
  const blockedByBtcFilter = btcUptrend || btcMom24h > momThr;
  if (blockedByBtcFilter) {
    result.notes.push(
      `BTC bullish (uptrend=${btcUptrend}, mom24h=${(btcMom24h * 100).toFixed(2)}%) — short signals blocked, longs OK`,
    );
  }

  // Session filter. Entry = next bar's open.
  // 30m: bar-close hour, 1h: bar-close, 2h/4h: standard.
  // BUGFIX 2026-04-28: Was missing V5..V15 + all V5 variants (NOVA/PRIMEX/STEP2/etc).
  // Single flag covers entire 2h family to prevent missing any future variant.
  const IS_2H_FAMILY =
    USE_2H_LIVE ||
    USE_2H ||
    USE_2H_TREND ||
    USE_2H_TREND_V2 ||
    USE_2H_TREND_V3 ||
    USE_2H_TREND_V4 ||
    USE_2H_TREND_V5 ||
    USE_2H_TREND_V6 ||
    USE_2H_TREND_V7 ||
    USE_2H_TREND_V8 ||
    USE_2H_TREND_V9 ||
    USE_2H_TREND_V10 ||
    USE_2H_TREND_V11 ||
    USE_2H_TREND_V12 ||
    USE_2H_TREND_V13 ||
    USE_2H_TREND_V14 ||
    USE_2H_TREND_V15 ||
    USE_2H_TREND_V5_NOVA ||
    USE_2H_TREND_V5_PRIME ||
    USE_2H_TREND_V5_PRIMEX ||
    USE_2H_TREND_V5_TITAN ||
    USE_2H_TREND_V5_TITAN_REAL ||
    USE_2H_TREND_V5_LEGEND ||
    USE_2H_TREND_V5_APEX ||
    USE_2H_TREND_V5_ELITE ||
    USE_2H_TREND_V5_HIGH ||
    USE_2H_TREND_V5_ULTRA ||
    USE_2H_TREND_V5_FUND ||
    USE_2H_TREND_V5_PARETO ||
    USE_2H_TREND_V5_RECENT ||
    USE_2H_TREND_V5_ROBUST ||
    USE_2H_TREND_V5_FASTMAX ||
    USE_2H_TREND_V5_HIWIN ||
    USE_2H_TREND_V5_PRO ||
    USE_2H_TREND_V5_GOLD ||
    USE_2H_TREND_V5_DIAMOND ||
    USE_2H_TREND_V5_PLATINUM ||
    USE_2H_TREND_V5_PLATINUM_30M ||
    USE_2H_TREND_V5_TITANIUM ||
    USE_2H_TREND_V5_OBSIDIAN ||
    USE_2H_TREND_V5_ZIRKON ||
    USE_2H_TREND_V5_AMBER ||
    USE_2H_TREND_V5_QUARTZ ||
    USE_2H_TREND_V5_TOPAZ ||
    USE_2H_TREND_V5_RUBIN ||
    USE_2H_TREND_V5_STEP2 ||
    USE_2H_TREND_V5_ENSEMBLE;
  const tfHours = USE_5M_LIVE
    ? 5 / 60
    : USE_15M_LIVE || USE_15M
      ? 0.25
      : USE_30M_LIVE || USE_30M || USE_30M_TURBO
        ? 0.5
        : USE_1H_LIVE || USE_1H
          ? 1
          : IS_2H_FAMILY
            ? 2
            : 4; // 4h default also handles USE_4H_TREND
  const ethLastIdx = ethCandles.length - 1;
  const b1 = ethCandles[ethLastIdx];
  const entryOpenTime = b1.openTime + tfHours * 3600_000;
  const entryHour = new Date(entryOpenTime).getUTCHours();
  const defaultHours =
    USE_5M_LIVE ||
    USE_15M_LIVE ||
    USE_15M ||
    USE_30M_LIVE ||
    USE_30M_TURBO ||
    USE_30M ||
    USE_1H_LIVE ||
    USE_1H
      ? Array.from({ length: 24 }, (_, i) => i)
      : IS_2H_FAMILY
        ? [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
        : [0, 4, 8, 12, 16, 20];
  const allowedHours = CFG.allowedHoursUtc ?? defaultHours;
  const hourBlocked = !allowedHours.includes(entryHour);
  if (hourBlocked) {
    result.notes.push(
      `Session filter: entry hour ${entryHour} UTC not in [${allowedHours.join(",")}]`,
    );
  }

  // News filter
  const newsBlocked = isNewsBlackout(entryOpenTime, newsEvents, 2);
  if (newsBlocked) {
    result.notes.push(`News blackout: within 2min of high-impact event`);
  }

  // HTF trend filter: block shorts if asset has run up >threshold in lookback window.
  // Engine matches this exact logic — was missing from live detector.
  let htfBlocked = false;
  let htfNote = "";
  if (CFG.htfTrendFilter && CFG.htfTrendFilter.apply !== "long") {
    const lb = CFG.htfTrendFilter.lookbackBars;
    const thr = CFG.htfTrendFilter.threshold ?? 0.1;
    const ethLast = ethCandles[ethCandles.length - 1].close;
    if (ethCandles.length > lb) {
      const ethBack = ethCandles[ethCandles.length - 1 - lb].close;
      const change = (ethLast - ethBack) / ethBack;
      if (change > thr) {
        htfBlocked = true;
        htfNote = `HTF trend filter blocks shorts: ETH +${(change * 100).toFixed(2)}% over ${lb} bars (>${(thr * 100).toFixed(2)}%)`;
        result.notes.push(htfNote);
      }
    }
  }

  // Loss-streak cooldown: pause entries after N consecutive losers.
  // Reads from account.recentPnls (most recent last). Engine matches.
  // BUGFIX 2026-04-28 (v2): Engine resets streak on reason !== "stop" (TP or
  // time exit). Live was counting any negative PnL as loss. PREVIOUS fix had
  // wrong magnitude — recentPnls are equity-fractions (d.profit/100000), so
  // a real stop = -riskFrac (~-4% with cap), not -stopPct*lev*riskFrac.
  // Threshold = 50% of expected stop magnitude = -riskFrac * 0.5.
  let lscBlocked = false;
  if (CFG.lossStreakCooldown) {
    const { afterLosses, cooldownBars } = CFG.lossStreakCooldown;
    const stopLikeThreshold = -LIVE_MAX_RISK_FRAC * 0.5; // -2% with riskFrac=0.04
    let streak = 0;
    for (let i = account.recentPnls.length - 1; i >= 0; i--) {
      if (account.recentPnls[i] <= stopLikeThreshold) streak++;
      else break;
    }
    if (streak >= afterLosses) {
      // Approximate bar age of streak start: each trade ~1 bar.
      // For live we just block until next bar after cooldown — best-effort.
      const cdHours = cooldownBars * tfHours;
      lscBlocked = true;
      result.notes.push(
        `Loss-streak cooldown: ${streak} losses in a row → pause ~${cdHours}h (cd=${cooldownBars} bars)`,
      );
    }
  }

  // sharedBlock now excludes blockedByBtcFilter — that filter is short-only
  // (skipShortsIfSecondaryUptrend). For Trend-Long configs (invertDirection),
  // BTC uptrend is GOOD, not bad. The per-asset block below will only apply
  // BTC filter to short-direction assets.
  const sharedBlock = hourBlocked || newsBlocked || htfBlocked || lscBlocked;

  // Compute sizing factor once
  const { factor, notes: sizingNotes } = computeSizingFactor(account);
  result.notes.push(...sizingNotes);

  // Per-asset signal check.
  // Reads triggerBars / riskFrac / minEquityGain from CFG.assets (was hardcoded).
  // Extra-asset candles (BNB, ADA, AVAX, BCH, DOGE, etc.) are loaded by
  // ftmoLiveService.ts when CFG.assets references them; here we honor any
  // sourceSymbol that has candles in the extraCandles map.
  const candlesForSrc: Record<string, Candle[]> = {
    ETHUSDT: ethCandles,
    BTCUSDT: btcCandles,
    SOLUSDT: solCandles,
    ...(extraCandles ?? {}),
  };
  const assets = (CFG.assets ?? []).flatMap((a) => {
    const src = a.sourceSymbol ?? a.symbol;
    const candles = candlesForSrc[src];
    if (!candles || candles.length < 50) return []; // need at least 50 bars
    return [
      {
        asset: a.symbol,
        source: src,
        candles,
        triggerBars: a.triggerBars ?? CFG.triggerBars,
        minEqGain: a.minEquityGain ?? 0,
        baseRisk: a.riskFrac,
        stopPctOverride: a.stopPct,
        tpPctOverride: a.tpPct,
        holdBarsOverride: a.holdBars,
        invertDirection: a.invertDirection,
        disableShort: a.disableShort,
        disableLong: a.disableLong,
      },
    ];
  });

  for (const a of assets) {
    // Check equity gate (delayed assets)
    if (a.minEqGain > 0 && account.equity - 1 < a.minEqGain) {
      result.skipped.push({
        asset: a.asset,
        reason: `equity gate: need +${(a.minEqGain * 100).toFixed(1)}%, at ${((account.equity - 1) * 100).toFixed(2)}%`,
      });
      continue;
    }
    if (sharedBlock) {
      result.skipped.push({
        asset: a.asset,
        reason: "blocked by session / news / HTF / LSC",
      });
      continue;
    }

    // Determine trade direction from asset config FIRST.
    // Default (MR mode): N consecutive greens → SHORT, N reds → LONG
    // invertDirection (Trend mode): N consecutive greens → LONG, N reds → SHORT
    const invert = a.invertDirection ?? CFG.invertDirection ?? false;
    const disableShortHere = a.disableShort ?? CFG.disableShort ?? false;
    const disableLongHere = a.disableLong ?? CFG.disableLong ?? false;
    // Pick the only allowed direction (or default per invert mode if both allowed)
    const direction: "short" | "long" = invert
      ? disableLongHere
        ? "short"
        : "long"
      : disableShortHere
        ? "long"
        : "short";

    // Signal pattern check — invert+direction selects greens-vs-reds correctly
    const hasPattern = hasSignalPattern(
      a.candles,
      a.triggerBars,
      invert,
      direction,
    );
    if (!hasPattern) {
      const seqType = (direction === "long") === invert ? "green" : "red";
      result.skipped.push({
        asset: a.asset,
        reason: `no ${a.triggerBars}-${seqType} sequence`,
      });
      continue;
    }

    // Per-asset BTC cross-asset filter — only blocks SHORT signals.
    // Trend-Long signals actually want BTC uptrend.
    if (direction === "short" && blockedByBtcFilter) {
      result.skipped.push({
        asset: a.asset,
        reason: `BTC uptrend blocks short signal`,
      });
      continue;
    }
    if (direction === "short" && a.disableShort) {
      result.skipped.push({
        asset: a.asset,
        reason: "shorts disabled for asset",
      });
      continue;
    }
    if (direction === "long" && a.disableLong) {
      result.skipped.push({
        asset: a.asset,
        reason: "longs disabled for asset",
      });
      continue;
    }

    // Build signal — honor per-asset stop/tp/hold overrides + atrStop floor.
    const last = a.candles[a.candles.length - 1];
    const entryPrice = last.close;
    let stopPct = a.stopPctOverride ?? CFG.stopPct;
    const tpPct = a.tpPctOverride ?? CFG.tpPct;
    // ATR-adaptive stop: take max(stopPct, atr*mult/entry) to widen on vol.
    if (CFG.atrStop) {
      const atrSeries = atr(a.candles, CFG.atrStop.period);
      const atrVal = atrSeries[atrSeries.length - 1];
      if (atrVal !== null && atrVal !== undefined) {
        const atrFrac = (CFG.atrStop.stopMult * atrVal) / entryPrice;
        stopPct = Math.max(stopPct, atrFrac);
      }
    }
    // Live safety cap: skip trade if ATR demands a stop wider than FTMO can survive.
    if (stopPct > LIVE_MAX_STOP_PCT) {
      result.skipped.push({
        asset: a.asset,
        reason: `stopPct ${(stopPct * 100).toFixed(2)}% > live cap ${(LIVE_MAX_STOP_PCT * 100).toFixed(1)}% (ATR too wide for FTMO)`,
      });
      continue;
    }
    // Direction-aware stop/TP price.
    const stopPrice =
      direction === "short"
        ? entryPrice * (1 + stopPct)
        : entryPrice * (1 - stopPct);
    const tpPrice =
      direction === "short"
        ? entryPrice * (1 - tpPct)
        : entryPrice * (1 + tpPct);
    const holdBarsEff = a.holdBarsOverride ?? CFG.holdBars;
    // BUGFIX 2026-04-28: backtest exit loop runs holdBars+1 bars (`mx = i+1+holdBars`
    // inclusive). Live had `holdBars*tfHours` wall-time → closed 1 bar early.
    // Add +1 bar to match backtest semantics.
    const maxHoldHours = (holdBarsEff + 1) * tfHours;

    // Live risk = baseRisk × sizingFactor, capped at LIVE_MAX_RISK_FRAC.
    const rawRiskFrac = a.baseRisk * factor;
    const effectiveRiskFrac = Math.min(rawRiskFrac, LIVE_MAX_RISK_FRAC);

    // Round 11 — compute ATR-at-entry for chandelier exit (executor side).
    // We pre-compute here because Python executor doesn't have a candle series.
    let chandelierAtrAtEntry: number | null = null;
    if (CFG.chandelierExit) {
      const chSeries = atr(a.candles, CFG.chandelierExit.period);
      const v = chSeries[chSeries.length - 1];
      if (v !== null && v !== undefined) chandelierAtrAtEntry = v;
    }

    result.signals.push({
      assetSymbol: a.asset,
      sourceSymbol: a.source,
      direction,
      regime: invert ? "BULL" : "BEAR_CHOP",
      entryPrice,
      stopPrice,
      tpPrice,
      stopPct,
      tpPct,
      riskFrac: effectiveRiskFrac,
      sizingFactor: factor,
      maxHoldHours,
      maxHoldUntil: entryOpenTime + maxHoldHours * 3600_000,
      signalBarClose: last.closeTime,
      reasons: [
        `${a.triggerBars}-${invert ? "green→LONG" : "green→SHORT"} pattern on ${a.source}`,
        `equity gate OK (need +${(a.minEqGain * 100).toFixed(1)}%)`,
        `sizing: baseRisk=${a.baseRisk} × factor=${factor.toFixed(3)} = ${rawRiskFrac.toFixed(4)} → live cap ${effectiveRiskFrac.toFixed(4)}`,
      ],
      // Pass trailing-stop config from CFG so Python executor can manage SL updates.
      ...(CFG.trailingStop
        ? {
            trailingStop: {
              activatePct: CFG.trailingStop.activatePct,
              trailPct: CFG.trailingStop.trailPct,
            },
          }
        : {}),
      // Round 11 — engine-feature forwarding. All no-op when CFG.* missing.
      ...(CFG.partialTakeProfit
        ? {
            partialTakeProfit: {
              triggerPct: CFG.partialTakeProfit.triggerPct,
              closeFraction: CFG.partialTakeProfit.closeFraction,
            },
          }
        : {}),
      ...(CFG.partialTakeProfitLevels && CFG.partialTakeProfitLevels.length > 0
        ? {
            partialTakeProfitLevels: CFG.partialTakeProfitLevels.map((lv) => ({
              triggerPct: lv.triggerPct,
              closeFraction: lv.closeFraction,
            })),
          }
        : {}),
      ...(CFG.chandelierExit && chandelierAtrAtEntry !== null
        ? {
            chandelierExit: {
              atrAtEntry: chandelierAtrAtEntry,
              mult: CFG.chandelierExit.mult,
              minMoveR: CFG.chandelierExit.minMoveR ?? 0.5,
              stopPct,
            },
          }
        : {}),
      ...(CFG.breakEven
        ? {
            breakEvenAtProfit: {
              threshold: CFG.breakEven.threshold,
            },
          }
        : {}),
      ...(CFG.timeExit
        ? {
            timeExit: {
              maxBarsWithoutGain: CFG.timeExit.maxBarsWithoutGain,
              minGainR: CFG.timeExit.minGainR,
              barDurationMs: tfHours * 3600_000,
            },
          }
        : {}),
    });
  }

  // Round-6 #11 (resolved Round-15): when MT5 receives multiple signals on the
  // same poll cycle and live-margin runs out before all are filled, the
  // executor should prefer the highest-conviction (= highest riskFrac) order.
  // We sort here so the Python executor processes signals in priority order
  // (descending). Stable sort preserves emission order on ties.
  result.signals.sort((a, b) => b.riskFrac - a.riskFrac);

  return result;
}

/**
 * BULL regime detector — uses iter213 config.
 * Signal: 2 consecutive GREEN closes on ETH → LONG (momentum continuation).
 * Gated by: BTC NOT in downtrend, 24h mom > -2%, session filter, news.
 */
function detectBullSignals(
  ethCandles: Candle[],
  btcCandles: Candle[],
  account: AccountState,
  newsEvents: NewsEvent[],
  result: DetectionResult,
): DetectionResult {
  const BULL = FTMO_DAYTRADE_24H_CONFIG_BULL;
  // BUGFIX 2026-04-28 (Live audit Bug 6): include 5m/15m/30m so BULL regime
  // doesn't compute the wrong entryOpenTime / maxHold offset when the bot
  // runs on shorter timeframes. Was: USE_1H ? 1 : USE_2H ? 2 : 4 (default).
  const tfHours = USE_5M_LIVE
    ? 5 / 60
    : USE_15M_LIVE || USE_15M
      ? 0.25
      : USE_30M_LIVE || USE_30M || USE_30M_TURBO
        ? 0.5
        : USE_1H || USE_1H_LIVE
          ? 1
          : USE_2H || USE_2H_LIVE
            ? 2
            : 4;
  const { factor, notes: sizingNotes } = computeSizingFactor(account);
  result.notes.push(...sizingNotes);

  const ethLastIdx = ethCandles.length - 1;
  const b0 = ethCandles[ethLastIdx - 1];
  const b1 = ethCandles[ethLastIdx];
  const last2Green =
    b1.close > b0.close && b0.close > ethCandles[ethLastIdx - 2]?.close;
  if (!last2Green) {
    result.notes.push("No 2-green sequence → no BULL signal");
    return result;
  }

  const entryOpenTime = b1.openTime + tfHours * 3600_000;
  if (isNewsBlackout(entryOpenTime, newsEvents, 2)) {
    result.notes.push("News blackout");
    return result;
  }

  const tpPct = BULL.tpPct;
  const stopPct = BULL.stopPct;
  const entryPrice = b1.close;
  const stopPrice = entryPrice * (1 - stopPct); // long: stop below
  const tpPrice = entryPrice * (1 + tpPct); // long: TP above
  const maxHoldHours = (BULL.holdBars + 1) * tfHours; // bugfix 2026-04-28: backtest parity
  const baseAsset = BULL.assets[0];
  // Live risk = baseRisk × factor, capped at LIVE_MAX_RISK_FRAC (no leverage multiplier).
  const rawRiskFrac = baseAsset.riskFrac * factor;
  const effectiveRiskFrac = Math.min(rawRiskFrac, LIVE_MAX_RISK_FRAC);

  // Long-stop safety cap.
  if (stopPct > LIVE_MAX_STOP_PCT) {
    result.notes.push(
      `BULL stopPct ${(stopPct * 100).toFixed(2)}% > live cap ${(LIVE_MAX_STOP_PCT * 100).toFixed(1)}% → skip`,
    );
    return result;
  }

  result.signals.push({
    assetSymbol: "ETH-BULL",
    sourceSymbol: "ETHUSDT",
    direction: "long",
    regime: "BULL",
    entryPrice,
    stopPrice,
    tpPrice,
    stopPct,
    tpPct,
    riskFrac: effectiveRiskFrac,
    sizingFactor: factor,
    maxHoldHours,
    maxHoldUntil: entryOpenTime + maxHoldHours * 3600_000,
    signalBarClose: b1.closeTime,
    reasons: [
      "BULL regime: 2-green momentum continuation",
      `sizing: baseRisk=${baseAsset.riskFrac} × factor=${factor.toFixed(3)} = ${rawRiskFrac.toFixed(4)} → live cap ${effectiveRiskFrac.toFixed(4)}`,
    ],
  });

  // Bull pyramid (ETH-BULL-PYRAMID) when equity ahead by 1.5%+
  if (account.equity - 1 >= 0.015) {
    const pyr = BULL.assets[1];
    const pyrRawRisk = pyr.riskFrac * factor;
    const pyrEffRisk = Math.min(pyrRawRisk, LIVE_MAX_RISK_FRAC);
    result.signals.push({
      assetSymbol: "ETH-BULL-PYRAMID",
      sourceSymbol: "ETHUSDT",
      direction: "long",
      regime: "BULL",
      entryPrice,
      stopPrice,
      tpPrice,
      stopPct,
      tpPct,
      riskFrac: pyrEffRisk,
      sizingFactor: factor,
      maxHoldHours,
      maxHoldUntil: entryOpenTime + maxHoldHours * 3600_000,
      signalBarClose: b1.closeTime,
      reasons: [
        "BULL pyramid fires at +1.5% equity",
        `sizing: baseRisk=${pyr.riskFrac} × factor=${factor.toFixed(3)} = ${pyrRawRisk.toFixed(4)} → live cap ${pyrEffRisk.toFixed(4)}`,
      ],
    });
  }

  return result;
}

/** Render a DetectionResult to human-readable text. */
export function renderDetection(r: DetectionResult): string {
  const lines: string[] = [];
  const ts =
    new Date(r.timestamp).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const tfLabel = process.env.FTMO_TF ?? "4h";
  const cfgLabel = resolveCfgLabel(tfLabel);
  lines.push(`━━━━━ ${cfgLabel} (${tfLabel}) Signal Check @ ${ts} ━━━━━`);
  const fastP = CFG.crossAssetFilter?.emaFastPeriod ?? 10;
  const slowP = CFG.crossAssetFilter?.emaSlowPeriod ?? 15;
  const momBars = CFG.crossAssetFilter?.momentumBars ?? 6;
  lines.push(
    `BTC: $${r.btc.close.toFixed(0)}  EMA${fastP}: $${r.btc.ema10.toFixed(0)}  EMA${slowP}: $${r.btc.ema15.toFixed(0)}  ${momBars}-bar mom: ${(r.btc.mom24h * 100).toFixed(2)}%`,
  );
  lines.push(
    `Account: equity=${((r.account.equity - 1) * 100).toFixed(2)}%  day=${r.account.day + 1}/30  recent trades: ${r.account.recentPnls.length}`,
  );
  lines.push("");
  for (const n of r.notes) lines.push(`  ${n}`);
  lines.push("");

  if (r.signals.length === 0) {
    lines.push("⏸  NO SIGNALS");
    for (const s of r.skipped) lines.push(`   ${s.asset}: ${s.reason}`);
  } else {
    lines.push(
      `🚨 ${r.signals.length} SIGNAL${r.signals.length > 1 ? "S" : ""}`,
    );
    for (const s of r.signals) {
      lines.push("");
      lines.push(
        `  ${s.assetSymbol} (${s.sourceSymbol}) — ${s.direction.toUpperCase()}`,
      );
      lines.push(`    Entry: $${s.entryPrice.toFixed(4)}`);
      lines.push(
        `    Stop:  $${s.stopPrice.toFixed(4)} (+${(s.stopPct * 100).toFixed(2)}%)`,
      );
      lines.push(
        `    TP:    $${s.tpPrice.toFixed(4)} (−${(s.tpPct * 100).toFixed(2)}%)`,
      );
      lines.push(`    Risk:  ${(s.riskFrac * 100).toFixed(3)}% of account`);
      lines.push(
        `    Max hold: ${s.maxHoldHours}h (until ${new Date(s.maxHoldUntil).toISOString().slice(0, 16)}Z)`,
      );
    }
  }
  return lines.join("\n");
}
