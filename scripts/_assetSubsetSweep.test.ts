/**
 * Asset Subset Sweep — find optimal asset basket for V5_QUARTZ_LITE that
 * maximizes min(backtest, live) — i.e. best worst-case across both.
 *
 * Hypothesis: smaller, more diverse, less-correlated baskets reduce
 * MCT-pre-selection bias. With only 4-5 strong assets and MCT=10, MCT
 * never triggers → live-drift collapses.
 *
 * 30m bars, ~3000 per asset (~62.5 days × 24h × 2 = 3000 bars ≈ 62 days).
 * Step=3d windows. Time-budget: ~20 min.
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

const BARS_PER_DAY = 48; // 30m TF
const TOTAL_BARS = 3000;

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

function alignCommon(
  data: Record<string, Candle[]>,
  symbols: string[],
): Record<string, Candle[]> {
  const present = symbols.filter((s) => data[s] && data[s].length > 0);
  if (present.length === 0) return {};
  const sets = present.map((s) => new Set(data[s].map((c) => c.openTime)));
  let common = [...sets[0]];
  for (let i = 1; i < sets.length; i++) {
    common = common.filter((t) => sets[i].has(t));
  }
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of present)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}

function simulateLive(
  aligned: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  windowStart: number,
  windowEnd: number,
): { passed: boolean; passDay: number } {
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

  const symbolsAll = Object.keys(aligned);
  if (symbolsAll.length === 0) return { passed: false, passDay: 0 };
  const refKey = symbolsAll[0];
  const ts0 = aligned[refKey][windowStart].openTime;
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
    const currentBar = aligned[refKey][i];
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

    // Process exits
    for (let p = state.openPositions.length - 1; p >= 0; p--) {
      const pos = state.openPositions[p];
      const candle = aligned[pos.sourceSymbol]?.[i];
      if (!candle) continue;

      if (pos.direction === "long") {
        pos.highWatermark = Math.max(pos.highWatermark, candle.high);
      } else {
        pos.highWatermark = Math.min(pos.highWatermark, candle.low);
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
        const rawPnl =
          pos.direction === "long"
            ? (exitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - exitPrice) / pos.entryPrice;
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

    // Fail conditions
    if (state.equity <= 1 - cfg.maxTotalLoss)
      return { passed: false, passDay: 0 };
    if ((state.equity - state.dayStart) / state.dayStart <= -cfg.maxDailyLoss)
      return { passed: false, passDay: 0 };

    // Target check
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
          passDay: Math.max(state.firstTargetHitDay + 1, minDays),
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

    // Detect signals
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
      });
      state.tradingDays.add(currentDay);
    }
  }

  const final =
    state.firstTargetHitDay !== null && state.tradingDays.size >= minDays;
  return {
    passed: final,
    passDay: final ? Math.max((state.firstTargetHitDay ?? 0) + 1, minDays) : 0,
  };
}

// Asset progression: progressively add the most "core" assets first
// (high-cap, long-history, less correlated).
const SUBSET_PROGRESSION: { name: string; symbols: string[] }[] = [
  { name: "2-BTC+ETH", symbols: ["BTC-TREND", "ETH-TREND"] },
  { name: "3-+BNB", symbols: ["BTC-TREND", "ETH-TREND", "BNB-TREND"] },
  {
    name: "4-+LTC",
    symbols: ["BTC-TREND", "ETH-TREND", "BNB-TREND", "LTC-TREND"],
  },
  {
    name: "5-+ADA",
    symbols: ["BTC-TREND", "ETH-TREND", "BNB-TREND", "LTC-TREND", "ADA-TREND"],
  },
  {
    name: "6-+BCH",
    symbols: [
      "BTC-TREND",
      "ETH-TREND",
      "BNB-TREND",
      "LTC-TREND",
      "ADA-TREND",
      "BCH-TREND",
    ],
  },
  {
    name: "7-+XRP",
    symbols: [
      "BTC-TREND",
      "ETH-TREND",
      "BNB-TREND",
      "LTC-TREND",
      "ADA-TREND",
      "BCH-TREND",
      "XRP-TREND",
    ],
  },
  {
    name: "8-+ETC",
    symbols: [
      "BTC-TREND",
      "ETH-TREND",
      "BNB-TREND",
      "LTC-TREND",
      "ADA-TREND",
      "BCH-TREND",
      "XRP-TREND",
      "ETC-TREND",
    ],
  },
  {
    name: "9-+AAVE (full LITE)",
    symbols: [
      "BTC-TREND",
      "ETH-TREND",
      "BNB-TREND",
      "LTC-TREND",
      "ADA-TREND",
      "BCH-TREND",
      "XRP-TREND",
      "ETC-TREND",
      "AAVE-TREND",
    ],
  },
];

describe(
  "Asset Subset Sweep — V5_QUARTZ_LITE",
  { timeout: 30 * 60_000 },
  () => {
    it("find best worst-case subset (max min(backtest, live))", async () => {
      const baseCfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      };

      // Load all candles once. We use the full LITE symbol set (superset).
      const allSymbols = syms(baseCfg);
      console.log(
        `Loading ${allSymbols.length} symbols (30m TF, ~${TOTAL_BARS} bars each)...`,
      );
      const data: Record<string, Candle[]> = {};
      for (const s of allSymbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: TOTAL_BARS,
            maxPages: 4,
          });
          data[s] = r.filter((c) => c.isFinal).slice(-TOTAL_BARS);
        } catch {
          // skip
        }
      }
      console.log(
        `Loaded: ${Object.entries(data)
          .map(([k, v]) => `${k}=${v.length}`)
          .join(", ")}`,
      );

      type Row = {
        name: string;
        n: number;
        bt: number;
        live: number;
        drift: number;
        worstCase: number;
      };
      const results: Row[] = [];

      const winBars = baseCfg.maxDays * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;

      for (const subset of SUBSET_PROGRESSION) {
        const cfg: FtmoDaytrade24hConfig = {
          ...baseCfg,
          assets: baseCfg.assets.filter((a) =>
            subset.symbols.includes(a.symbol),
          ),
        };
        if (cfg.assets.length !== subset.symbols.length) {
          console.log(
            `[${subset.name}] skipped — only ${cfg.assets.length}/${subset.symbols.length} assets resolved`,
          );
          continue;
        }
        const subSymbols = syms(cfg);
        const aligned = alignCommon(data, subSymbols);
        const present = Object.keys(aligned);
        if (present.length < subSymbols.length) {
          console.log(
            `[${subset.name}] skipped — missing data: have ${present.length}/${subSymbols.length}`,
          );
          continue;
        }
        const minBars = Math.min(...subSymbols.map((s) => aligned[s].length));

        let btWindows = 0,
          btPasses = 0;
        let liveWindows = 0,
          livePasses = 0;

        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of subSymbols)
            slice[s] = aligned[s].slice(start, start + winBars);
          const bt = runFtmoDaytrade24h(slice, cfg);
          btWindows++;
          if (bt.passed) btPasses++;

          const live = simulateLive(slice, cfg, 0, winBars);
          liveWindows++;
          if (live.passed) livePasses++;
        }

        const btPct = (btPasses / Math.max(1, btWindows)) * 100;
        const livePct = (livePasses / Math.max(1, liveWindows)) * 100;
        const drift = livePct - btPct;
        const worst = Math.min(btPct, livePct);
        const row: Row = {
          name: subset.name,
          n: subset.symbols.length,
          bt: btPct,
          live: livePct,
          drift,
          worstCase: worst,
        };
        results.push(row);
        console.log(
          `[${subset.name}] N=${subset.symbols.length} | BT=${btPct.toFixed(1)}% (${btPasses}/${btWindows}) | LIVE=${livePct.toFixed(1)}% (${livePasses}/${liveWindows}) | drift=${drift.toFixed(1)}pp | worst=${worst.toFixed(1)}%`,
        );
      }

      results.sort((a, b) => b.worstCase - a.worstCase);
      console.log("\n=== RANKED BY worst-case = min(backtest, live) ===");
      for (const r of results) {
        console.log(
          `${r.worstCase.toFixed(1).padStart(5)}%  ${r.name.padEnd(22)} N=${r.n} BT=${r.bt.toFixed(1)}% LIVE=${r.live.toFixed(1)}% drift=${r.drift.toFixed(1)}pp`,
        );
      }
      if (results.length > 0) {
        const best = results[0];
        console.log(
          `\nWINNER: ${best.name} — worst-case ${best.worstCase.toFixed(2)}% (BT ${best.bt.toFixed(2)}% / LIVE ${best.live.toFixed(2)}% / drift ${best.drift.toFixed(2)}pp)`,
        );
      }
      expect(results.length).toBeGreaterThan(0);
    });
  },
);
