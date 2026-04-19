/**
 * Iter 46: Confluence × asymmetric-TP hunt for ≥70% WR.
 *
 * iter43 tested asymmetric TP/Stop alone → failed (fees ate the edge).
 * iter45 tested confluence filters alone → failed (only reached 66% WR,
 *   negative Sharpe even then).
 *
 * Hypothesis: combining BOTH (tight TP × confluence-filtered highest-
 * probability setups) might clear both hurdles — fewer trades but a much
 * stronger probabilistic bias toward hitting the tight TP.
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

interface RunResult {
  trades: number;
  wr: number;
  sh: number;
  pf: number;
  ret: number;
  dd: number;
  avgWin: number;
  avgLoss: number;
}

function runAsym(
  candles: Candle[],
  cfg: {
    lookback: number;
    volMult: number;
    priceZ: number;
    tpPct: number;
    stopPct: number;
    holdBars: number;
    mode: "fade" | "momentum";
    htfTrend: boolean;
    microPullback: boolean;
    avoidHours?: number[];
  },
): RunResult {
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

    const direction: "long" | "short" =
      cfg.mode === "fade"
        ? ret > 0
          ? "short"
          : "long"
        : ret > 0
          ? "long"
          : "short";

    if (cfg.htfTrend) {
      const smaVal = sma(
        window.slice(-24).map((c) => c.close),
        24,
      );
      const alignedLong = cur.close > smaVal;
      if (direction === "long" && !alignedLong) continue;
      if (direction === "short" && alignedLong) continue;
    }

    if (cfg.avoidHours) {
      const h = new Date(cur.openTime).getUTCHours();
      if (cfg.avoidHours.includes(h)) continue;
    }

    if (cfg.microPullback) {
      const penult = candles[i - 1];
      const before = candles[i - 2];
      if (!penult || !before) continue;
      if (cfg.mode === "momentum") {
        const hadPullback =
          direction === "long"
            ? penult.close < before.close
            : penult.close > before.close;
        if (!hadPullback) continue;
      } else {
        const sameDir =
          ret > 0 ? penult.close > before.close : penult.close < before.close;
        if (!sameDir) continue;
      }
    }

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
  const perYear = 365 * 24;
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
  const avgWin =
    wins > 0
      ? returns.filter((r) => r > 0).reduce((s, v) => s + v, 0) / wins
      : 0;
  const losses = returns.filter((r) => r < 0);
  const avgLoss =
    losses.length > 0 ? losses.reduce((s, v) => s + v, 0) / losses.length : 0;

  return {
    trades: totalTrades,
    wr,
    sh,
    pf,
    ret: netRet,
    dd: maxDd,
    avgWin,
    avgLoss,
  };
}

describe("iteration 46 — asymmetric TP × confluence hunt for ≥70% WR", () => {
  it(
    "test 10 TP/Stop ratios × 4 filter combos × 7 locked edges",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 46: ASYM TP × CONFLUENCE ===");

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

      // Aggressive asymmetric TP/Stop grid
      const tpStops: [number, number][] = [
        [0.003, 0.015], // 0.3% tp / 1.5% stop → 1:5 (very tight TP)
        [0.004, 0.02], // 0.4% / 2.0% → 1:5
        [0.005, 0.02], // 0.5% / 2.0% → 1:4
        [0.005, 0.015], // 0.5% / 1.5% → 1:3
        [0.006, 0.018], // 0.6% / 1.8% → 1:3
        [0.008, 0.02], // 0.8% / 2.0% → 1:2.5
        [0.008, 0.016], // 0.8% / 1.6% → 1:2
        [0.01, 0.025], // 1.0% / 2.5% → 1:2.5
        [0.01, 0.02], // 1.0% / 2.0% → 1:2
        [0.015, 0.025], // 1.5% / 2.5% → 1:1.67
      ];

      interface FiltCombo {
        name: string;
        htf: boolean;
        micro: boolean;
        avoidFunding: boolean;
      }
      const filterCombos: FiltCombo[] = [
        { name: "none", htf: false, micro: false, avoidFunding: false },
        { name: "htf", htf: true, micro: false, avoidFunding: false },
        { name: "micro", htf: false, micro: true, avoidFunding: false },
        { name: "htf+micro", htf: true, micro: true, avoidFunding: false },
        { name: "all", htf: true, micro: true, avoidFunding: true },
      ];

      interface Row {
        edge: string;
        filter: string;
        tp: number;
        st: number;
        n: number;
        wr: number;
        sh: number;
        pf: number;
        ret: number;
        dd: number;
        aw: number;
        al: number;
      }
      const rows: Row[] = [];

      for (const edge of LOCKED_EDGES) {
        const sym = lockedEdgeBinanceSymbol(edge.symbol);
        const baseLabel = `${sym.replace("USDT", "")} ${edge.cfg.mode}`;

        for (const fc of filterCombos) {
          for (const [tp, st] of tpStops) {
            const r = runAsym(data[sym], {
              lookback: edge.cfg.lookback,
              volMult: edge.cfg.volMult,
              priceZ: edge.cfg.priceZ,
              tpPct: tp,
              stopPct: st,
              holdBars: edge.cfg.holdBars,
              mode: edge.cfg.mode,
              htfTrend: fc.htf,
              microPullback: fc.micro,
              avoidHours: fc.avoidFunding ? [0, 8, 16, 5, 6] : undefined,
            });
            if (r.trades < 30) continue;
            rows.push({
              edge: baseLabel,
              filter: fc.name,
              tp,
              st,
              n: r.trades,
              wr: r.wr,
              sh: r.sh,
              pf: r.pf,
              ret: r.ret,
              dd: r.dd,
              aw: r.avgWin,
              al: r.avgLoss,
            });
          }
        }
      }

      // Report all with WR >= 65%
      console.log(
        "\n=== Configs with WR ≥ 65% ===\n" +
          "edge".padEnd(16) +
          "filter".padEnd(12) +
          "tp/st".padStart(11) +
          "n".padStart(5) +
          "WR%".padStart(6) +
          "PF".padStart(7) +
          "Sh".padStart(7) +
          "ret%".padStart(8) +
          "DD%".padStart(6) +
          "aW%".padStart(7) +
          "aL%".padStart(7),
      );
      for (const r of rows
        .filter((x) => x.wr >= 0.65)
        .sort((a, b) => b.wr - a.wr)) {
        const passed = r.wr >= 0.7 && r.sh >= 1.0 && r.ret > 0;
        console.log(
          r.edge.padEnd(16) +
            r.filter.padEnd(12) +
            `${(r.tp * 100).toFixed(2)}/${(r.st * 100).toFixed(1)}`.padStart(
              11,
            ) +
            r.n.toString().padStart(5) +
            (r.wr * 100).toFixed(1).padStart(6) +
            r.pf.toFixed(2).padStart(7) +
            r.sh.toFixed(2).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(8) +
            (r.dd * 100).toFixed(1).padStart(6) +
            (r.aw * 100).toFixed(2).padStart(7) +
            (r.al * 100).toFixed(2).padStart(7) +
            (passed ? "  ★" : ""),
        );
      }

      const winners = rows.filter(
        (r) => r.wr >= 0.7 && r.sh >= 1.0 && r.ret > 0,
      );
      console.log(`\n★ Passed (WR≥70 AND Sh≥1.0 AND ret>0): ${winners.length}`);
      for (const w of winners.sort((a, b) => b.sh - a.sh)) {
        console.log(
          `  ${w.edge} filter=${w.filter} tp=${(w.tp * 100).toFixed(2)}%/st=${(w.st * 100).toFixed(1)}%  n=${w.n}  WR=${(w.wr * 100).toFixed(1)}%  Sh=${w.sh.toFixed(2)}  ret=${(w.ret * 100).toFixed(1)}%  PF=${w.pf.toFixed(2)}`,
        );
      }

      // Also report the best by Sharpe (might be sub-70% WR but still a win)
      const topBySharpe = rows
        .filter((r) => r.wr >= 0.65 && r.sh >= 1.0 && r.ret > 0)
        .sort((a, b) => b.sh - a.sh)
        .slice(0, 10);
      if (topBySharpe.length) {
        console.log("\n=== Top 10 configs with WR≥65% + Sh≥1 + ret>0 ===");
        for (const r of topBySharpe) {
          console.log(
            `  ${r.edge.padEnd(16)} ${r.filter.padEnd(10)} ${(r.tp * 100).toFixed(2)}/${(r.st * 100).toFixed(1)}  n=${r.n}  WR=${(r.wr * 100).toFixed(1)}%  Sh=${r.sh.toFixed(2)}  ret=${(r.ret * 100).toFixed(1)}%  PF=${r.pf.toFixed(2)}`,
          );
        }
      }
    },
  );
});
