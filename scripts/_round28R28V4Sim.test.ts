/**
 * Round 28 — R28 in V4 live simulator.
 *
 * Goal: confirm V4 simulator (chronological walk, no lookahead) also rises
 * with R28 features. Note: V4 lacks adaptiveSizing (Agent 1 finding,
 * ~6-10pp drift contribution), so V4 numbers will be lower than the engine
 * liveMode=true number — but the LIFT vs base should be similar.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  detectAsset,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
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
  riskFrac: number;
  effRisk: number;
  entryBarIdx: number;
  highWatermark: number;
  beActive: boolean;
  ptpTriggered: boolean;
  ptpRealizedPct: number;
}
interface LiveState {
  equity: number;
  day: number;
  dayStart: number;
  dayPeak: number;
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
/**
 * Compute sizing factor at a given equity / day. Mirrors engine line ~4920-5012:
 * adaptiveSizing tiers (highest matching wins) + timeBoost override + MAX_FACTOR=4.
 * Kelly / drawdownShield / peakDrawdownThrottle / intradayDailyLossThrottle
 * NOT included (V5_QUARTZ_LITE chain doesn't use them).
 */
function computeSizingFactor(
  equity: number,
  day: number,
  cfg: FtmoDaytrade24hConfig,
): number {
  const gain = equity - 1;
  let factor = 1;
  if (cfg.adaptiveSizing && cfg.adaptiveSizing.length > 0) {
    const sortedTiers = [...cfg.adaptiveSizing].sort(
      (a, b) => a.equityAbove - b.equityAbove,
    );
    for (const tier of sortedTiers) {
      if (gain >= tier.equityAbove) factor = tier.factor;
    }
  }
  if (
    cfg.timeBoost &&
    day >= cfg.timeBoost.afterDay &&
    gain < cfg.timeBoost.equityBelow &&
    cfg.timeBoost.factor > factor
  ) {
    factor = cfg.timeBoost.factor;
  }
  return Math.min(factor, 4);
}

