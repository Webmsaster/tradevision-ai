/**
 * Round 38 — V4 Live Simulator + peakDrawdownThrottle (echtes Live-Proxy).
 *
 * V4 sim simuliert bar-by-bar mit persistent state (allTimePeak, dayPeak,
 * openPositions, MTM equity). Closer zu Live-Bot als die Engine-Backtest.
 *
 * Adds pDD logic mirroring engine line 4983-4988: scale risk down when
 * MTM-equity is `fromPeak` below all-time peak.
 *
 * Vergleich:
 *   - Engine backtest (sequential closure peak): 83.31% on R28_V4
 *   - V4 sim (bar-by-bar MTM peak): ??? — DAS ist der Live-Proxy.
 *
 * If V4 sim shows ≥75% on R28_V4 → Live deploy at R28_V4 makes sense.
 * If V4 sim shows ≤65% → backtest is overinflated, fall back to R28.
 */
import { describe, it, expect } from "vitest";
import {
  detectAsset,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { atr } from "../src/utils/indicators";
import type { Candle } from "../src/utils/indicators";

interface OpenPosition {
  symbol: string;
  sourceSymbol: string;
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  tpPrice: number;
  effRisk: number;
  highWatermark: number;
  beActive: boolean;
  ptpTriggered: boolean;
  ptpRealizedPct: number;
}

interface LiveState {
  equity: number; // realized + unrealized MTM
  realizedEquity: number; // realized only (closed trades)
  day: number;
  dayStart: number;
  dayPeak: number;
  challengePeak: number; // ALL-TIME peak of MTM equity (for pDD)
  openPositions: OpenPosition[];
  pausedAtTarget: boolean;
  firstTargetHitDay: number | null;
  tradingDays: Set<number>;
  closedTrades: number;
  pDDTriggers: number;
  pDDActiveTrades: number;
}

function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}

function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}

/** Compute MTM equity = realizedEquity + sum of unrealized P&L on open positions. */
function computeMTMEquity(
  state: LiveState,
  bar: Record<string, Candle | undefined>,
  cfg: FtmoDaytrade24hConfig,
): number {
  let mtm = state.realizedEquity;
  for (const pos of state.openPositions) {
    const candle = bar[pos.sourceSymbol];
    if (!candle) continue;
    const rawPnl =
      pos.direction === "long"
        ? (candle.close - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - candle.close) / pos.entryPrice;
    const effPnl = rawPnl * cfg.leverage * pos.effRisk;
    mtm += effPnl;
  }
  return mtm;
}

