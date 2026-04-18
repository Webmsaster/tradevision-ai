/**
 * Live signal generator for the verified intraday edges.
 *
 * Unlike the backtester, this module answers the practical question:
 * "right now, at THIS minute, is there a tradeable signal?" — and if so,
 * what's the direction, entry, target, stop, and hold time.
 *
 * Signals produced:
 *   - Champion: trend-filtered hour-of-day (long-only)
 *   - Monday-Reversal: post-weekend-drop long
 *   - Upcoming: the next 24h of Champion entry windows
 *
 * Retraining: every call re-computes hour stats from the most recent
 * `trainBars` bars. This is the core honesty principle — the strategy
 * ADAPTS instead of using frozen parameters.
 */

import type { Candle } from "@/utils/indicators";
import { sma } from "@/utils/indicators";
import { loadBinanceHistory } from "@/utils/historicalData";
import { computeHourStats } from "@/utils/hourOfDayStrategy";
import { runWalkForwardHourOfDay } from "@/utils/walkForward";
import { MAKER_COSTS } from "@/utils/intradayLab";
import {
  checkStrategyHealth,
  type StrategyHealthReport,
} from "@/utils/strategyHealth";
import { classifyVolRegime, type VolRegimeBar } from "@/utils/volRegimeFilter";
import {
  fetchCoinbasePremium,
  type PremiumSnapshot,
} from "@/utils/coinbasePremium";

export interface ChampionSignal {
  symbol: string;
  hourUtc: number;
  nowUtc: string;
  aboveSma: boolean;
  sma50Price: number | null;
  currentPrice: number;
  longHours: number[];
  shortHours: number[];
  action: "long" | "short" | "flat";
  reason: string;
  entryPrice: number;
  targetPrice: number | null;
  stopPrice: number | null;
  holdUntilUtc: string;
  confidence: "high" | "medium" | "low";
  /** Expected edge per trade AFTER realistic costs (3 bps adverse selection). */
  expectedEdgeBps: number;
  /** Warning flag for funding-hour or low-confidence signals. */
  warnings: string[];
}

export interface MondaySignal {
  symbol: string;
  fired: boolean;
  weekendReturnPct: number | null;
  entryPrice: number | null;
  stopPrice: number | null;
  exitTimeUtc: string | null;
  reason: string;
  now: string;
  nextCheckUtc: string;
}

export interface UpcomingWindow {
  symbol: string;
  startTime: string; // ISO UTC
  hourUtc: number;
  direction: "long" | "short";
  conditional: string; // the regime condition that must still hold
}

export interface StrategyHealthSnapshot {
  symbol: string;
  strategy: string;
  lifetimeSharpe: number;
  recentSharpe: number;
  ratio: number;
  status: "healthy" | "watch" | "pause";
  reason: string;
}

export interface VolRegimeSnapshot {
  symbol: string;
  realizedVol: number;
  percentile: number | null;
  inRegime: boolean;
  verdict: string;
}

export interface LiveSignalsReport {
  generatedAt: string;
  champion: ChampionSignal[];
  monday: MondaySignal[];
  upcoming: UpcomingWindow[];
  health: StrategyHealthSnapshot[];
  volRegime: VolRegimeSnapshot[];
  coinbasePremium?: PremiumSnapshot;
}

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;

