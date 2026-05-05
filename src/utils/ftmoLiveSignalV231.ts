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

// Phase 23 (V231 Bug 15): newsBlackout window now configurable via env.
// 2min was too short for high-impact events (NFP, CPI, FOMC move markets
// 30+ minutes). Default 15min covers post-event volatility tail.
// Phase 33 (Audit Bug 8): NaN-guard — bad env value silently disabled news
// filter (Number("abc") = NaN, all comparisons false → never blackout).
const _newsBlackoutRaw = Number(process.env.FTMO_NEWS_BLACKOUT_MIN ?? "15");
const NEWS_BLACKOUT_MINUTES =
  Number.isFinite(_newsBlackoutRaw) && _newsBlackoutRaw > 0
    ? _newsBlackoutRaw
    : 15;

// Phase 32 (Re-Audit V231 Bug 15): warn-once flag for the
// peakDrawdownThrottle missing-challengePeak warning.
let peakWarnedOnce = false;
import { ema, atr } from "@/utils/indicators";
// Phase 34 (Code-Quality Audit refactor): replace 109 named imports + 250-line
// ternary with a namespace import + Map-based CFG_REGISTRY. Bundles still
// tree-shake fine since each top-level export is independently re-exported
// from ftmoDaytrade24h.ts. See CFG_REGISTRY definition below for the
// FTMO_TF env-var → config + label mapping (single source of truth).
import * as CFGS from "@/utils/ftmoDaytrade24h";
import type { FtmoDaytrade24hConfig } from "@/utils/ftmoDaytrade24h";
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
  /**
   * Round 35: All-time challenge-peak equity (fraction of start). Required
   * for peakDrawdownThrottle sizing in R28_V2/V3/V4. Persisted server-side
   * by Python `update_challenge_peak()` → `challenge-peak.json`.
   * Optional for back-compat: if missing, treated as current equity (no throttle).
   */
  challengePeak?: number;
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

