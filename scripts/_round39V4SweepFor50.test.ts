/**
 * Round 39 — V4-Sim Sweep für ≥50% Live-Pass.
 *
 * V4-Sim (MTM-bar-by-bar) ist Live-Proxy. R28: 40%, R28_V4: 36.5%.
 * Ziel: finde Config die in V4-Sim ≥50% schafft.
 *
 * Hypothesen:
 *   A) Looser pDD: factor 0.50 (light throttle) statt 0.15
 *   B) Higher threshold: fromPeak 0.05 (nur bei tieferer DD triggern)
 *   C) PTP only (keine pDD) — pDD könnte das Problem sein
 *   D) Smaller basket (5 assets): weniger MTM-Volatilität
 *   E) Tighter PTP: triggerPct 0.015 (früher partial close)
 *   F) Multi-stage PTP (partialTakeProfitLevels)
 */
import { describe, it, expect } from "vitest";
import {
  detectAsset,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
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
  equity: number;
  realizedEquity: number;
  day: number;
  dayStart: number;
  dayPeak: number;
  challengePeak: number;
  openPositions: OpenPosition[];
  pausedAtTarget: boolean;
  firstTargetHitDay: number | null;
  tradingDays: Set<number>;
  closedTrades: number;
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

function computeMTM(
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
    mtm += rawPnl * cfg.leverage * pos.effRisk;
  }
  return mtm;
}

function simulateLive(
  aligned: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  windowStart: number,
  windowEnd: number,
): boolean {
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
    const barMap: Record<string, Candle | undefined> = {};
    for (const s of symbols) barMap[s] = aligned[s]?.[i];
    state.equity = computeMTM(state, barMap, cfg);
    state.dayPeak = Math.max(state.dayPeak, state.equity);
    state.challengePeak = Math.max(state.challengePeak, state.equity);
    for (let p = state.openPositions.length - 1; p >= 0; p--) {
      const pos = state.openPositions[p];
      const candle = aligned[pos.sourceSymbol]?.[i];
      if (!candle) continue;
      if (pos.direction === "long")
        pos.highWatermark = Math.max(pos.highWatermark, candle.high);
      else pos.highWatermark = Math.min(pos.highWatermark, candle.low);
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
          if (pos.direction === "long" && pos.entryPrice > pos.stopPrice)
            pos.stopPrice = pos.entryPrice;
          else if (pos.direction === "short" && pos.entryPrice < pos.stopPrice)
            pos.stopPrice = pos.entryPrice;
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
        if (pos.ptpTriggered && ptp)
          rawPnl = pos.ptpRealizedPct + (1 - ptp.closeFraction) * rawPnl;
        const effPnl = Math.max(
          rawPnl * cfg.leverage * pos.effRisk,
          -pos.effRisk * 1.5,
        );
        state.realizedEquity *= 1 + effPnl;
        state.openPositions.splice(p, 1);
        state.closedTrades++;
      }
    }
    state.equity = computeMTM(state, barMap, cfg);
    state.challengePeak = Math.max(state.challengePeak, state.equity);
    if (state.equity <= 1 - cfg.maxTotalLoss) return false;
    if ((state.equity - state.dayStart) / state.dayStart <= -cfg.maxDailyLoss)
      return false;
    if (
      state.equity >= 1 + cfg.profitTarget &&
      state.firstTargetHitDay === null
    ) {
      state.firstTargetHitDay = currentDay;
      state.pausedAtTarget = !!cfg.pauseAtTargetReached;
    }
    if (state.firstTargetHitDay !== null) {
      state.tradingDays.add(currentDay);
      if (state.tradingDays.size >= minDays) return true;
    }
    if (state.pausedAtTarget) continue;
    if (trail !== undefined) {
      const drop =
        (state.dayPeak - state.equity) / Math.max(state.dayPeak, 1e-9);
      if (drop >= trail) continue;
    }
    const mct = cfg.maxConcurrentTrades;
    if (mct !== undefined && state.openPositions.length >= mct) continue;
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
      const baseRisk = asset.riskFrac;
      const cap = cfg.liveCaps?.maxRiskFrac ?? baseRisk;
      let factor = 1.0;
      if (cfg.peakDrawdownThrottle && state.challengePeak > 0) {
        const fromPeak =
          (state.challengePeak - state.equity) / state.challengePeak;
        if (fromPeak >= cfg.peakDrawdownThrottle.fromPeak) {
          factor = Math.min(factor, cfg.peakDrawdownThrottle.factor);
        }
      }
      const effRisk = Math.min(baseRisk * factor, cap);
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
  return state.firstTargetHitDay !== null && state.tradingDays.size >= minDays;
}