function simulateLive(
  aligned: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  ws: number,
  we: number,
) {
  const state: LiveState = {
    equity: 1.0,
    day: 0,
    dayStart: 1.0,
    dayPeak: 1.0,
    openPositions: [],
    pausedAtTarget: false,
    firstTargetHitDay: null,
    tradingDays: new Set(),
    closedTrades: 0,
  };
  const ts0 = aligned[Object.keys(aligned)[0]][ws].openTime;
  const symbols = syms(cfg);
  const ethKey = symbols.find((s) => s === "ETHUSDT") ?? symbols[0];
  const crossKey = cfg.crossAssetFilter?.symbol;
  const minDays = cfg.minTradingDays ?? 4;
  const maxDays = cfg.maxDays;
  const trail = cfg.dailyPeakTrailingStop?.trailDistance;
  const atrByAsset: Record<string, (number | null)[]> = {};
  if (cfg.chandelierExit)
    for (const a of cfg.assets) {
      const k = a.sourceSymbol ?? a.symbol;
      if (aligned[k])
        atrByAsset[k] = atr(aligned[k], cfg.chandelierExit.period);
    }
  for (let i = ws; i < we; i++) {
    const cb = aligned[ethKey][i];
    const cd = Math.floor((cb.openTime - ts0) / (24 * 3600_000));
    if (cd >= maxDays) break;
    if (cd > state.day) {
      state.day = cd;
      state.dayStart = state.equity;
      state.dayPeak = state.equity;
    }
    state.dayPeak = Math.max(state.dayPeak, state.equity);
    for (let p = state.openPositions.length - 1; p >= 0; p--) {
      const pos = state.openPositions[p];
      const c = aligned[pos.sourceSymbol]?.[i];
      if (!c) continue;
      pos.highWatermark =
        pos.direction === "long"
          ? Math.max(pos.highWatermark, c.high)
          : Math.min(pos.highWatermark, c.low);
      const ptp = cfg.partialTakeProfit;
      if (ptp && !pos.ptpTriggered) {
        const tp =
          pos.direction === "long"
            ? pos.entryPrice * (1 + ptp.triggerPct)
            : pos.entryPrice * (1 - ptp.triggerPct);
        const ptpHit = pos.direction === "long" ? c.high >= tp : c.low <= tp;
        const stopHit =
          pos.direction === "long"
            ? c.low <= pos.stopPrice
            : c.high >= pos.stopPrice;
        const gap = pos.direction === "long" ? c.open >= tp : c.open <= tp;
        if (ptpHit && (!stopHit || gap)) {
          pos.ptpTriggered = true;
          pos.ptpRealizedPct = ptp.closeFraction * ptp.triggerPct;
          if (pos.direction === "long") {
            if (pos.entryPrice > pos.stopPrice) pos.stopPrice = pos.entryPrice;
          } else {
            if (pos.entryPrice < pos.stopPrice) pos.stopPrice = pos.entryPrice;
          }
          pos.beActive = true;
          pos.highWatermark = c.close;
        }
      }
      if (cfg.breakEven && !pos.beActive) {
        const fav =
          pos.direction === "long"
            ? (c.close - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - c.close) / pos.entryPrice;
        if (fav >= cfg.breakEven.threshold) {
          pos.stopPrice = pos.entryPrice;
          pos.beActive = true;
        }
      }
      if (cfg.chandelierExit) {
        const av = atrByAsset[pos.sourceSymbol]?.[i];
        if (av !== null && av !== undefined) {
          const minR = cfg.chandelierExit.minMoveR ?? 0;
          const oR = Math.abs(pos.entryPrice - pos.stopPrice);
          const mR =
            pos.direction === "long"
              ? (pos.highWatermark - pos.entryPrice) / oR
              : (pos.entryPrice - pos.highWatermark) / oR;
          if (mR >= minR) {
            const td = cfg.chandelierExit.mult * av;
            if (pos.direction === "long") {
              const ns = pos.highWatermark - td;
              if (ns > pos.stopPrice) pos.stopPrice = ns;
            } else {
              const ns = pos.highWatermark + td;
              if (ns < pos.stopPrice) pos.stopPrice = ns;
            }
          }
        }
      }
      let ex: number | null = null;
      if (pos.direction === "long") {
        if (c.low <= pos.stopPrice) ex = pos.stopPrice;
        else if (c.high >= pos.tpPrice) ex = pos.tpPrice;
      } else {
        if (c.high >= pos.stopPrice) ex = pos.stopPrice;
        else if (c.low <= pos.tpPrice) ex = pos.tpPrice;
      }
      if (ex !== null) {
        let raw =
          pos.direction === "long"
            ? (ex - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - ex) / pos.entryPrice;
        if (pos.ptpTriggered && ptp)
          raw = pos.ptpRealizedPct + (1 - ptp.closeFraction) * raw;
        const eff = Math.max(
          raw * cfg.leverage * pos.effRisk,
          -pos.effRisk * 1.5,
        );
        state.equity *= 1 + eff;
        state.dayPeak = Math.max(state.dayPeak, state.equity);
        state.openPositions.splice(p, 1);
        state.closedTrades++;
      }
    }
    if (state.equity <= 1 - cfg.maxTotalLoss)
      return {
        passed: false,
        reason: "total_loss",
        passDay: 0,
        finalEquity: state.equity - 1,
        trades: state.closedTrades,
      };
    if ((state.equity - state.dayStart) / state.dayStart <= -cfg.maxDailyLoss)
      return {
        passed: false,
        reason: "daily_loss",
        passDay: 0,
        finalEquity: state.equity - 1,
        trades: state.closedTrades,
      };
    if (
      state.equity >= 1 + cfg.profitTarget &&
      state.firstTargetHitDay === null
    ) {
      state.firstTargetHitDay = cd;
      state.pausedAtTarget = !!cfg.pauseAtTargetReached;
    }
    if (state.firstTargetHitDay !== null) {
      state.tradingDays.add(cd);
      if (state.tradingDays.size >= minDays)
        return {
          passed: true,
          reason: "profit_target",
          passDay: Math.max(state.firstTargetHitDay + 1, minDays),
          finalEquity: state.equity - 1,
          trades: state.closedTrades,
        };
    }
    if (state.pausedAtTarget) continue;
    if (trail !== undefined) {
      const drop =
        (state.dayPeak - state.equity) / Math.max(state.dayPeak, 1e-9);
      if (drop >= trail) continue;
    }
    const mct = cfg.maxConcurrentTrades;
    if (mct !== undefined && state.openPositions.length >= mct) continue;
    for (const a of cfg.assets) {
      const sk = a.sourceSymbol ?? a.symbol;
      const cs = aligned[sk];
      if (!cs) continue;
      const sl = cs.slice(0, i + 1);
      if (sl.length < 100) continue;
      const cr = crossKey ? aligned[crossKey]?.slice(0, i + 1) : undefined;
      let tr: Daytrade24hTrade[] = [];
      try {
        tr = detectAsset(sl, a, cfg, cr);
      } catch {
        continue;
      }
      const m = tr.find((t) => t.entryTime === cb.openTime);
      if (!m) continue;
      if (mct !== undefined && state.openPositions.length >= mct) break;
      const sp = a.stopPct ?? cfg.stopPct,
        tp = a.tpPct ?? cfg.tpPct;
      const stp =
        m.direction === "long"
          ? m.entryPrice * (1 - sp)
          : m.entryPrice * (1 + sp);
      const tpp =
        m.direction === "long"
          ? m.entryPrice * (1 + tp)
          : m.entryPrice * (1 - tp);
      const sizingFactor = computeSizingFactor(state.equity, cd, cfg);
      const sized = a.riskFrac * sizingFactor;
      const cap = cfg.liveCaps?.maxRiskFrac ?? sized;
      const er = sized > cap ? cap : sized;
      if (er <= 0) continue;
      state.openPositions.push({
        symbol: m.symbol,
        sourceSymbol: sk,
        direction: m.direction,
        entryTime: m.entryTime,
        entryPrice: m.entryPrice,
        stopPrice: stp,
        tpPrice: tpp,
        riskFrac: a.riskFrac,
        effRisk: er,
        entryBarIdx: i,
        highWatermark: m.entryPrice,
        beActive: false,
        ptpTriggered: false,
        ptpRealizedPct: 0,
      });
      state.tradingDays.add(cd);
    }
  }
  const f =
    state.firstTargetHitDay !== null && state.tradingDays.size >= minDays;
  return {
    passed: f,
    reason: f ? "profit_target" : "time",
    passDay: f ? Math.max((state.firstTargetHitDay ?? 0) + 1, minDays) : 0,
    finalEquity: state.equity - 1,
    trades: state.closedTrades,
  };
}