// Phase 34 (Code-Quality Audit refactor): single source of truth for the
// FTMO_TF env-var → config + label mapping. Replaces 65 USE_X consts, a
// 250-line nested ternary, an 80-line validation array, and 29 dead `void`
// rollback-references with one Map. Adding a new champion config now
// requires a one-line entry here instead of editing 4 places.
//
// Layout: `Record<string, { cfg, label }>` rather than two parallel maps —
// atomic add/remove, no risk of label drift from cfg.
//
// Live-cap-validated production tags ("*-live") map to V2/V3 evolutions of
// the LIVE_*_V1 family. Legacy "no-cap" tags (15m/30m/1h/2h/30m-turbo)
// keep their slots for rollback testing only — they stop trading under
// live caps.
type CfgRegistryEntry = { cfg: FtmoDaytrade24hConfig; label: string };
const CFG_REGISTRY: Record<string, CfgRegistryEntry> = {
  // Trend-2H V5 family (newest/most-specific → legacy)
  "2h-trend-v5-ensemble": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ENSEMBLE,
    label: "TREND_2H_V5_ENSEMBLE",
  },
  "2h-trend-v5-step2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2,
    label: "TREND_2H_V5_STEP2",
  },
  "2h-trend-v5-onyx": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ONYX,
    label: "TREND_2H_V5_ONYX",
  },
  "2h-trend-v5-jade": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_JADE,
    label: "TREND_2H_V5_JADE",
  },
  "2h-trend-v5-agate": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AGATE,
    label: "TREND_2H_V5_AGATE",
  },
  "2h-trend-v5-opal": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OPAL,
    label: "TREND_2H_V5_OPAL",
  },
  "2h-trend-v5-pearl": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PEARL,
    label: "TREND_2H_V5_PEARL",
  },
  "2h-trend-v5-emerald": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_EMERALD,
    label: "TREND_2H_V5_EMERALD",
  },
  "2h-trend-v5-sapphir": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_SAPPHIR,
    label: "TREND_2H_V5_SAPPHIR",
  },
  "2h-trend-v5-rubin": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN,
    label: "TREND_2H_V5_RUBIN",
  },
  "2h-trend-v5-topaz": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ,
    label: "TREND_2H_V5_TOPAZ",
  },
  "2h-trend-v5-quartz-step2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_STEP2,
    label: "TREND_2H_V5_QUARTZ_STEP2",
  },
  "2h-trend-v5-quartz-lite-r28-v4": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
    label: "TREND_2H_V5_QUARTZ_LITE_R28_V4",
  },
  "2h-trend-v5-quartz-lite-r28-v5": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5,
    label: "TREND_2H_V5_QUARTZ_LITE_R28_V5",
  },
  "2h-trend-v5-quartz-lite-r28-v6": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
    label: "TREND_2H_V5_QUARTZ_LITE_R28_V6",
  },
  "2h-trend-v5-quartz-lite-r28-v3": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V3,
    label: "TREND_2H_V5_QUARTZ_LITE_R28_V3",
  },
  "2h-trend-v5-quartz-lite-r28-v2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V2,
    label: "TREND_2H_V5_QUARTZ_LITE_R28_V2",
  },
  "2h-trend-v5-quartz-lite-r28": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
    label: "TREND_2H_V5_QUARTZ_LITE_R28",
  },
  "2h-trend-v5-quartz-lite": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
    label: "TREND_2H_V5_QUARTZ_LITE",
  },
  "2h-trend-v5-quartz": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
    label: "TREND_2H_V5_QUARTZ",
  },
  "2h-trend-v5-amber": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
    label: "TREND_2H_V5_AMBER",
  },
  "2h-trend-v5-zirkon": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON,
    label: "TREND_2H_V5_ZIRKON",
  },
  "2h-trend-v5-obsidian": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
    label: "TREND_2H_V5_OBSIDIAN",
  },
  "2h-trend-v5-titanium": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
    label: "TREND_2H_V5_TITANIUM",
  },
  "2h-trend-v5-platinum-30m": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM_30M,
    label: "TREND_2H_V5_PLATINUM_30M",
  },
  "2h-trend-v5-platinum": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
    label: "TREND_2H_V5_PLATINUM",
  },
  "2h-trend-v5-diamond": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND,
    label: "TREND_2H_V5_DIAMOND",
  },
  "2h-trend-v5-gold": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GOLD,
    label: "TREND_2H_V5_GOLD",
  },
  "2h-trend-v5-pro": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
    label: "TREND_2H_V5_PRO",
  },
  "2h-trend-v5-hiwin": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
    label: "TREND_2H_V5_HIWIN",
  },
  "2h-trend-v5-fastmax": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX,
    label: "TREND_2H_V5_FASTMAX",
  },
  "2h-trend-v5-primex": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
    label: "TREND_2H_V5_PRIMEX",
  },
  "2h-trend-v5-prime": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
    label: "TREND_2H_V5_PRIME",
  },
  "2h-trend-v5-nova": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
    label: "TREND_2H_V5_NOVA",
  },
  "2h-trend-v5-titan-real": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
    label: "TREND_2H_V5_TITAN_REAL",
  },
  // V5_LEGEND + V5_TITAN are runtime-blocked below (volTargeting maxMult=5).
  "2h-trend-v5-legend": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
    label: "TREND_2H_V5_LEGEND",
  },
  "2h-trend-v5-titan": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
    label: "TREND_2H_V5_TITAN",
  },
  "2h-trend-v5-apex": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
    label: "TREND_2H_V5_APEX",
  },
  "2h-trend-v5-elite": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
    label: "TREND_2H_V5_ELITE",
  },
  "2h-trend-v5-high": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIGH,
    label: "TREND_2H_V5_HIGH",
  },
  "2h-trend-v5-ultra": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
    label: "TREND_2H_V5_ULTRA",
  },
  "2h-trend-v5-fund": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FUND,
    label: "TREND_2H_V5_FUND",
  },
  "2h-trend-v5-pareto": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PARETO,
    label: "TREND_2H_V5_PARETO",
  },
  "2h-trend-v5-recent": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
    label: "TREND_2H_V5_RECENT",
  },
  "2h-trend-v5-robust": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
    label: "TREND_2H_V5_ROBUST",
  },
  "2h-trend-v5": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    label: "TREND_2H_V5",
  },
  // Trend-2H V6+ family
  "2h-trend-v15": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT,
    label: "TREND_2H_V15",
  },
  "2h-trend-v14": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14,
    label: "TREND_2H_V14",
  },
  "2h-trend-v13": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY,
    label: "TREND_2H_V13",
  },
  "2h-trend-v12": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
    label: "TREND_2H_V12",
  },
  "2h-trend-v11": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11,
    label: "TREND_2H_V11",
  },
  "2h-trend-v10": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10,
    label: "TREND_2H_V10",
  },
  "2h-trend-v9": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9,
    label: "TREND_2H_V9",
  },
  "2h-trend-v8": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
    label: "TREND_2H_V8",
  },
  "2h-trend-v7": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7,
    label: "TREND_2H_V7",
  },
  "2h-trend-v6": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
    label: "TREND_2H_V6",
  },
  // Trend-2H V1-V4 (legacy)
  "2h-trend-v4": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
    label: "TREND_2H_V4",
  },
  "2h-trend-v3": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
    label: "TREND_2H_V3",
  },
  "2h-trend-v2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V2,
    label: "TREND_2H_V2",
  },
  "2h-trend": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
    label: "TREND_2H_V1",
  },
  "4h-trend": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2,
    label: "TREND_4H_V2",
  },
  // LIVE-CAP-VALIDATED (V2/V3 are current; V1 pinned via *-live-v1)
  "5m-live": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3,
    label: "LIVE_5M_V3",
  },
  "15m-live": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
    label: "LIVE_15M_V3",
  },
  "30m-live": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2,
    label: "LIVE_30M_V2",
  },
  "1h-live": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
    label: "LIVE_1H_V2",
  },
  "2h-live": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V2,
    label: "LIVE_2H_V2",
  },
  "4h-live": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V2,
    label: "LIVE_4H_V2",
  },
  "15m-live-v1": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
    label: "LIVE_15M_V1",
  },
  "30m-live-v1": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1,
    label: "LIVE_30M_V1",
  },
  "1h-live-v1": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
    label: "LIVE_1H_V1",
  },
  "2h-live-v1": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1,
    label: "LIVE_2H_V1",
  },
  "4h-live-v1": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V1,
    label: "LIVE_4H_V1",
  },
  // Phase 37 (R44-V231-1, R44-V231-3): explicit V2 + V4-engine tags so
  // FTMO_TF strings TF_DISPATCH knows about ALSO resolve in V231 — without
  // these the module-load fallback warning fired even when V4 engine
  // bypassed V231 (`useV4Engine` flag), and Telegram labels read "V261"
  // instead of the actually-running cfg.
  "15m-live-v2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
    label: "LIVE_15M_V2",
  },
  "30m-live-v2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2,
    label: "LIVE_30M_V2",
  },
  "1h-live-v2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
    label: "LIVE_1H_V2",
  },
  "2h-live-v2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V2,
    label: "LIVE_2H_V2",
  },
  "4h-live-v2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V2,
    label: "LIVE_4H_V2",
  },
  "5m-live-v2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V2,
    label: "LIVE_5M_V2",
  },
  "5m-live-v3": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3,
    label: "LIVE_5M_V3",
  },
  "15m-live-v3": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
    label: "LIVE_15M_V3",
  },
  // V4-engine tags — execution bypasses V231 via `useV4Engine` flag in
  // ftmoLiveService, but V231 module-load still evaluates the FTMO_TF
  // string, and renderDetection() reads CFG_LABEL for Telegram alerts.
  // Map them to the underlying cfg so labels render the real strategy.
  "2h-trend-v5-quartz-lite-r28-v4engine": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
    label: "V5_QUARTZ_LITE_R28_V4 (engine v4)",
  },
  "2h-trend-v5-quartz-lite-r28-v5-v4engine": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5,
    label: "V5_QUARTZ_LITE_R28_V5 (engine v4)",
  },
  "2h-trend-v5-quartz-lite-r28-v6-v4engine": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
    label: "V5_QUARTZ_LITE_R28_V6 (engine v4)",
  },
  // Round 60 candidate variants — only the validated winner gets promoted
  // to live-deploy. All inherit R28_V6 base; differ by single feature toggle.
  "2h-trend-v5-r28-v6-passlock": {
    cfg: CFGS.FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
    label: "R28_V6_PASSLOCK (closeAllOnTargetReached)",
  },
  "2h-trend-v5-r28-v6-corrcap2": {
    cfg: CFGS.FTMO_DAYTRADE_24H_R28_V6_CORRCAP2,
    label: "R28_V6_CORRCAP2 (max-2-same-dir)",
  },
  "2h-trend-v5-r28-v6-lscool48": {
    cfg: CFGS.FTMO_DAYTRADE_24H_R28_V6_LSCOOL,
    label: "R28_V6_LSCOOL48 (24h cooldown after 3 losses)",
  },
  "2h-trend-v5-r28-v6-todcutoff18": {
    cfg: CFGS.FTMO_DAYTRADE_24H_R28_V6_TODCUTOFF18,
    label: "R28_V6_TODCUTOFF18 (no entries past 18 UTC)",
  },
  "2h-trend-v5-r28-v6-voltp-aggr": {
    cfg: CFGS.FTMO_DAYTRADE_24H_R28_V6_VOLTP_AGGR,
    label: "R28_V6_VOLTP_AGGR (vol-adaptive tpMult ±30%)",
  },
  "2h-trend-v5-r28-v6-idlt30": {
    cfg: CFGS.FTMO_DAYTRADE_24H_R28_V6_IDLT_30,
    label: "R28_V6_IDLT30 (intraday-loss-throttle hard 3%)",
  },
  "2h-trend-v5-r28-v6-combo-pl-idlt": {
    cfg: CFGS.FTMO_DAYTRADE_24H_R28_V6_COMBO_PL_IDLT,
    label: "R28_V6_COMBO (passlock + idlt30)",
  },
  // Round 61 — PASSLOCK + Adaptive Day-Risk variants.
  "2h-trend-v5-r28-v6-passlock-dayrisk50": {
    cfg: CFGS.FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_DAYRISK_50,
    label: "R28_V6_PASSLOCK + day-risk 0.5×(d0-2)",
  },
  "2h-trend-v5-r28-v6-passlock-dayrisk70": {
    cfg: CFGS.FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_DAYRISK_70,
    label: "R28_V6_PASSLOCK + day-risk 0.7×(d0-2)",
  },
  "2h-trend-v5-r28-v6-passlock-dayrisk50-2d": {
    cfg: CFGS.FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_DAYRISK_50_2D,
    label: "R28_V6_PASSLOCK + day-risk 0.5×(d0-1)",
  },
  "2h-trend-breakout-v1": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1,
    label: "BREAKOUT_V1 (engine v4)",
  },
  // LEGACY no-cap (rollback only — these die at 0% under live caps)
  "15m": { cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT, label: "V16" },
  "30m-turbo": {
    cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
    label: "V12-TURBO",
  },
  "30m": { cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT, label: "V12" },
  "1h": { cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT, label: "V7" },
  "2h": { cfg: CFGS.FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT, label: "V6" },
};

