/**
 * Round 28 — Drop-AAVE Test
 *
 * Agent 3 finding (Round 28): AAVE alone = 28.5% of -30pp drift.
 * Top-3 (AAVE, LTC, XRP) = 62% of drift.
 *
 * Hypothesis: drop AAVE+LTC+XRP from V5_QUARTZ_LITE → V4-live ≥ 70%.
 *
 * This test uses the same V4 bar-by-bar simulator as _v4LiveSimulator.test.ts
 * but with subset variants of V5_QUARTZ_LITE.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  detectAsset,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
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

function simulateLive(
  aligned: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  windowStart: number,
  windowEnd: number,
): {
  passed: boolean;
  reason: string;
  passDay: number;
  finalEquity: number;
  trades: number;
} {
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

  const ts0 = aligned[Object.keys(aligned)[0]][windowStart].openTime;
  const symbols = syms(cfg);
  const ethKey = symbols.find((s) => s === "ETHUSDT") ?? symbols[0];
  const crossKey = cfg.crossAssetFilter?.symbol;

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
    state.dayPeak = Math.max(state.dayPeak, state.equity);

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
          if (pos.direction === "long") {
            if (pos.entryPrice > pos.stopPrice) pos.stopPrice = pos.entryPrice;
          } else {
            if (pos.entryPrice < pos.stopPrice) pos.stopPrice = pos.entryPrice;
          }
          pos.beActive = true;
          pos.highWatermark = candle.close;
        }
      }

      if (cfg.breakEven && !pos.beActive) {
        const fav =
          pos.direction === "long"
            ? (candle.close - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - candle.close) / pos.entryPrice;
        if (fav >= cfg.breakEven.threshold) {
          pos.stopPrice = pos.entryPrice;
          pos.beActive = true;
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
        state.equity *= 1 + effPnl;
        state.dayPeak = Math.max(state.dayPeak, state.equity);
        state.openPositions.splice(p, 1);
        state.closedTrades++;
      }
    }

    if (state.equity <= 1 - cfg.maxTotalLoss) {
      return {
        passed: false,
        reason: "total_loss",
        passDay: 0,
        finalEquity: state.equity - 1,
        trades: state.closedTrades,
      };
    }
    if ((state.equity - state.dayStart) / state.dayStart <= -cfg.maxDailyLoss) {
      return {
        passed: false,
        reason: "daily_loss",
        passDay: 0,
        finalEquity: state.equity - 1,
        trades: state.closedTrades,
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
          finalEquity: state.equity - 1,
          trades: state.closedTrades,
        };
      }
    }

    if (state.pausedAtTarget) continue;

    if (trail !== undefined) {
      const drop =
        (state.dayPeak - state.equity) / Math.max(state.dayPeak, 1e-9);
      if (drop >= trail) continue;
    }

    const mct = cfg.maxConcurrentTrades;
    if (mct !== undefined && state.openPositions.length >= mct) continue;

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
      const effRisk = Math.min(baseRisk, cap);
      state.openPositions.push({
        symbol: matched.symbol,
        sourceSymbol: sourceKey,
        direction: matched.direction,
        entryTime: matched.entryTime,
        entryPrice: matched.entryPrice,
        stopPrice,
        tpPrice,
        riskFrac: baseRisk,
        effRisk,
        entryBarIdx: i,
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
    finalEquity: state.equity - 1,
    trades: state.closedTrades,
  };
}

const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;

function makeVariant(
  name: string,
  keepSymbols: string[],
): { name: string; cfg: FtmoDaytrade24hConfig } {
  return {
    name,
    cfg: {
      ...BASE,
      assets: BASE.assets.filter((a) => keepSymbols.includes(a.symbol)),
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    },
  };
}

const VARIANTS = [
  makeVariant("Q_LITE_FULL_9", [
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "ADA-TREND",
    "LTC-TREND",
    "BCH-TREND",
    "ETC-TREND",
    "XRP-TREND",
    "AAVE-TREND",
  ]),
  makeVariant("Q_LITE_NO_AAVE_8", [
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "ADA-TREND",
    "LTC-TREND",
    "BCH-TREND",
    "ETC-TREND",
    "XRP-TREND",
  ]),
  makeVariant("Q_LITE_TOP6", [
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "ADA-TREND",
    "BCH-TREND",
    "ETC-TREND",
  ]),
  makeVariant("Q_LITE_TOP5", [
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "BCH-TREND",
    "ETC-TREND",
  ]),
  makeVariant("Q_LITE_HIGH_MOM_4", [
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "BCH-TREND",
  ]),
];

describe("Round 28 — Drop-AAVE Test", { timeout: 60 * 60_000 }, () => {
  it("compare BT vs V4-live for asset subsets", async () => {
    const allSyms = new Set<string>();
    for (const v of VARIANTS) for (const s of syms(v.cfg)) allSyms.add(s);
    const data: Record<string, Candle[]> = {};
    for (const s of allSyms) {
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

    const results: {
      name: string;
      bt: number;
      v4: number;
      drift: number;
      btMed: number;
      v4Med: number;
      tlBt: number;
      tlV4: number;
    }[] = [];

    for (const v of VARIANTS) {
      const cfg = v.cfg;
      const symbols = syms(cfg);
      const aligned = alignCommon(data, symbols);
      const minBars = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
      const bpd = 48;
      const winBars = cfg.maxDays * bpd;
      const stepBars = 3 * bpd;

      let btW = 0,
        btP = 0,
        btTL = 0;
      const btDays: number[] = [];
      for (let start = 0; start + winBars <= minBars; start += stepBars) {
        const slice: Record<string, Candle[]> = {};
        for (const s of symbols)
          slice[s] = aligned[s].slice(start, start + winBars);
        const res = runFtmoDaytrade24h(slice, cfg);
        btW++;
        if (res.passed) {
          btP++;
          if (res.passDay) btDays.push(res.passDay);
        } else if (res.reason === "total_loss") btTL++;
      }
      btDays.sort((a, b) => a - b);

      let v4W = 0,
        v4P = 0,
        v4TL = 0;
      const v4Days: number[] = [];
      for (let start = 0; start + winBars <= minBars; start += stepBars) {
        const slice: Record<string, Candle[]> = {};
        for (const s of symbols)
          slice[s] = aligned[s].slice(start, start + winBars);
        const res = simulateLive(slice, cfg, 0, winBars);
        v4W++;
        if (res.passed) {
          v4P++;
          if (res.passDay) v4Days.push(res.passDay);
        } else if (res.reason === "total_loss") v4TL++;
      }
      v4Days.sort((a, b) => a - b);

      const btPct = (btP / btW) * 100;
      const v4Pct = (v4P / v4W) * 100;
      const drift = v4Pct - btPct;
      const btMed = btDays[Math.floor(btDays.length / 2)] ?? 0;
      const v4Med = v4Days[Math.floor(v4Days.length / 2)] ?? 0;
      results.push({
        name: v.name,
        bt: btPct,
        v4: v4Pct,
        drift,
        btMed,
        v4Med,
        tlBt: (btTL / btW) * 100,
        tlV4: (v4TL / v4W) * 100,
      });
      console.log(
        `\n=== ${v.name} (${cfg.assets.length} assets, ${minBars} bars) ===`,
      );
      console.log(
        `  BT:  ${btP}/${btW} = ${btPct.toFixed(2)}% / med=${btMed}d / TL=${((btTL / btW) * 100).toFixed(2)}%`,
      );
      console.log(
        `  V4:  ${v4P}/${v4W} = ${v4Pct.toFixed(2)}% / med=${v4Med}d / TL=${((v4TL / v4W) * 100).toFixed(2)}%`,
      );
      console.log(`  drift=${drift.toFixed(2)}pp`);
    }

    console.log(`\n\n=== SUMMARY (Round 28 Drop-AAVE) ===`);
    console.log(
      `Config            | BT     | V4-Live | Drift   | BT-med | V4-med`,
    );
    for (const r of results) {
      console.log(
        `${r.name.padEnd(18)}| ${r.bt.toFixed(2).padStart(6)}%| ${r.v4.toFixed(2).padStart(7)}%| ${r.drift.toFixed(2).padStart(7)}pp| ${String(r.btMed).padStart(6)}d| ${String(r.v4Med).padStart(6)}d`,
      );
    }

    const best = [...results].sort((a, b) => b.v4 - a.v4)[0];
    console.log(
      `\n>>> WINNER (max V4-live): ${best.name} → ${best.v4.toFixed(2)}% live <<<`,
    );
    expect(true).toBe(true);
  });
});
