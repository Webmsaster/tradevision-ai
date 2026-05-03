/**
 * V4 Per-Asset Drift Analysis (Round 28 hypothesis test).
 *
 * Hypothesis: Maybe ONE asset is responsible for most of the -30pp drift
 * between V5_QUARTZ_LITE backtest (~83.58%) and V4 live simulator (~53%).
 * Candidates: ETC/XRP/AAVE — less price-momentum thus benefit more from
 * MCT pre-selection (which V4 cannot replicate the same way).
 *
 * Approach:
 * 1. Run V5_QUARTZ_LITE backtest engine (full)
 * 2. Run V4 live simulator (full) — copied from _v4LiveSimulator.test.ts
 * 3. Track per-asset: BT entries, V4 entries, BT win-rate, V4 win-rate
 * 4. Output per-asset drift table, identify which asset to drop
 *
 * Same data window (3.04y / aligned-bars / 30m) as _v4LiveSimulator.test.ts.
 *
 * DOES NOT modify production files.
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

interface PerAssetStats {
  entries: number;
  wins: number;
  losses: number;
  totalEffPnl: number;
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

function emptyStats(): PerAssetStats {
  return { entries: 0, wins: 0, losses: 0, totalEffPnl: 0 };
}

/**
 * V4 live-bar-by-bar simulator — copied verbatim from _v4LiveSimulator.test.ts
 * but augmented to track per-asset entries / win-rate via a shared map.
 */