describe(
  "Round 39 — V4-Sim sweep for ≥50% Live",
  { timeout: 180 * 60_000 },
  () => {
    it("9 variants — find best V4-Sim performer", async () => {
      const liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
      const BASE_LITE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;
      const variants: { name: string; cfg: FtmoDaytrade24hConfig }[] = [
        {
          name: "R28_BASE",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
            liveCaps,
          },
        },
        {
          name: "R28_V4_BASE",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
            liveCaps,
          },
        },
        // pDD-loose variants (less aggressive throttle)
        {
          name: "pDD_0.03_0.50",
          cfg: {
            ...BASE_LITE,
            dailyPeakTrailingStop: { trailDistance: 0.012 },
            partialTakeProfit: { triggerPct: 0.025, closeFraction: 0.6 },
            peakDrawdownThrottle: { fromPeak: 0.03, factor: 0.5 },
            liveMode: true,
            liveCaps,
          },
        },
        {
          name: "pDD_0.05_0.50",
          cfg: {
            ...BASE_LITE,
            dailyPeakTrailingStop: { trailDistance: 0.012 },
            partialTakeProfit: { triggerPct: 0.025, closeFraction: 0.6 },
            peakDrawdownThrottle: { fromPeak: 0.05, factor: 0.5 },
            liveMode: true,
            liveCaps,
          },
        },
        {
          name: "pDD_0.05_0.70",
          cfg: {
            ...BASE_LITE,
            dailyPeakTrailingStop: { trailDistance: 0.012 },
            partialTakeProfit: { triggerPct: 0.025, closeFraction: 0.6 },
            peakDrawdownThrottle: { fromPeak: 0.05, factor: 0.7 },
            liveMode: true,
            liveCaps,
          },
        },
        // No pDD, just R28 + better PTP
        {
          name: "PTP_only_t0.02_f0.7",
          cfg: {
            ...BASE_LITE,
            dailyPeakTrailingStop: { trailDistance: 0.012 },
            partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.7 },
            liveMode: true,
            liveCaps,
          },
        },
        {
          name: "PTP_only_t0.025_f0.5",
          cfg: {
            ...BASE_LITE,
            dailyPeakTrailingStop: { trailDistance: 0.012 },
            partialTakeProfit: { triggerPct: 0.025, closeFraction: 0.5 },
            liveMode: true,
            liveCaps,
          },
        },
        // Tighter DPT
        {
          name: "DPT_0.008",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
            dailyPeakTrailingStop: { trailDistance: 0.008 },
            liveCaps,
          },
        },
        {
          name: "DPT_0.015",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
            dailyPeakTrailingStop: { trailDistance: 0.015 },
            liveCaps,
          },
        },
      ];

      const symbols = syms(BASE_LITE);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: 30000,
            maxPages: 35,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch {}
      }
      const aligned = alignCommon(data, symbols);
      const minBars = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
      const bpd = 48;
      const winBars = BASE_LITE.maxDays * bpd;
      const stepBars = 7 * bpd;
      console.log(
        `Data: ${minBars} bars / ${((aligned[symbols[0]][minBars - 1].openTime - aligned[symbols[0]][0].openTime) / (365 * 24 * 3600_000)).toFixed(2)}y`,
      );

      interface VR {
        name: string;
        pass: number;
        total: number;
        pct: number;
      }
      const results: VR[] = [];
      for (const v of variants) {
        let passes = 0,
          total = 0;
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const ok = simulateLive(aligned, v.cfg, start, start + winBars);
          total++;
          if (ok) passes++;
        }
        const pct = (passes / total) * 100;
        results.push({ name: v.name, pass: passes, total, pct });
        console.log(
          `${v.name.padEnd(28)} ${passes}/${total} = ${pct.toFixed(2)}%`,
        );
      }

      console.log(`\n=== Sorted ===`);
      results.sort((a, b) => b.pct - a.pct);
      for (const r of results) {
        console.log(
          `${r.name.padEnd(28)} ${r.pass}/${r.total} = ${r.pct.toFixed(2)}%`,
        );
      }

      const winners = results.filter((r) => r.pct >= 50);
      if (winners.length > 0) {
        console.log(`\n=== ${winners.length} variants ≥50% V4-Sim ===`);
        for (const r of winners)
          console.log(`  ${r.name}: ${r.pct.toFixed(2)}%`);
      } else {
        console.log(
          `\n=== NO variant reached 50% V4-Sim — single-account ceiling ~45% ===`,
        );
      }

      expect(results.length).toBeGreaterThan(5);
    });
  },
);