describe("Round 28 — R28 V4 simulator check", { timeout: 60 * 60_000 }, () => {
  it("R28 vs base in V4", async () => {
    for (const [name, CFG] of [
      ["BASE V5_QUARTZ_LITE", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE],
      ["R28", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28],
    ] as const) {
      const cfg: FtmoDaytrade24hConfig = {
        ...CFG,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      };
      const symbols = syms(cfg);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: 100000,
            maxPages: 120,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch {}
      }
      const aligned = alignCommon(data, symbols);
      const minBars = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
      const bpd = 48;
      const winBars = cfg.maxDays * bpd,
        stepBars = 3 * bpd;
      let bw = 0,
        bp = 0;
      for (let s = 0; s + winBars <= minBars; s += stepBars) {
        const sl: Record<string, Candle[]> = {};
        for (const sm of symbols) sl[sm] = aligned[sm].slice(s, s + winBars);
        const r = runFtmoDaytrade24h(sl, cfg);
        bw++;
        if (r.passed) bp++;
      }
      let vw = 0,
        vp = 0;
      const v4Days: number[] = [];
      for (let s = 0; s + winBars <= minBars; s += stepBars) {
        const sl: Record<string, Candle[]> = {};
        for (const sm of symbols) sl[sm] = aligned[sm].slice(s, s + winBars);
        const r = simulateLive(sl, cfg, 0, winBars);
        vw++;
        if (r.passed) {
          vp++;
          if (r.passDay) v4Days.push(r.passDay);
        }
      }
      v4Days.sort((a, b) => a - b);
      const vMed = v4Days[Math.floor(v4Days.length / 2)] ?? 0;
      console.log(`\n=== ${name} ===`);
      console.log(
        `  BT-engine (default sort): ${bp}/${bw} = ${((bp / bw) * 100).toFixed(2)}%`,
      );
      console.log(
        `  V4 simulator (chronological): ${vp}/${vw} = ${((vp / vw) * 100).toFixed(2)}% / med ${vMed}d`,
      );
      console.log(
        `  V4-vs-engine drift: ${((vp / vw - bp / bw) * 100).toFixed(2)}pp`,
      );
    }
    expect(true).toBe(true);
  });
});
