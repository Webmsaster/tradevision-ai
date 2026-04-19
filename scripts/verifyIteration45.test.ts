/**
 * Iter 45: Confluence-filter hunt for ≥70% Win-Rate.
 *
 * iter43-44 proved that pure TP/Stop ratio tuning CANNOT hit 60% WR with
 * positive Sharpe. The only remaining lever is REDUCING TRADES by adding
 * confluence filters — only trade the highest-probability setups.
 *
 * Filters tested on each of 7 LOCKED_EDGES:
 *  1) HTF trend:   require 24h SMA alignment with trade direction
 *  2) Vol regime:  require realized vol in percentile band [lo, hi]
 *  3) Hour-of-day: skip funding hours (00/08/16 UTC) + low-liq hours (5/6 UTC)
 *  4) Micro-pullback: for momentum, require a pullback bar before entry;
 *                    for fade, require an exhaustion bar (lower high / higher low)
 *  5) All combined
 *
 * Pass criteria: WR ≥ 0.70 AND Sharpe ≥ 1.0 AND net return > 0 AND trades ≥ 30.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  LOCKED_EDGES,
  lockedEdgeBinanceSymbol,
} from "../src/utils/volumeSpikeSignal";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { applyCosts } from "../src/utils/costModel";
import type { Candle } from "../src/utils/indicators";

interface ConfluenceFilterSet {
  name: string;
  htfTrend?: boolean;
  volRegime?: { loPct: number; hiPct: number };
  avoidHours?: number[];
  microPullback?: boolean;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function stdReturns(closes: number[]): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue;
    r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}

function sma(vals: number[], period: number): number {
  const slice = vals.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function realizedVol(closes: number[], window = 24): number {
  const r: number[] = [];
  for (let i = Math.max(1, closes.length - window); i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue;
    r.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(s.length * p);
  return s[Math.min(s.length - 1, Math.max(0, idx))];
}

interface RunResult {
  trades: number;
  wr: number;
  sh: number;
  pf: number;
  ret: number;
  dd: number;
}

function runWithFilters(
  candles: Candle[],
  cfg: {
    lookback: number;
    volMult: number;
    priceZ: number;
    tpPct: number;
    stopPct: number;
    holdBars: number;
    mode: "fade" | "momentum";
  },
  filt: ConfluenceFilterSet,
): RunResult {
  // Pre-compute vol regime thresholds across full history if needed
  let volLoThr = 0;
  let volHiThr = Infinity;
  if (filt.volRegime) {
    const rvs: number[] = [];
    const vwin = 96; // 4 days on 1h
    for (let i = vwin; i < candles.length; i++) {
      rvs.push(
        realizedVol(
          candles.slice(i - vwin, i).map((c) => c.close),
          24,
        ),
      );
    }
    volLoThr = percentile(rvs, filt.volRegime.loPct);
    volHiThr = percentile(rvs, filt.volRegime.hiPct);
  }

  const returns: number[] = [];
  let totalTrades = 0;
  for (let i = cfg.lookback; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0) continue;
    const window = candles.slice(i - cfg.lookback, i);

    const medVol = median(window.map((c) => c.volume));
    if (medVol <= 0) continue;
    const vZ = cur.volume / medVol;
    if (vZ < cfg.volMult) continue;
    const sd = stdReturns(window.map((c) => c.close));
    if (sd <= 0) continue;
    const ret = (cur.close - prev.close) / prev.close;
    const pZ = Math.abs(ret) / sd;
    if (pZ < cfg.priceZ) continue;

    // Direction from mode
    const direction: "long" | "short" =
      cfg.mode === "fade"
        ? ret > 0
          ? "short"
          : "long"
        : ret > 0
          ? "long"
          : "short";

    // ---- CONFLUENCE FILTERS ----
    if (filt.htfTrend) {
      // 24h SMA of closes (last 24 bars from current)
      const smaVal = sma(
        window.slice(-24).map((c) => c.close),
        24,
      );
      const alignedLong = cur.close > smaVal;
      if (direction === "long" && !alignedLong) continue;
      if (direction === "short" && alignedLong) continue;
    }

    if (filt.volRegime) {
      const rv = realizedVol(
        window.slice(-24).map((c) => c.close),
        24,
      );
      if (rv < volLoThr || rv > volHiThr) continue;
    }

    if (filt.avoidHours) {
      const h = new Date(cur.openTime).getUTCHours();
      if (filt.avoidHours.includes(h)) continue;
    }

    if (filt.microPullback) {
      const penult = candles[i - 1];
      const before = candles[i - 2];
      if (!penult || !before) continue;
      // For momentum: require last bar had a small pullback (penult below `before.close` if long)
      // For fade: require consecutive bars in the trigger direction (exhaustion)
      if (cfg.mode === "momentum") {
        const hadPullback =
          direction === "long"
            ? penult.close < before.close
            : penult.close > before.close;
        if (!hadPullback) continue;
      } else {
        // fade: prior 2 bars should be in the same direction as the spike (confirms overshoot)
        const sameDir =
          ret > 0 ? penult.close > before.close : penult.close < before.close;
        if (!sameDir) continue;
      }
    }

    // ---- trade execution (same as intradayScalp) ----
    const entryBar = candles[i + 1];
    if (!entryBar) break;
    const entry = entryBar.open;
    const tpLevel =
      direction === "long" ? entry * (1 + cfg.tpPct) : entry * (1 - cfg.tpPct);
    const stopLevel =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);

    let exitIdx = i + 1 + cfg.holdBars;
    if (exitIdx >= candles.length) exitIdx = candles.length - 1;
    let exitPrice = candles[exitIdx].close;
    for (let j = i + 2; j <= exitIdx; j++) {
      const bar = candles[j];
      const tpHit =
        direction === "long" ? bar.high >= tpLevel : bar.low <= tpLevel;
      const stopHit =
        direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
      if (tpHit && stopHit) {
        exitIdx = j;
        exitPrice = stopLevel;
        break;
      }
      if (tpHit) {
        exitIdx = j;
        exitPrice = tpLevel;
        break;
      }
      if (stopHit) {
        exitIdx = j;
        exitPrice = stopLevel;
        break;
      }
    }
    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction,
      holdingHours: exitIdx - (i + 1),
      config: MAKER_COSTS,
    });
    returns.push(cost.netPnlPct);
    totalTrades++;
    i = exitIdx;
  }

  const netRet = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const wr = returns.length > 0 ? wins / returns.length : 0;
  const grossW = returns.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const grossL = Math.abs(
    returns.filter((r) => r < 0).reduce((s, v) => s + v, 0),
  );
  const pf = grossL > 0 ? grossW / grossL : returns.length > 0 ? 999 : 0;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const sd = Math.sqrt(v);
  const perYear = 365 * 24; // assume each trigger could fire any hour
  const sh = sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0;

  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1] * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades: totalTrades,
    wr,
    sh,
    pf,
    ret: netRet,
    dd: maxDd,
  };
}

describe("iteration 45 — confluence-filter hunt for ≥70% WR", () => {
  it(
    "test 5 confluence filters × 7 locked edges × 4 TP variants",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 45: CONFLUENCE FILTERS FOR WR ≥ 70% ===");

      const uniqueSyms = Array.from(
        new Set(LOCKED_EDGES.map((e) => lockedEdgeBinanceSymbol(e.symbol))),
      );
      const data: Record<string, Candle[]> = {};
      for (const s of uniqueSyms) {
        console.log(`Fetching ${s} 1h (~10000)...`);
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "1h",
          targetCount: 10000,
        });
      }

      const filterSets: ConfluenceFilterSet[] = [
        { name: "none" },
        { name: "htfTrend", htfTrend: true },
        { name: "volMid", volRegime: { loPct: 0.3, hiPct: 0.7 } },
        { name: "avoidFunding", avoidHours: [0, 8, 16, 5, 6] },
        { name: "microPB", microPullback: true },
        {
          name: "htf+vol",
          htfTrend: true,
          volRegime: { loPct: 0.3, hiPct: 0.8 },
        },
        {
          name: "htf+micro",
          htfTrend: true,
          microPullback: true,
        },
        {
          name: "allConf",
          htfTrend: true,
          volRegime: { loPct: 0.3, hiPct: 0.8 },
          avoidHours: [0, 8, 16, 5, 6],
          microPullback: true,
        },
      ];

      // Test each edge with each filter, and with TP variants
      const tpVariants = [0.005, 0.008, 0.012, 0.02];

      interface Row {
        edge: string;
        filter: string;
        tp: number;
        trades: number;
        wr: number;
        sh: number;
        pf: number;
        ret: number;
        dd: number;
      }
      const rows: Row[] = [];

      for (const edge of LOCKED_EDGES) {
        const sym = lockedEdgeBinanceSymbol(edge.symbol);
        const baseLabel = `${sym.replace("USDT", "")} ${edge.cfg.mode}`;

        for (const filter of filterSets) {
          for (const tp of tpVariants) {
            const r = runWithFilters(
              data[sym],
              {
                lookback: edge.cfg.lookback,
                volMult: edge.cfg.volMult,
                priceZ: edge.cfg.priceZ,
                tpPct: tp,
                stopPct: edge.cfg.stopPct,
                holdBars: edge.cfg.holdBars,
                mode: edge.cfg.mode,
              },
              filter,
            );
            if (r.trades < 30) continue;
            rows.push({
              edge: baseLabel,
              filter: filter.name,
              tp,
              ...r,
            });
          }
        }
      }

      // Report all rows with WR >= 60%
      console.log(
        "\n=== Configurations with WR ≥ 60% ===\n" +
          "edge".padEnd(16) +
          "filter".padEnd(14) +
          "tp%".padStart(7) +
          "n".padStart(6) +
          "WR%".padStart(7) +
          "PF".padStart(7) +
          "Sh".padStart(7) +
          "ret%".padStart(8) +
          "DD%".padStart(6),
      );
      for (const r of rows
        .filter((x) => x.wr >= 0.6)
        .sort((a, b) => b.wr - a.wr)) {
        const passed = r.wr >= 0.7 && r.sh >= 1.0 && r.ret > 0;
        console.log(
          r.edge.padEnd(16) +
            r.filter.padEnd(14) +
            (r.tp * 100).toFixed(2).padStart(7) +
            r.trades.toString().padStart(6) +
            (r.wr * 100).toFixed(1).padStart(7) +
            r.pf.toFixed(2).padStart(7) +
            r.sh.toFixed(2).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(8) +
            (r.dd * 100).toFixed(1).padStart(6) +
            (passed ? "  ★" : ""),
        );
      }

      const winners = rows.filter(
        (r) => r.wr >= 0.7 && r.sh >= 1.0 && r.ret > 0,
      );
      console.log(
        `\n★ Configurations with WR ≥ 70% AND Sharpe ≥ 1.0 AND positive return: ${winners.length}`,
      );
      for (const w of winners.sort((a, b) => b.sh - a.sh)) {
        console.log(
          `  ${w.edge.padEnd(16)} filter=${w.filter.padEnd(12)} tp=${(w.tp * 100).toFixed(2)}%  n=${w.trades}  WR=${(w.wr * 100).toFixed(1)}%  Sh=${w.sh.toFixed(2)}  ret=${(w.ret * 100).toFixed(1)}%`,
        );
      }
    },
  );
});