function simulateLiveWithPDD(
  aligned: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  windowStart: number,
  windowEnd: number,
): {
  passed: boolean;
  reason: string;
  passDay: number;
  trades: number;
  pDDTriggers: number;
} {
  const state: LiveState = {
    equity: 1.0,
    realizedEquity: 1.0,
    day: 0,
    dayStart: 1.0,
    dayPeak: 1.0,
    challengePeak: 1.0,
    openPositions: [],
    pausedAtTarget: false,
    firstTargetHitDay: null,
    tradingDays: new Set(),
    closedTrades: 0,
    pDDTriggers: 0,
    pDDActiveTrades: 0,
  };

  const symbols = syms(cfg);
  const ethKey = symbols.find((s) => s === "ETHUSDT") ?? symbols[0];
  const ts0 = aligned[ethKey][windowStart].openTime;
  const minDays = cfg.minTradingDays ?? 4;
  const maxDays = cfg.maxDays;
  const trail = cfg.dailyPeakTrailingStop?.trailDistance;

  const atrByAsset: Record<string, (number | null)[]> = {};
  if (cfg.chandelierExit) {
    for (const asset of cfg.assets) {
      const sourceKey = asset.sourceSymbol ?? asset.symbol;
      const cs = aligned[sourceKey];
      if (cs) atrByAsset[sourceKey] = atr(cs, cfg.chandelierExit.period);
    }
  }

  for (let i = windowStart; i < windowEnd; i++) {
    const currentBar = aligned[ethKey][i];
    const currentDay = Math.floor(
      (currentBar.openTime - ts0) / (24 * 3600_000),
    );
    if (currentDay >= maxDays) break;

    if (currentDay > state.day) {
      state.day = currentDay;
      state.dayStart = state.equity;
      state.dayPeak = state.equity;
    }

    // Build per-symbol bar map (current bar per source-symbol)
    const barMap: Record<string, Candle | undefined> = {};
    for (const s of symbols) barMap[s] = aligned[s]?.[i];

    // Compute MTM equity (realized + unrealized) at this bar
    state.equity = computeMTMEquity(state, barMap, cfg);

    // Update peaks (MTM-based, like a live broker)
    state.dayPeak = Math.max(state.dayPeak, state.equity);
    state.challengePeak = Math.max(state.challengePeak, state.equity);

    // Process exits for open positions (uses bar.high/low for SL/TP/PTP)
    for (let p = state.openPositions.length - 1; p >= 0; p--) {
      const pos = state.openPositions[p];
      const candle = aligned[pos.sourceSymbol]?.[i];
      if (!candle) continue;
      if (pos.direction === "long") {
        pos.highWatermark = Math.max(pos.highWatermark, candle.high);
      } else {
        pos.highWatermark = Math.min(pos.highWatermark, candle.low);
      }

      const ptp = cfg.partialTakeProfit;
      if (ptp && !pos.ptpTriggered) {
        const triggerPrice =
          pos.direction === "long"
            ? pos.entryPrice * (1 + ptp.triggerPct)
            : pos.entryPrice * (1 - ptp.triggerPct);
        const ptpHit =
          pos.direction === "long"
            ? candle.high >= triggerPrice
            : candle.low <= triggerPrice;
        const stopHit =
          pos.direction === "long"
            ? candle.low <= pos.stopPrice
            : candle.high >= pos.stopPrice;
        const gapPastPtp =
          pos.direction === "long"
            ? candle.open >= triggerPrice
            : candle.open <= triggerPrice;
        if (ptpHit && (!stopHit || gapPastPtp)) {
          pos.ptpTriggered = true;
          pos.ptpRealizedPct = ptp.closeFraction * ptp.triggerPct;
          if (pos.direction === "long" && pos.entryPrice > pos.stopPrice) {
            pos.stopPrice = pos.entryPrice;
          } else if (
            pos.direction === "short" &&
            pos.entryPrice < pos.stopPrice
          ) {
            pos.stopPrice = pos.entryPrice;
          }
          pos.beActive = true;
          pos.highWatermark = candle.close;
        }
      }

      if (cfg.chandelierExit) {
        const atrSeries = atrByAsset[pos.sourceSymbol];
        const atrVal = atrSeries?.[i];
        if (atrVal !== null && atrVal !== undefined) {
          const minMoveR = cfg.chandelierExit.minMoveR ?? 0;
          const originalR = Math.abs(pos.entryPrice - pos.stopPrice);
          const moveR =
            pos.direction === "long"
              ? (pos.highWatermark - pos.entryPrice) / originalR
              : (pos.entryPrice - pos.highWatermark) / originalR;
          if (moveR >= minMoveR) {
            const trailDist = cfg.chandelierExit.mult * atrVal;
            if (pos.direction === "long") {
              const newStop = pos.highWatermark - trailDist;
              if (newStop > pos.stopPrice) pos.stopPrice = newStop;
            } else {
              const newStop = pos.highWatermark + trailDist;
              if (newStop < pos.stopPrice) pos.stopPrice = newStop;
            }
          }
        }
      }

      let exitPrice: number | null = null;
      if (pos.direction === "long") {
        if (candle.low <= pos.stopPrice) exitPrice = pos.stopPrice;
        else if (candle.high >= pos.tpPrice) exitPrice = pos.tpPrice;
      } else {
        if (candle.high >= pos.stopPrice) exitPrice = pos.stopPrice;
        else if (candle.low <= pos.tpPrice) exitPrice = pos.tpPrice;
      }
      if (exitPrice !== null) {
        let rawPnl =
          pos.direction === "long"
            ? (exitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - exitPrice) / pos.entryPrice;
        if (pos.ptpTriggered && ptp) {
          rawPnl = pos.ptpRealizedPct + (1 - ptp.closeFraction) * rawPnl;
        }
        const effPnl = Math.max(
          rawPnl * cfg.leverage * pos.effRisk,
          -pos.effRisk * 1.5,
        );
        state.realizedEquity *= 1 + effPnl;
        state.openPositions.splice(p, 1);
        state.closedTrades++;
      }
    }

    // Re-compute MTM after exits
    state.equity = computeMTMEquity(state, barMap, cfg);
    state.challengePeak = Math.max(state.challengePeak, state.equity);

    // Fail conditions (using MTM equity — closer to Live broker check)
    if (state.equity <= 1 - cfg.maxTotalLoss) {
      return {
        passed: false,
        reason: "total_loss",
        passDay: 0,
        trades: state.closedTrades,
        pDDTriggers: state.pDDTriggers,
      };
    }
    if ((state.equity - state.dayStart) / state.dayStart <= -cfg.maxDailyLoss) {
      return {
        passed: false,
        reason: "daily_loss",
        passDay: 0,
        trades: state.closedTrades,
        pDDTriggers: state.pDDTriggers,
      };
    }

    if (
      state.equity >= 1 + cfg.profitTarget &&
      state.firstTargetHitDay === null
    ) {
      state.firstTargetHitDay = currentDay;
      state.pausedAtTarget = !!cfg.pauseAtTargetReached;
    }
    if (state.firstTargetHitDay !== null) {
      state.tradingDays.add(currentDay);
      if (state.tradingDays.size >= minDays) {
        return {
          passed: true,
          reason: "profit_target",
          passDay: Math.max(state.firstTargetHitDay + 1, minDays),
          trades: state.closedTrades,
          pDDTriggers: state.pDDTriggers,
        };
      }
    }

    if (state.pausedAtTarget) continue;

    // DPT gate (uses MTM-based dayPeak — Live-faithful)
    if (trail !== undefined) {
      const drop =
        (state.dayPeak - state.equity) / Math.max(state.dayPeak, 1e-9);
      if (drop >= trail) continue;
    }

    const mct = cfg.maxConcurrentTrades;
    if (mct !== undefined && state.openPositions.length >= mct) continue;

    // Detect signals
    const crossKey = cfg.crossAssetFilter?.symbol;
    for (const asset of cfg.assets) {
      const sourceKey = asset.sourceSymbol ?? asset.symbol;
      const candles = aligned[sourceKey];
      if (!candles) continue;
      const slice = candles.slice(0, i + 1);
      if (slice.length < 100) continue;
      const cross = crossKey ? aligned[crossKey]?.slice(0, i + 1) : undefined;
      let trades: Daytrade24hTrade[] = [];
      try {
        trades = detectAsset(slice, asset, cfg, cross);
      } catch {
        continue;
      }
      const matched = trades.find((t) => t.entryTime === currentBar.openTime);
      if (!matched) continue;
      if (mct !== undefined && state.openPositions.length >= mct) break;

      const stopPct = asset.stopPct ?? cfg.stopPct;
      const tpPct = asset.tpPct ?? cfg.tpPct;
      const stopPrice =
        matched.direction === "long"
          ? matched.entryPrice * (1 - stopPct)
          : matched.entryPrice * (1 + stopPct);
      const tpPrice =
        matched.direction === "long"
          ? matched.entryPrice * (1 + tpPct)
          : matched.entryPrice * (1 - tpPct);

      // ── pDD logic (MTM-based; mirrors engine 4983-4988 BUT with MTM peak) ──
      const baseRisk = asset.riskFrac;
      const cap = cfg.liveCaps?.maxRiskFrac ?? baseRisk;
      let factor = 1.0;
      if (cfg.peakDrawdownThrottle && state.challengePeak > 0) {
        const fromPeak =
          (state.challengePeak - state.equity) / state.challengePeak;
        if (fromPeak >= cfg.peakDrawdownThrottle.fromPeak) {
          factor = Math.min(factor, cfg.peakDrawdownThrottle.factor);
          state.pDDTriggers++;
        }
      }
      const effRisk = Math.min(baseRisk * factor, cap);
      if (factor < 1.0) state.pDDActiveTrades++;
      if (effRisk <= 0) continue;

      state.openPositions.push({
        symbol: matched.symbol,
        sourceSymbol: sourceKey,
        direction: matched.direction,
        entryTime: matched.entryTime,
        entryPrice: matched.entryPrice,
        stopPrice,
        tpPrice,
        effRisk,
        highWatermark: matched.entryPrice,
        beActive: false,
        ptpTriggered: false,
        ptpRealizedPct: 0,
      });
      state.tradingDays.add(currentDay);
    }
  }

  const final =
    state.firstTargetHitDay !== null && state.tradingDays.size >= minDays;
  return {
    passed: final,
    reason: final ? "profit_target" : "time",
    passDay: final ? Math.max((state.firstTargetHitDay ?? 0) + 1, minDays) : 0,
    trades: state.closedTrades,
    pDDTriggers: state.pDDTriggers,
  };
}

