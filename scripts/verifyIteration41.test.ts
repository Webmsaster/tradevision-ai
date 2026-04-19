/**
 * Iter 41: Portfolio sizing comparison.
 *
 *   1. Equal-weight (1/N) baseline
 *   2. Inverse-vol weight  (1/σ_i normalised)
 *   3. Quarter-Kelly  (0.25 × μ/σ², capped at 25% per strategy)
 *   4. Sharpe-tilt + correlation haircut (Lopez de Prado HRP heuristic)
 *
 * Compare Sharpe, return, drawdown across 7 locked Volume-Spike edges
 * over the 416-day common window.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runVolumeSpikeFade } from "../src/utils/volumeSpikeFade";
import {
  LOCKED_EDGES,
  lockedEdgeBinanceSymbol,
} from "../src/utils/volumeSpikeSignal";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const DAY_MS = 86_400_000;

function tradesToDailyReturns(
  trades: { exitTime: number; netPnlPct: number }[],
  startTime: number,
  endTime: number,
): number[] {
  const days = Math.max(1, Math.floor((endTime - startTime) / DAY_MS));
  const out = new Array(days).fill(0);
  for (const t of trades) {
    const d = Math.floor((t.exitTime - startTime) / DAY_MS);
    if (d >= 0 && d < days) out[d] += t.netPnlPct;
  }
  return out;
}

function annualise(daily: number[]): {
  mean: number;
  sd: number;
  sharpe: number;
} {
  const m = daily.reduce((s, v) => s + v, 0) / daily.length;
  const v = daily.reduce((s, x) => s + (x - m) * (x - m), 0) / daily.length;
  const sd = Math.sqrt(v);
  const meanA = m * 365;
  const sdA = sd * Math.sqrt(365);
  const sharpe = sdA > 0 ? meanA / sdA : 0;
  return { mean: meanA, sd: sdA, sharpe };
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  let sa = 0,
    sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n,
    mb = sb / n;
  let cov = 0,
    va = 0,
    vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma,
      db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

function portfolio(
  seriesList: number[][],
  weights: number[],
): { daily: number[]; sharpe: number; netRet: number; maxDd: number } {
  const days = seriesList[0].length;
  const daily = new Array(days).fill(0);
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < seriesList.length; i++)
      daily[d] += weights[i] * seriesList[i][d];
  }
  const ann = annualise(daily);
  const eq = [1];
  for (const r of daily) eq.push(eq[eq.length - 1] * (1 + r));
  const netRet = eq[eq.length - 1] - 1;
  let peak = 1,
    maxDd = 0;
  for (const e of eq) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return { daily, sharpe: ann.sharpe, netRet, maxDd };
}

describe("iteration 41 — portfolio sizing comparison", () => {
  it(
    "equal-weight vs inv-vol vs quarter-Kelly vs Sharpe+haircut",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 41: PORTFOLIO SIZING COMPARISON ===");

      const uniqueSyms = Array.from(
        new Set(LOCKED_EDGES.map((e) => lockedEdgeBinanceSymbol(e.symbol))),
      );
      const candlesBy: Record<string, Candle[]> = {};
      for (const s of uniqueSyms) {
        candlesBy[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "1h",
          targetCount: 10000,
        });
      }
      const minStart = Math.max(
        ...uniqueSyms.map((s) => candlesBy[s][0].openTime),
      );
      const maxEnd = Math.min(
        ...uniqueSyms.map(
          (s) => candlesBy[s][candlesBy[s].length - 1].closeTime,
        ),
      );
      console.log(`Window: ${Math.floor((maxEnd - minStart) / DAY_MS)} days`);

      interface Series {
        label: string;
        daily: number[];
        meanA: number;
        sdA: number;
        sharpe: number;
      }
      const series: Series[] = [];
      for (const edge of LOCKED_EDGES) {
        const sym = lockedEdgeBinanceSymbol(edge.symbol);
        const candles = candlesBy[sym];
        const slice = candles.filter(
          (c) => c.openTime >= minStart && c.closeTime <= maxEnd,
        );
        const rep = runVolumeSpikeFade(slice, {
          ...edge.cfg,
          costs: MAKER_COSTS,
        });
        const daily = tradesToDailyReturns(rep.trades, minStart, maxEnd);
        const { mean, sd, sharpe } = annualise(daily);
        series.push({
          label: `${sym.replace("USDT", "")} ${edge.cfg.mode}`,
          daily,
          meanA: mean,
          sdA: sd,
          sharpe,
        });
      }

      const N = series.length;
      const seriesData = series.map((s) => s.daily);

      // 1. Equal weight
      const wEq = new Array(N).fill(1 / N);
      const pEq = portfolio(seriesData, wEq);

      // 2. Inverse-vol weight
      const invVol = series.map((s) => (s.sdA > 0 ? 1 / s.sdA : 0));
      const sumIv = invVol.reduce((a, b) => a + b, 0);
      const wIv = invVol.map((v) => (sumIv > 0 ? v / sumIv : 1 / N));
      const pIv = portfolio(seriesData, wIv);

      // 3. Quarter-Kelly
      const kelly = series.map((s) =>
        s.sdA > 0 ? Math.max(0, s.meanA / (s.sdA * s.sdA)) : 0,
      );
      const qKelly = kelly.map((k) => Math.min(0.25, 0.25 * k));
      const sumQk = qKelly.reduce((a, b) => a + b, 0);
      const wKelly =
        sumQk > 0 ? qKelly.map((k) => k / sumQk) : new Array(N).fill(1 / N);
      const pKelly = portfolio(seriesData, wKelly);

      // 4. Sharpe-tilt × correlation haircut + 25% cap
      const corrAvg = (i: number) => {
        let sum = 0,
          c = 0;
        for (let j = 0; j < N; j++)
          if (j !== i) {
            sum += Math.max(0, pearson(series[i].daily, series[j].daily));
            c++;
          }
        return c > 0 ? sum / c : 0;
      };
      const tilt = series.map(
        (s, i) =>
          Math.max(0, Math.sqrt(Math.max(0, s.sharpe))) *
          (1 - 0.5 * corrAvg(i)),
      );
      const tiltCapped = tilt.map((t) => Math.min(0.25, t));
      const sumT = tiltCapped.reduce((a, b) => a + b, 0);
      const wTilt =
        sumT > 0 ? tiltCapped.map((t) => t / sumT) : new Array(N).fill(1 / N);
      const pTilt = portfolio(seriesData, wTilt);

      console.log("\nStrategy stats (annualised):");
      console.log(
        "  label".padEnd(18) +
          "meanA".padStart(8) +
          "sdA".padStart(8) +
          "Sharpe".padStart(8) +
          "Kelly".padStart(8),
      );
      for (const s of series) {
        console.log(
          "  " +
            s.label.padEnd(16) +
            (s.meanA * 100).toFixed(0).padStart(7) +
            "%" +
            (s.sdA * 100).toFixed(0).padStart(7) +
            "%" +
            s.sharpe.toFixed(2).padStart(8) +
            (s.meanA / Math.max(0.0001, s.sdA * s.sdA)).toFixed(1).padStart(8),
        );
      }

      function showWeights(name: string, w: number[]) {
        console.log(`\n${name}:`);
        for (let i = 0; i < N; i++)
          console.log(
            `  ${series[i].label.padEnd(16)} → ${(w[i] * 100).toFixed(1)}%`,
          );
      }
      showWeights("Equal-weight", wEq);
      showWeights("Inverse-vol", wIv);
      showWeights("Quarter-Kelly (capped 25%)", wKelly);
      showWeights("Sharpe-tilt + corr haircut (capped 25%)", wTilt);

      console.log("\n=== PORTFOLIO COMPARISON ===");
      console.log(
        "scheme".padEnd(38) +
          "Sharpe".padStart(8) +
          "ret%".padStart(8) +
          "DD%".padStart(8),
      );
      const rows = [
        { name: "Equal-weight", p: pEq },
        { name: "Inverse-vol", p: pIv },
        { name: "Quarter-Kelly (capped)", p: pKelly },
        { name: "Sharpe-tilt + corr haircut", p: pTilt },
      ];
      for (const r of rows) {
        console.log(
          r.name.padEnd(38) +
            r.p.sharpe.toFixed(2).padStart(8) +
            (r.p.netRet * 100).toFixed(1).padStart(8) +
            (r.p.maxDd * 100).toFixed(1).padStart(8),
        );
      }
    },
  );
});
