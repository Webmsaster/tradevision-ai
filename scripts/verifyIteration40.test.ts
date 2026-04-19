/**
 * Iter 40: Correlation matrix of the 7 locked volume-spike edges.
 *
 * Each strategy's trade list converted to a daily P&L vector over the
 * common 14-month backtest window. Pairwise Pearson correlation indicates
 * portfolio diversification potential. Independent edges (corr < 0.3)
 * combine well; highly correlated edges (corr > 0.7) double down on
 * the same risk.
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

describe("iteration 40 — locked-edges correlation matrix", () => {
  it(
    "pairwise Pearson on daily P&L vectors",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 40: CORRELATION MATRIX OF LOCKED EDGES ===");

      // Fetch candles per unique Binance symbol
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

      // Common time window across all edges
      const minStart = Math.max(
        ...uniqueSyms.map((s) => candlesBy[s][0].openTime),
      );
      const maxEnd = Math.min(
        ...uniqueSyms.map(
          (s) => candlesBy[s][candlesBy[s].length - 1].closeTime,
        ),
      );
      const windowDays = Math.floor((maxEnd - minStart) / DAY_MS);
      console.log(`Common window: ${windowDays} days`);

      // Build daily-P&L series per edge
      const series: {
        label: string;
        daily: number[];
        sharpe: number;
        netRet: number;
        trades: number;
      }[] = [];
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
        // Strategy-level Sharpe on daily series
        const m = daily.reduce((s, v) => s + v, 0) / Math.max(1, daily.length);
        const v =
          daily.reduce((s, x) => s + (x - m) * (x - m), 0) /
          Math.max(1, daily.length);
        const sd = Math.sqrt(v);
        const sharpe = sd > 0 ? (m / sd) * Math.sqrt(365) : 0;
        const netRet = daily.reduce((acc, r) => acc * (1 + r), 1) - 1;
        const label = `${sym.replace("USDT", "")} ${edge.cfg.mode}`;
        series.push({
          label,
          daily,
          sharpe,
          netRet,
          trades: rep.trades.length,
        });
        console.log(
          `  ${label.padEnd(16)}  trades=${rep.trades.length.toString().padStart(4)}  daily-Sharpe=${sharpe.toFixed(2)}  net=${(netRet * 100).toFixed(1)}%`,
        );
      }

      console.log("\n=== PAIRWISE CORRELATION (Pearson on daily P&L) ===");
      const header =
        "".padEnd(16) + series.map((s) => s.label.padEnd(10)).join("");
      console.log(header);
      for (let i = 0; i < series.length; i++) {
        const cells = series.map((_, j) => {
          if (j === i) return "  1.00    ";
          const c = pearson(series[i].daily, series[j].daily);
          return `  ${c >= 0 ? "+" : "-"}${Math.abs(c).toFixed(2)}    `;
        });
        console.log(series[i].label.padEnd(16) + cells.join(""));
      }

      // Average pairwise correlation
      let sum = 0,
        n = 0;
      for (let i = 0; i < series.length; i++)
        for (let j = i + 1; j < series.length; j++) {
          sum += pearson(series[i].daily, series[j].daily);
          n++;
        }
      const avg = n > 0 ? sum / n : 0;
      console.log(
        `\nAvg pairwise corr: ${avg.toFixed(2)}  →  diversification benefit ≈ ${((1 - avg) * 100).toFixed(0)}%`,
      );

      // Equal-weight portfolio baseline
      const portDaily = new Array(series[0].daily.length).fill(0);
      for (let d = 0; d < portDaily.length; d++) {
        let s = 0;
        for (const ser of series) s += ser.daily[d];
        portDaily[d] = s / series.length;
      }
      const pm = portDaily.reduce((s, v) => s + v, 0) / portDaily.length;
      const pv =
        portDaily.reduce((s, x) => s + (x - pm) * (x - pm), 0) /
        portDaily.length;
      const psd = Math.sqrt(pv);
      const pSharpe = psd > 0 ? (pm / psd) * Math.sqrt(365) : 0;
      const pNet = portDaily.reduce((a, r) => a * (1 + r), 1) - 1;
      let peak = 1,
        dd = 0;
      let eq = 1;
      for (const r of portDaily) {
        eq *= 1 + r;
        if (eq > peak) peak = eq;
        const cur = (peak - eq) / peak;
        if (cur > dd) dd = cur;
      }
      console.log(
        `\nEqual-weight portfolio: Sharpe=${pSharpe.toFixed(2)}  net=${(pNet * 100).toFixed(1)}%  maxDD=${(dd * 100).toFixed(1)}%`,
      );

      // Save daily series to console for potential further inspection
      console.log(`\nWindow days: ${portDaily.length}`);
    },
  );
});