// FTMO_TF env-var → trimmed key. Trailing whitespace is a common copy-paste
// foot-gun that previously fell through silently to V261 4h fallback.
const _ftmoTfRaw = process.env.FTMO_TF;
if (_ftmoTfRaw && _ftmoTfRaw.trim() !== _ftmoTfRaw) {
  console.error(
    `[ftmo-live] WARNING: FTMO_TF="${_ftmoTfRaw}" has trailing whitespace — strip it!`,
  );
}
const _ftmoTfKey = _ftmoTfRaw?.trim() ?? "";
const _registryHit =
  _ftmoTfKey in CFG_REGISTRY ? CFG_REGISTRY[_ftmoTfKey] : null;
// Round 54 Fix #3 + #7: when env was SET but didn't match any registry key
// (typo, trim mismatch, removed config), THROW at module load instead of
// silently falling back to V261 4h. Operators easily miss console.error
// in PM2/systemd logs — fail-loud is the correct default when the operator
// asked for something specific and we can't deliver it.
//
// Test/CI escape hatch: set FTMO_TF_ALLOW_FALLBACK=1 to opt back into the
// silent V261 fallback (used by test harnesses that import V231 without
// caring about CFG selection).
if (_ftmoTfKey && !_registryHit && process.env.FTMO_TF_ALLOW_FALLBACK !== "1") {
  throw new Error(
    `[ftmo-live] FTMO_TF="${_ftmoTfRaw}" did not match any known config in CFG_REGISTRY. ` +
      `Check spelling / trailing whitespace. Set FTMO_TF_ALLOW_FALLBACK=1 to fall back to V261 (test only).`,
  );
}
if (_ftmoTfKey && !_registryHit) {
  console.error(
    `[ftmo-live] WARNING: FTMO_TF="${_ftmoTfRaw}" did not match any known config — falling back to V261 4h (FTMO_TF_ALLOW_FALLBACK=1).`,
  );
}