function simulateLive(
  aligned: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  windowStart: number,
  windowEnd: number,
  perAsset: Record<string, PerAssetStats>,
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
        if (candle.low <= pos.stopPrice) {
          exitPrice = pos.stopPrice;
        } else if (candle.high >= pos.tpPrice) {
          exitPrice = pos.tpPrice;
        }
      } else {
        if (candle.high >= pos.stopPrice) {
          exitPrice = pos.stopPrice;
        } else if (candle.low <= pos.tpPrice) {
          exitPrice = pos.tpPrice;
        }
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

        // Track per-asset stats
        const stats = perAsset[pos.symbol] ?? emptyStats();
        stats.totalEffPnl += effPnl;
        if (rawPnl > 0) stats.wins++;
        else stats.losses++;
        perAsset[pos.symbol] = stats;

        state.openPositions.splice(p, 1);
        state.closedTrades++;
      }
    }

    if (state.equity <= 1 - cfg.maxTotalLoss) {
      return { passed: false, passDay: 0 };
    }
    if ((state.equity - state.dayStart) / state.dayStart <= -cfg.maxDailyLoss) {
      return { passed: false, passDay: 0 };
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

      // Track per-asset entry
      const stats = perAsset[asset.symbol] ?? emptyStats();
      stats.entries++;
      perAsset[asset.symbol] = stats;

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

describe("V4 Per-Asset Drift Analysis", { timeout: 60 * 60_000 }, () => {
  it("identifies which asset drives the BT-vs-V4 drift", async () => {
    const CFG = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;
    const cfg: FtmoDaytrade24hConfig = {
      ...CFG,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    };
    const symbols = syms(cfg);
    const tf = "30m";
    const bpd = 48;

    console.log(`\n=== V5_QUARTZ_LITE Per-Asset Drift (${tf}) ===`);
    console.log(`Symbols: ${symbols.join(", ")}`);

    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: tf,
          targetCount: 100000,
          maxPages: 120,
        });
        data[s] = r.filter((c) => c.isFinal);
      } catch {}
    }
    const aligned = alignCommon(data, symbols);
    const minBars = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
    const winBars = cfg.maxDays * bpd;
    const stepBars = 3 * bpd;
    console.log(
      `Aligned bars: ${minBars} (~${(minBars / bpd / 365).toFixed(2)}y), ` +
        `winBars=${winBars}, stepBars=${stepBars}`,
    );

    // Per-asset accumulators
    const btPerAsset: Record<string, PerAssetStats> = {};
    const v4PerAsset: Record<string, PerAssetStats> = {};
    for (const a of cfg.assets) {
      btPerAsset[a.symbol] = emptyStats();
      v4PerAsset[a.symbol] = emptyStats();
    }

    // ───── Backtest reference ─────
    let btWindows = 0,
      btPasses = 0;
    for (let start = 0; start + winBars <= minBars; start += stepBars) {
      const slice: Record<string, Candle[]> = {};
      for (const s of symbols)
        slice[s] = aligned[s].slice(start, start + winBars);
      const res = runFtmoDaytrade24h(slice, cfg);
      btWindows++;
      if (res.passed) btPasses++;
      for (const t of res.trades) {
        const stats = btPerAsset[t.symbol] ?? emptyStats();
        stats.entries++;
        if (t.rawPnl > 0) stats.wins++;
        else stats.losses++;
        stats.totalEffPnl += t.effPnl;
        btPerAsset[t.symbol] = stats;
      }
    }
    const btPassRate = (btPasses / btWindows) * 100;
    console.log(
      `\nBACKTEST: ${btPasses}/${btWindows} = ${btPassRate.toFixed(2)}% pass`,
    );

    // ───── V4 live simulation ─────
    let v4Windows = 0,
      v4Passes = 0;
    for (let start = 0; start + winBars <= minBars; start += stepBars) {
      const winSlice: Record<string, Candle[]> = {};
      for (const s of symbols)
        winSlice[s] = aligned[s].slice(start, start + winBars);
      const res = simulateLive(winSlice, cfg, 0, winBars, v4PerAsset);
      v4Windows++;
      if (res.passed) v4Passes++;
    }
    const v4PassRate = (v4Passes / v4Windows) * 100;
    console.log(
      `V4 LIVE:  ${v4Passes}/${v4Windows} = ${v4PassRate.toFixed(2)}% pass`,
    );
    console.log(`Total drift: ${(v4PassRate - btPassRate).toFixed(2)}pp\n`);

    // ───── Per-asset drift table ─────
    console.log(
      `${"asset".padEnd(12)} ${"BT_n".padStart(6)} ${"V4_n".padStart(6)} ` +
        `${"missed".padStart(7)} ${"miss%".padStart(7)} ` +
        `${"BT_wr".padStart(7)} ${"V4_wr".padStart(7)} ` +
        `${"BT_pnl".padStart(8)} ${"V4_pnl".padStart(8)} ` +
        `${"pnl_lost".padStart(9)}`,
    );
    console.log("─".repeat(96));

    type Row = {
      symbol: string;
      btN: number;
      v4N: number;
      missed: number;
      missPct: number;
      btWr: number;
      v4Wr: number;
      btPnl: number;
      v4Pnl: number;
      pnlLost: number;
    };
    const rows: Row[] = [];
    for (const a of cfg.assets) {
      const bt = btPerAsset[a.symbol];
      const v4 = v4PerAsset[a.symbol];
      const missed = bt.entries - v4.entries;
      const missPct = bt.entries > 0 ? (missed / bt.entries) * 100 : 0;
      const btWr = bt.entries > 0 ? (bt.wins / (bt.wins + bt.losses)) * 100 : 0;
      const v4Wr = v4.entries > 0 ? (v4.wins / (v4.wins + v4.losses)) * 100 : 0;
      const pnlLost = bt.totalEffPnl - v4.totalEffPnl;
      rows.push({
        symbol: a.symbol,
        btN: bt.entries,
        v4N: v4.entries,
        missed,
        missPct,
        btWr,
        v4Wr,
        btPnl: bt.totalEffPnl,
        v4Pnl: v4.totalEffPnl,
        pnlLost,
      });
    }
    // Sort by pnl_lost desc — biggest drift contributor first
    rows.sort((a, b) => b.pnlLost - a.pnlLost);
    for (const r of rows) {
      console.log(
        `${r.symbol.padEnd(12)} ` +
          `${String(r.btN).padStart(6)} ${String(r.v4N).padStart(6)} ` +
          `${String(r.missed).padStart(7)} ${r.missPct.toFixed(1).padStart(6)}% ` +
          `${r.btWr.toFixed(1).padStart(6)}% ${r.v4Wr.toFixed(1).padStart(6)}% ` +
          `${r.btPnl.toFixed(3).padStart(8)} ${r.v4Pnl.toFixed(3).padStart(8)} ` +
          `${r.pnlLost.toFixed(3).padStart(9)}`,
      );
    }

    // ───── Verdict ─────
    const worst = rows[0];
    const totalPnlLost = rows.reduce((s, r) => s + r.pnlLost, 0);
    const worstShare =
      totalPnlLost !== 0 ? (worst.pnlLost / totalPnlLost) * 100 : 0;
    console.log(`\n─────────────────────────────────────────────`);
    console.log(`Total cumulative effPnl lost: ${totalPnlLost.toFixed(3)}`);
    console.log(
      `Worst drift contributor: ${worst.symbol} ` +
        `(${worst.pnlLost.toFixed(3)} effPnl lost, ${worstShare.toFixed(1)}% of total)`,
    );
    const top3 = rows.slice(0, 3);
    const top3Share =
      totalPnlLost !== 0
        ? (top3.reduce((s, r) => s + r.pnlLost, 0) / totalPnlLost) * 100
        : 0;
    console.log(
      `Top-3 contributors: ${top3.map((r) => r.symbol).join(", ")} ` +
        `(${top3Share.toFixed(1)}% of total drift)`,
    );

    expect(true).toBe(true);
  });
});