describe("Round 38 — V4 sim with pDD", { timeout: 180 * 60_000 }, () => {
  it("R28 vs R28_V4 under MTM-based pDD (Live-proxy)", async () => {
    const liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
    const variants: { name: string; cfg: FtmoDaytrade24hConfig }[] = [
      {
        name: "R28",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
          liveCaps,
        },
      },
      {
        name: "R28_V4",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
          liveCaps,
        },
      },
    ];

    const symbols = syms(variants[0].cfg);
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "30m",
          targetCount: 30000, // ~1.5y instead of 5.5y for faster V4 sim
          maxPages: 35,
        });
        data[s] = r.filter((c) => c.isFinal);
      } catch {}
    }
    const aligned = alignCommon(data, symbols);
    const minBars = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
    const bpd = 48;
    const winBars = variants[0].cfg.maxDays * bpd;
    const stepBars = 7 * bpd; // step 7d to keep window count manageable (~50 windows)

    console.log(
      `Data: ${minBars} bars / ${((aligned[symbols[0]][minBars - 1].openTime - aligned[symbols[0]][0].openTime) / (365 * 24 * 3600_000)).toFixed(2)}y`,
    );

    for (const v of variants) {
      let passes = 0;
      let total = 0;
      let totalTriggers = 0;
      let triggeredWindows = 0;
      for (let start = 0; start + winBars <= minBars; start += stepBars) {
        const res = simulateLiveWithPDD(aligned, v.cfg, start, start + winBars);
        total++;
        if (res.passed) passes++;
        totalTriggers += res.pDDTriggers;
        if (res.pDDTriggers > 0) triggeredWindows++;
      }
      const passPct = (passes / total) * 100;
      console.log(
        `\n${v.name}:`,
        `\n  V4-sim (MTM peak): ${passes}/${total} = ${passPct.toFixed(2)}%`,
        `\n  pDD triggers: total=${totalTriggers} / triggered_windows=${triggeredWindows}/${total}`,
      );
    }

    expect(true).toBe(true);
  });
});