// CFG = active config; CFG_LABEL = human-readable label for logs/Telegram.
// Default fallback: V261 4h (no-cap 94.31% pass on 5y backtest, but DIES
// under live caps — only used when FTMO_TF is unset, e.g. test harness).
const CFG: FtmoDaytrade24hConfig =
  _registryHit?.cfg ?? CFGS.FTMO_DAYTRADE_24H_CONFIG_V261;
const CFG_LABEL: string = _registryHit?.label ?? "V261";

/**
 * Round 54 Fix #3: lightweight introspection helper for the live-service
 * boot banner. Lets ftmoLiveService.ts cross-check at startup that the CFG
 * V231 resolved matches FTMO_TF (trim-mismatch detection at boot).
 */
export function getActiveCfgInfo(): { label: string; ftmoTfKey: string } {
  return { label: CFG_LABEL, ftmoTfKey: _ftmoTfKey };
}

export function getActiveCfg(): FtmoDaytrade24hConfig {
  return CFG;
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

  // Round 35: peakDrawdownThrottle — scale risk DOWN when equity drops
  // `fromPeak` below all-time challenge peak. Mirrors engine line 4983-4988.
  // Required for R28_V2/V3/V4 to deliver backtest pass-rate in live (without
  // this, peakDrawdownThrottle is ignored and live falls back to R28 71%).
  if (CFG.peakDrawdownThrottle) {
    // Bug-Audit Phase 2 (V231 Bug 4): challengePeak missing → fail-loud.
    // Previously fell back silently to current equity (= no throttle ever),
    // which silently degraded R28_V2/V3/V4 to R28 baseline if Python's
    // challenge-peak.json was missing/outdated. console.error makes the
    // operator notice; behavior preserved (no throttle when peak unknown).
    const peakKnown =
      account.challengePeak !== undefined && account.challengePeak > 0;
    // Phase 33 (Audit Bug 8): warn-once is per-incident, not lifetime.
    // Reset the flag whenever peak is known, so a Python recovery → later
    // re-failure produces a fresh alert.
    if (peakKnown) {
      peakWarnedOnce = false;
    } else if (!peakWarnedOnce) {
      peakWarnedOnce = true;
      console.error(
        "[V231] peakDrawdownThrottle CONFIGURED but account.challengePeak " +
          "is missing — silent under-performance vs backtest. Check Python " +
          "ftmo_executor.py challenge-peak.json sync. (warning suppressed until challengePeak is restored)",
      );
    }
    const peak = peakKnown ? account.challengePeak! : account.equity;
    if (peak > 0) {
      // Round 54 Fix #4: clamp fromPeak ≥ 0. Python writes challenge-peak.json
      // and account.json independently — a torn read where peak < equity
      // would otherwise yield negative fromPeak → downstream NaN / no-throttle
      // by accident. Equity-above-peak is meaningless for drawdown anyway.
      const fromPeak = Math.max(0, (peak - account.equity) / peak);
      if (fromPeak >= CFG.peakDrawdownThrottle.fromPeak) {
        const pDDFactor = CFG.peakDrawdownThrottle.factor;
        if (pDDFactor < factor) {
          factor = pDDFactor;
          notes.push(
            `peakDrawdownThrottle: equity ${(fromPeak * 100).toFixed(2)}% below peak (peak=${((peak - 1) * 100).toFixed(2)}%) → factor=${factor.toFixed(3)}`,
          );
        }
      } else if (peakKnown) {
        notes.push(
          `peakDrawdownThrottle: equity ${(fromPeak * 100).toFixed(2)}% below peak (threshold ${(CFG.peakDrawdownThrottle.fromPeak * 100).toFixed(2)}%) — no throttle`,
        );
      } else {
        notes.push(
          `peakDrawdownThrottle: account.challengePeak missing (Python sync outdated?) — no throttle (logged to console.error)`,
        );
      }
    }
  }

  // Phase 88 (R51-FTMO-5): hard-cap factor at 4× to mirror the backtest
  // engine's `MAX_FACTOR = 4` (Phase B3 in main engine, Phase 35 in V4).
  // Without it, a future cfg with timeBoost.factor=3 + kellySizing
  // maxMult=2 would deliver 6× live while the backtest reported 4×.
  const MAX_FACTOR = 4;
  if (factor > MAX_FACTOR) {
    notes.push(
      `factor cap: ${factor.toFixed(3)} → ${MAX_FACTOR} (MAX_FACTOR safety)`,
    );
    factor = MAX_FACTOR;
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
  // Phase 30 (V231 Audit Bug 8): runtime guard for deprecated configs.
  // V5_TITAN / V5_LEGEND have volTargeting maxMult=5 → single stop can
  // blow FTMO -5% DL. Block at runtime here instead of module-load throw
  // so test imports don't crash.
  if (
    _ftmoTfKey === "2h-trend-v5-titan" ||
    _ftmoTfKey === "2h-trend-v5-legend"
  ) {
    return {
      timestamp: Date.now(),
      regime: "BEAR_CHOP",
      activeBotConfig: "DEPRECATED",
      signals: [],
      skipped: [],
      notes: [
        `FTMO_TF=${process.env.FTMO_TF} is DEPRECATED (volTargeting maxMult=5 unsafe). Use V5_TITAN_REAL instead.`,
      ],
      account,
      btc: { close: 0, ema10: 0, ema15: 0, uptrend: false, mom24h: 0 },
    };
  }
  // Round 54 Fix #5: when peakDrawdownThrottle is CONFIGURED but
  // account.challengePeak is missing (cold start, Python not yet written),
  // REJECT signal generation entirely. Previously code fell back to
  // peak=equity → fromPeak=0 → throttle silently disabled. peakWarnedOnce
  // suppressed every subsequent warning, so the operator got ZERO notice
  // that R28_V2/V3/V4 were running un-throttled (= base R28 ~71%, not the
  // configured boost). Fail-loud: no trades until Python sync recovers.
  if (
    CFG.peakDrawdownThrottle &&
    (account.challengePeak === undefined || account.challengePeak <= 0)
  ) {
    return {
      timestamp: Date.now(),
      regime: "BEAR_CHOP",
      activeBotConfig: `${CFG_LABEL} (BLOCKED)`,
      signals: [],
      skipped: [],
      notes: [
        `peakDrawdownThrottle CONFIGURED but account.challengePeak missing — ` +
          `no trades emitted. Check Python ftmo_executor.py challenge-peak.json sync.`,
      ],
      account,
      btc: { close: 0, ema10: 0, ema15: 0, uptrend: false, mom24h: 0 },
    };
  }
  // BUGFIX 2026-04-28: filter out non-final (still-forming) candles before
  // detection. Binance returns the current incomplete bar at index [-1] when
  // polling close to bar boundary → would create phantom signals on partial
  // data that re-trigger on bar close.
  btcCandles = btcCandles.filter((c) => c.isFinal !== false);
  ethCandles = ethCandles.filter((c) => c.isFinal !== false);
  // Bug-Audit Phase 2: solCandles was missing the same filter — SOL-MR
  // signals could re-fire on partial bars. SOL is referenced via
  // candlesForSrc.SOLUSDT for V261/V12 configs.
  solCandles = solCandles.filter((c) => c.isFinal !== false);
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
  const btcClose = btcCandles[lastIdx]!.close;
  const btcEma10 = btcEmaFastArr[lastIdx] ?? btcClose; // kept name for backwards-compat
  const btcEma15 = btcEmaSlowArr[lastIdx] ?? btcClose;
  const btcMom24h =
    lastIdx >= momBars
      ? (btcClose - btcCandles[lastIdx - momBars]!.close) /
        btcCandles[lastIdx - momBars]!.close
      : 0;
  const btcUptrend = btcClose > btcEma10 && btcEma10 > btcEma15;
  const btcBullMom = btcMom24h > momThr;
  const regime: Regime = btcUptrend && btcBullMom ? "BULL" : "BEAR_CHOP";

  const tfLabel = _ftmoTfKey || "4h";
  const cfgLabel = CFG_LABEL;
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

  // Phase 33: derive active CFG tfHours BEFORE BULL-detector dispatch
  // (was after — causing TS2454 use-before-declaration when we want to
  // pass it down).
  const _cfgTfMsForBull =
    CFG.timeframe === "5m"
      ? 5 * 60_000
      : CFG.timeframe === "15m"
        ? 15 * 60_000
        : CFG.timeframe === "30m"
          ? 30 * 60_000
          : CFG.timeframe === "1h"
            ? 60 * 60_000
            : CFG.timeframe === "2h"
              ? 2 * 60 * 60_000
              : CFG.timeframe === "4h"
                ? 4 * 60 * 60_000
                : 4 * 60 * 60_000;

  // In BULL regime we delegate to BULL-bot logic (see below).
  if (regime === "BULL") {
    // Phase 33 (Audit Bug 3): pass active config tfHours so BULL detector
    // matches the candle cadence. Was using BULL.timeframe constant (4h).
    return detectBullSignals(
      ethCandles,
      btcCandles,
      account,
      newsEvents,
      result,
      _cfgTfMsForBull / 3600_000,
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
  // Bug-Audit Phase 2 — CRITICAL FIX (V231 Bug 2):
  // Drive tfHours from CFG.timeframe directly instead of guessing via FTMO_TF
  // env-var ternary. Previously most V5_TITANIUM-derived configs (PLATINUM_30M,
  // OBSIDIAN, ZIRKON, AMBER, QUARTZ, QUARTZ_LITE, QUARTZ_LITE_R28*, TOPAZ,
  // RUBIN, SAPPHIR, EMERALD, PEARL, OPAL, AGATE, JADE, ONYX, QUARTZ_STEP2)
  // were stamped IS_2H_FAMILY → tfHours=2 even though they're 30m configs.
  // Result: entryOpenTime, entryHour, maxHoldHours, barDurationMs all 4×
  // wrong for these production champions, contributing to the 0%
  // entry-agreement live-vs-backtest. Source-of-truth is CFG.timeframe.
  const cfgTfMs =
    CFG.timeframe === "5m"
      ? 5 * 60_000
      : CFG.timeframe === "15m"
        ? 15 * 60_000
        : CFG.timeframe === "30m"
          ? 30 * 60_000
          : CFG.timeframe === "1h"
            ? 60 * 60_000
            : CFG.timeframe === "2h"
              ? 2 * 60 * 60_000
              : CFG.timeframe === "4h"
                ? 4 * 60 * 60_000
                : 4 * 60 * 60_000; // unknown → 4h default (matches prior behavior)
  const tfHours = cfgTfMs / 3600_000;
  const ethLastIdx = ethCandles.length - 1;
  const b1 = ethCandles[ethLastIdx];
  const entryOpenTime = b1!.openTime + tfHours * 3600_000;
  const entryHour = new Date(entryOpenTime).getUTCHours();
  // Default allowed hours by bar-cadence (overridable via CFG.allowedHoursUtc).
  // Sub-2h timeframes get all 24 hours; 2h gets every-other-hour; 4h gets the
  // standard quarterly schedule. Drive from cfgTfMs not env-var flags so 30m
  // configs misnamed as "2h-trend-*" get the correct 24h cadence.
  const defaultHours =
    cfgTfMs <= 60 * 60_000
      ? Array.from({ length: 24 }, (_, i) => i)
      : cfgTfMs === 2 * 60 * 60_000
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
  const newsBlocked = isNewsBlackout(
    entryOpenTime,
    newsEvents,
    NEWS_BLACKOUT_MINUTES,
  );
  if (newsBlocked) {
    result.notes.push(
      `News blackout: within ${NEWS_BLACKOUT_MINUTES}min of high-impact event`,
    );
  }

  // HTF trend filter — moved to per-asset/per-direction check below.
  // BUGFIX 2026-04-29: was a global block on ETH-only candles which blocked
  // V5 longs even though engine only blocks shorts (apply: "short"). Engine
  // applies HTF per-asset's own candles + per-direction. Logic relocated to
  // the asset loop where direction & candles are known.

  // Loss-streak cooldown: pause entries after N consecutive losers.
  // Reads from account.recentPnls (most recent last). Engine matches.
  // Phase 30 (V231 Audit Bug 4 — CRITICAL FIX): the Phase-8 `pnl <= 0` test
  // counted breakEven exits as losses. V5_QUARTZ family / R28 use
  // breakEven{threshold: 0.03} which produces tons of ~0% to -0.05% trades
  // → after 2-3 BE exits, LSC fired permanently → bot stops trading from
  // week 1. New threshold: -10bp absolute (-0.001) — clearly a stop-out,
  // not a breakeven. Works across all riskFrac magnitudes (V5_QUARTZ
  // riskFrac=0.005 stop = -0.5% → counts; BE = -0.05% → does NOT count).
  let lscBlocked = false;
  if (CFG.lossStreakCooldown) {
    const { afterLosses, cooldownBars } = CFG.lossStreakCooldown;
    const STOP_LIKE_THRESHOLD = -0.001;
    let streak = 0;
    for (let i = account.recentPnls.length - 1; i >= 0; i--) {
      if (account.recentPnls[i]! <= STOP_LIKE_THRESHOLD) streak++;
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
  const sharedBlock = hourBlocked || newsBlocked || lscBlocked;

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

    // BUGFIX 2026-04-29: per-asset/per-direction HTF filter — mirrors engine
    // (ftmoDaytrade24h.ts:3613-3628). Uses ASSET'S OWN candles, not ETH only.
    // Engine: short && gateShorts && change > thr → skip.
    //         long  && gateLongs  && change < -thr → skip.
    if (CFG.htfTrendFilter) {
      const lb = CFG.htfTrendFilter.lookbackBars;
      const thr = CFG.htfTrendFilter.threshold ?? 0;
      if (a.candles.length > lb) {
        const last = a.candles[a.candles.length - 1]!.close;
        const back = a.candles[a.candles.length - 1 - lb]!.close;
        const change = (last - back) / back;
        const gateLongs =
          CFG.htfTrendFilter.apply === "long" ||
          CFG.htfTrendFilter.apply === "both";
        const gateShorts =
          CFG.htfTrendFilter.apply === "short" ||
          CFG.htfTrendFilter.apply === "both";
        if (direction === "short" && gateShorts && change > thr) {
          result.skipped.push({
            asset: a.asset,
            reason: `HTF: ${a.source} +${(change * 100).toFixed(2)}% over ${lb} bars (>${(thr * 100).toFixed(2)}%) blocks short`,
          });
          continue;
        }
        if (direction === "long" && gateLongs && change < -thr) {
          result.skipped.push({
            asset: a.asset,
            reason: `HTF: ${a.source} ${(change * 100).toFixed(2)}% over ${lb} bars (<-${(thr * 100).toFixed(2)}%) blocks long`,
          });
          continue;
        }
      }
    }
    // Per-asset HTF AUX filter (second confluence window).
    if (CFG.htfTrendFilterAux) {
      const lb = CFG.htfTrendFilterAux.lookbackBars;
      const thr = CFG.htfTrendFilterAux.threshold ?? 0;
      if (a.candles.length > lb) {
        const last = a.candles[a.candles.length - 1]!.close;
        const back = a.candles[a.candles.length - 1 - lb]!.close;
        const change = (last - back) / back;
        const gateLongs =
          CFG.htfTrendFilterAux.apply === "long" ||
          CFG.htfTrendFilterAux.apply === "both";
        const gateShorts =
          CFG.htfTrendFilterAux.apply === "short" ||
          CFG.htfTrendFilterAux.apply === "both";
        if (direction === "short" && gateShorts && change > thr) {
          result.skipped.push({
            asset: a.asset,
            reason: `HTF-Aux: ${a.source} +${(change * 100).toFixed(2)}% over ${lb}b blocks short`,
          });
          continue;
        }
        if (direction === "long" && gateLongs && change < -thr) {
          result.skipped.push({
            asset: a.asset,
            reason: `HTF-Aux: ${a.source} ${(change * 100).toFixed(2)}% over ${lb}b blocks long`,
          });
          continue;
        }
      }
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
    const entryPrice = last!.close;
    const baseStopPct = a.stopPctOverride ?? CFG.stopPct;
    let stopPct = baseStopPct;
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
    // BUGFIX 2026-04-29 (Agent 3 R10 CRITICAL): unit mismatch fix.
    // Engine's `asset.riskFrac` is POSITION-fraction (loss = riskFrac × stopPct × leverage).
    // Live's `LIVE_MAX_RISK_FRAC=0.04` is direct equity-LOSS fraction (4% max loss).
    // The Python executor `compute_lot_size` interprets `risk_frac` as direct loss-fraction.
    // Previous code: `min(a.baseRisk, 0.04)` over-sized for assets with riskFrac<0.4 (e.g.
    // BTC-PYR riskFrac=0.15 → engine loss 1.5%, live loss 4% = 2.7× engine).
    // Fix: convert engine's position-fraction to loss-fraction BEFORE capping.
    const enginePositionFrac = a.baseRisk * factor;
    const equityLossFrac = enginePositionFrac * stopPct * CFG.leverage;
    const rawRiskFrac = equityLossFrac;
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
      signalBarClose: last!.closeTime,
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
              // Engine uses BASE stopPct for minMoveR gating (ftmoDaytrade24h.ts:3945).
              // ATR-inflated stopPct would never arm chandelier in V10/V11/V12 configs.
              stopPct: baseStopPct,
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
  // Phase 33 (Audit Bug 3): callsite passes active CFG.timeframe-derived
  // tfHours. Phase 30 had used BULL.timeframe (a 4h constant) which made
  // BULL regime emit signals with 8× wrong hold/entry on 30m-active configs
  // — same R72-class bug Phase 2 fixed in the main detector.
  tfHours: number,
): DetectionResult {
  const BULL = CFGS.FTMO_DAYTRADE_24H_CONFIG_BULL;
  const { factor, notes: sizingNotes } = computeSizingFactor(account);
  result.notes.push(...sizingNotes);

  const ethLastIdx = ethCandles.length - 1;
  const b0 = ethCandles[ethLastIdx - 1];
  const b1 = ethCandles[ethLastIdx];
  const last2Green =
    b1!.close > b0!.close &&
    b0!.close > (ethCandles[ethLastIdx - 2]?.close ?? Infinity);
  if (!last2Green) {
    result.notes.push("No 2-green sequence → no BULL signal");
    return result;
  }

  const entryOpenTime = b1!.openTime + tfHours * 3600_000;
  if (isNewsBlackout(entryOpenTime, newsEvents, NEWS_BLACKOUT_MINUTES)) {
    result.notes.push("News blackout");
    return result;
  }

  const tpPct = BULL.tpPct;
  const stopPct = BULL.stopPct;
  const entryPrice = b1!.close;
  const stopPrice = entryPrice * (1 - stopPct); // long: stop below
  const tpPrice = entryPrice * (1 + tpPct); // long: TP above
  const maxHoldHours = (BULL.holdBars + 1) * tfHours; // bugfix 2026-04-28: backtest parity
  const baseAsset = BULL.assets[0];
  // Live risk = baseRisk × factor, capped at LIVE_MAX_RISK_FRAC (no leverage multiplier).
  const rawRiskFrac = baseAsset!.riskFrac * factor;
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
    signalBarClose: b1!.closeTime,
    reasons: [
      "BULL regime: 2-green momentum continuation",
      `sizing: baseRisk=${baseAsset!.riskFrac} × factor=${factor.toFixed(3)} = ${rawRiskFrac.toFixed(4)} → live cap ${effectiveRiskFrac.toFixed(4)}`,
    ],
  });

  // Bull pyramid (ETH-BULL-PYRAMID) when equity ahead by 1.5%+
  if (account.equity - 1 >= 0.015) {
    const pyr = BULL.assets[1];
    const pyrRawRisk = pyr!.riskFrac * factor;
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
      signalBarClose: b1!.closeTime,
      reasons: [
        "BULL pyramid fires at +1.5% equity",
        `sizing: baseRisk=${pyr!.riskFrac} × factor=${factor.toFixed(3)} = ${pyrRawRisk.toFixed(4)} → live cap ${pyrEffRisk.toFixed(4)}`,
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
  const tfLabel = _ftmoTfKey || "4h";
  const cfgLabel = CFG_LABEL;
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