// ---------------------------------------------------------------------------
// Champion: trend-filtered hour-of-day (long-only in uptrend).
// ---------------------------------------------------------------------------
function computeChampionForSymbol(
  symbol: string,
  candles: Candle[],
  topK = 3, // grid-search best: topK=2-3 dominates topK=5
  bottomK = 3,
  smaPeriodBars = 24, // grid-search best: 24h dominates 50h/200h
): ChampionSignal {
  if (candles.length < smaPeriodBars + 100) {
    return {
      symbol,
      hourUtc: 0,
      nowUtc: new Date().toISOString(),
      aboveSma: false,
      sma50Price: null,
      currentPrice: 0,
      longHours: [],
      shortHours: [],
      action: "flat",
      reason: "insufficient history",
      entryPrice: 0,
      targetPrice: null,
      stopPrice: null,
      holdUntilUtc: "",
      confidence: "low",
      expectedEdgeBps: 0,
      warnings: ["insufficient history"],
    };
  }
  // Retrain hour patterns on the ENTIRE candle window (most recent data first
  // principle — we don't hold out; this is live-deployment mode).
  const stats = computeHourStats(candles);
  const sorted = [...stats].sort((a, b) => b.meanReturnPct - a.meanReturnPct);
  const longHours = sorted.slice(0, topK).map((s) => s.hourUtc);
  const shortHours = sorted.slice(-bottomK).map((s) => s.hourUtc);

  const closes = candles.map((c) => c.close);
  const smaArr = sma(closes, smaPeriodBars);
  const last = candles[candles.length - 1];
  const smaNow = smaArr[smaArr.length - 1];
  const aboveSma = smaNow !== null && last.close > smaNow;
  const now = new Date();
  const hour = now.getUTCHours();

  const inLong = longHours.includes(hour);
  const inShort = shortHours.includes(hour);
  const isFundingHour = hour === 0 || hour === 8 || hour === 16;

  let action: "long" | "short" | "flat" = "flat";
  let reason = "";
  let confidence: "high" | "medium" | "low" = "low";
  const warnings: string[] = [];

  const strongAboveSma = smaNow !== null && last.close > smaNow * 1.005;

  if (inLong && aboveSma) {
    action = "long";
    reason = `Hour ${hour} UTC is a top-${topK} bullish hour AND price > ${smaPeriodBars}h-SMA → long regime`;
    confidence = strongAboveSma ? "high" : "medium";
  } else if (inShort && !aboveSma) {
    action = "short";
    reason = `Hour ${hour} UTC is a bottom-${bottomK} bearish hour AND price < ${smaPeriodBars}h-SMA → short regime`;
    confidence = "medium";
    warnings.push("short signals less robust than long — consider long-only");
  } else if (inLong && !aboveSma) {
    reason = `Hour ${hour} UTC is bullish but price below ${smaPeriodBars}h-SMA → regime mismatch, skip`;
  } else if (inShort && aboveSma) {
    reason = `Hour ${hour} UTC is bearish but uptrend regime → skip`;
  } else {
    reason = `Hour ${hour} UTC is not in significant long/short list`;
  }

  if (action !== "flat" && isFundingHour) {
    warnings.push(
      `Funding-settle hour (${hour}:00 UTC) — wider spreads + adverse-flow risk. Consider skipping.`,
    );
    confidence = "low";
  }

  // Plan: entry at current price, 1h hold, target = current + expected hour-mean, stop 0.5%
  const hourStat = stats.find((s) => s.hourUtc === hour);
  const expectedMove = hourStat ? hourStat.meanReturnPct : 0;
  const entryPrice = last.close;
  let targetPrice: number | null = null;
  let stopPrice: number | null = null;
  // Expected edge in bps after realistic costs: hour-mean × 10000 minus
  //   maker-round-trip (4 bps) + adverse-selection (3 bps) = 7 bps
  const expectedEdgeBps = expectedMove * 10000 - 7;
  if (action === "long") {
    targetPrice = entryPrice * (1 + Math.max(0.002, expectedMove * 2));
    stopPrice = entryPrice * (1 - 0.005);
  } else if (action === "short") {
    targetPrice = entryPrice * (1 + Math.min(-0.002, expectedMove * 2));
    stopPrice = entryPrice * (1 + 0.005);
  }
  if (action !== "flat" && expectedEdgeBps < 3) {
    warnings.push(
      `Expected net edge only ${expectedEdgeBps.toFixed(1)} bps — thin after realistic costs`,
    );
  }
  const holdUntil = new Date(now);
  holdUntil.setUTCHours(holdUntil.getUTCHours() + 1, 0, 0, 0);

  return {
    symbol,
    hourUtc: hour,
    nowUtc: now.toISOString(),
    aboveSma,
    sma50Price: smaNow,
    currentPrice: last.close,
    longHours,
    shortHours,
    action,
    reason,
    entryPrice,
    targetPrice,
    stopPrice,
    holdUntilUtc: holdUntil.toISOString(),
    confidence,
    expectedEdgeBps,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Monday-Reversal live checker
// ---------------------------------------------------------------------------
function computeMondaySignal(symbol: string, candles: Candle[]): MondaySignal {
  const now = new Date();
  const dow = now.getUTCDay(); // 0=Sun .. 6=Sat
  const hour = now.getUTCHours();

  // Signal window: Monday 00:00 UTC to 12:00 UTC (the holding window)
  const isMondayEntry = dow === 1 && hour === 0;
  const isMondayInHold = dow === 1 && hour < 12;
  const isSundayEvening = dow === 0 && hour >= 22;

  if (!isMondayEntry && !isMondayInHold && !isSundayEvening) {
    // Compute next Monday 00 UTC
    const next = new Date(now);
    const daysUntilMon = (1 - dow + 7) % 7 || 7;
    next.setUTCDate(next.getUTCDate() + daysUntilMon);
    next.setUTCHours(0, 0, 0, 0);
    return {
      symbol,
      fired: false,
      weekendReturnPct: null,
      entryPrice: null,
      stopPrice: null,
      exitTimeUtc: null,
      reason: `Next check: Monday 00:00 UTC (${next.toISOString()})`,
      now: now.toISOString(),
      nextCheckUtc: next.toISOString(),
    };
  }

  // We're in-signal-window. Find Fri 00 UTC bar and most recent Sun 23 UTC bar.
  const friIdx = candles
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => {
      const d = new Date(c.openTime);
      return d.getUTCDay() === 5 && d.getUTCHours() === 0;
    })
    .slice(-1)[0];
  if (!friIdx) {
    return {
      symbol,
      fired: false,
      weekendReturnPct: null,
      entryPrice: null,
      stopPrice: null,
      exitTimeUtc: null,
      reason: "No recent Friday 00 UTC bar found in history",
      now: now.toISOString(),
      nextCheckUtc: now.toISOString(),
    };
  }
  const sun23Idx = candles
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => {
      const d = new Date(c.openTime);
      return d.getUTCDay() === 0 && d.getUTCHours() === 23 && i > friIdx.i;
    })
    .slice(-1)[0];
  if (!sun23Idx) {
    return {
      symbol,
      fired: false,
      weekendReturnPct: null,
      entryPrice: null,
      stopPrice: null,
      exitTimeUtc: null,
      reason: "Weekend not yet complete — no Sun 23:00 UTC bar",
      now: now.toISOString(),
      nextCheckUtc: now.toISOString(),
    };
  }
  const weekendReturn = (sun23Idx.c.close - friIdx.c.open) / friIdx.c.open;
  const fired = weekendReturn < -0.03;

  if (!fired) {
    return {
      symbol,
      fired: false,
      weekendReturnPct: weekendReturn,
      entryPrice: null,
      stopPrice: null,
      exitTimeUtc: null,
      reason: `Weekend return ${(weekendReturn * 100).toFixed(2)}% — not enough drop (need < -3.00%)`,
      now: now.toISOString(),
      nextCheckUtc: now.toISOString(),
    };
  }
  const last = candles[candles.length - 1];
  const entry = last.close;
  const stop = entry * 0.98;
  const exitAt = new Date(now);
  if (isMondayEntry) {
    exitAt.setUTCHours(12, 0, 0, 0);
  } else if (isMondayInHold) {
    exitAt.setUTCHours(12, 0, 0, 0);
  } else {
    exitAt.setUTCDate(exitAt.getUTCDate() + 1);
    exitAt.setUTCHours(12, 0, 0, 0);
  }
  return {
    symbol,
    fired: true,
    weekendReturnPct: weekendReturn,
    entryPrice: entry,
    stopPrice: stop,
    exitTimeUtc: exitAt.toISOString(),
    reason: `Weekend drop ${(weekendReturn * 100).toFixed(2)}% — Monday-Reversal fires. Long ${symbol} at market, 2% stop, exit ${exitAt.toISOString()}.`,
    now: now.toISOString(),
    nextCheckUtc: exitAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Upcoming windows (next 24h)
// ---------------------------------------------------------------------------
function computeUpcoming(
  champions: ChampionSignal[],
  hoursAhead = 24,
): UpcomingWindow[] {
  const out: UpcomingWindow[] = [];
  const now = new Date();
  for (const c of champions) {
    for (let h = 1; h <= hoursAhead; h++) {
      const at = new Date(now);
      at.setUTCHours(at.getUTCHours() + h, 0, 0, 0);
      const hour = at.getUTCHours();
      const isLong = c.longHours.includes(hour);
      const isShort = c.shortHours.includes(hour);
      if (!isLong && !isShort) continue;
      out.push({
        symbol: c.symbol,
        startTime: at.toISOString(),
        hourUtc: hour,
        direction: isLong ? "long" : "short",
        conditional: isLong
          ? "requires price > 50h-SMA at entry"
          : "requires price < 50h-SMA at entry",
      });
    }
  }
  return out.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export async function computeLiveSignals(
  symbols: readonly string[] = SYMBOLS,
): Promise<LiveSignalsReport> {
  const champions: ChampionSignal[] = [];
  const mondays: MondaySignal[] = [];
  const health: StrategyHealthSnapshot[] = [];
  const volRegime: VolRegimeSnapshot[] = [];

  for (const sym of symbols) {
    const candles = await loadBinanceHistory({
      symbol: sym,
      timeframe: "1h",
      targetCount: 8760, // ~12 months on 1h bars — always fresh training window
    });
    champions.push(computeChampionForSymbol(sym, candles));
    mondays.push(computeMondaySignal(sym, candles));

    // Strategy health: run a walk-forward on the last ~6 months to get a
    // recent return stream, then compare to lifetime.
    if (candles.length >= 4000) {
      try {
        const wf = runWalkForwardHourOfDay(candles, {
          trainBars: 2160,
          testBars: 168,
          topK: 3,
          bottomK: 3,
          smaPeriodBars: 24,
          longOnly: true,
          costs: MAKER_COSTS,
          makerFillRate: 0.6,
          adverseSelectionBps: 3,
          skipFundingHours: true,
          requireSignificance: false,
        });
        if (wf.allTrades.length > 30) {
          const h = checkStrategyHealth(
            {
              strategyName: `Champion-${sym}`,
              allReturns: wf.allTrades.map((t) => t.netPnlPct),
              recentWindow: 30,
            },
            250,
          );
          health.push({
            symbol: sym,
            strategy: "Champion",
            lifetimeSharpe: h.lifetimeSharpe,
            recentSharpe: h.recentSharpe,
            ratio: h.ratio,
            status: h.status,
            reason: h.reason,
          });
        }
      } catch {
        // ignore
      }
    }

    // Vol regime: current position in 30-70 percentile band
    try {
      const vr = classifyVolRegime(candles);
      const last: VolRegimeBar | undefined = vr[vr.length - 1];
      if (last) {
        volRegime.push({
          symbol: sym,
          realizedVol: last.realizedVol,
          percentile: last.percentile,
          inRegime: last.inRegime,
          verdict: last.inRegime
            ? "In productive vol band (30-70 percentile) — trade signals normally"
            : last.percentile !== null && last.percentile < 0.3
              ? "Low vol — noise regime, skip signals"
              : last.percentile !== null && last.percentile > 0.7
                ? "High vol — regime-break territory, skip signals"
                : "Vol percentile unknown",
        });
      }
    } catch {
      // ignore
    }
  }

  const upcoming = computeUpcoming(champions, 24);
  let coinbasePremium: PremiumSnapshot | undefined;
  try {
    coinbasePremium = await fetchCoinbasePremium();
  } catch {
    // ignore — US/Coinbase access may be rate-limited or blocked
  }
  return {
    generatedAt: new Date().toISOString(),
    champion: champions,
    monday: mondays,
    upcoming,
    health,
    volRegime,
    coinbasePremium,
  };
}
