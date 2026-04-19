/**
 * Iter 52: Forensic analysis of iter50 bad bootstrap windows.
 *
 * iter50-A (tp1=0.5/tp2=4.0/stM=2.2 htf+micro+avoid) scored medWR 77.4%
 * but two of 19 windows came in with WR below 70%:
 *   - chrono-window 9 (last 25% of history): WR 69.2%, 13 trades
 *   - bootstrap-window 14: WR 72.2%, 18 trades, ret -1.3%, sh -0.19
 *
 * This iteration prints per-window context (vol-percentile, trend direction,
 * trade spacing) to find what separates the bad windows from the good ones.
 * The hypothesis is that bad windows coincide with:
 *   (a) very low realised vol (boring chop — trigger fires on noise)
 *   (b) sharp trend-against-you (HTF filter fails to exclude these)
 *
 * If we can identify the feature, iter53 adds a filter that removes those
 * samples entirely — raising the minimum WR above 70%.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runHighWrScaleOut,
  HIGH_WR_SUI_MOM_CONFIG,
  type HighWrConfig,
} from "../src/utils/highWrScaleOut";
import type { Candle } from "../src/utils/indicators";

function chronoSplits(
  candles: Candle[],
): Array<{ label: string; data: Candle[] }> {
  const cuts = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  return cuts.map((r) => {
    const cut = Math.floor(candles.length * r);
    return { label: `chrono${(r * 100).toFixed(0)}`, data: candles.slice(cut) };
  });
}

function blockBootstrap(
  candles: Candle[],
  blockBars: number,
  n: number,
  seed: number,
): Candle[] {
  const blocks: Candle[][] = [];
  for (let i = 0; i + blockBars <= candles.length; i += blockBars) {
    blocks.push(candles.slice(i, i + blockBars));
  }
  let s = seed;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked: Candle[] = [];
  const want = Math.min(n, blocks.length);
  const used = new Set<number>();
  while (picked.length < want * blockBars) {
    const idx = Math.floor(rand() * blocks.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(...blocks[idx]);
  }
  let t = candles[0]?.openTime ?? 0;
  return picked.map((c) => {
    const out = { ...c, openTime: t, closeTime: t + 3_599_999 };
    t += 3_600_000;
    return out;
  });
}

function realizedVolAnnual(closes: number[]): number {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue;
    r.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  // 1h bars → annualised stdev
  return Math.sqrt(v) * Math.sqrt(24 * 365);
}

function trendSlope(closes: number[]): number {
  if (closes.length < 10) return 0;
  // linear regression slope (normalised by mean price) on last N closes
  const N = Math.min(closes.length, 500);
  const slice = closes.slice(-N);
  const meanP = slice.reduce((s, v) => s + v, 0) / N;
  let num = 0;
  let den = 0;
  const meanX = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    num += (i - meanX) * (slice[i] - meanP);
    den += (i - meanX) * (i - meanX);
  }
  return num / den / meanP; // per-bar slope as fraction of mean price
}

describe("iteration 52 — forensic per-window analysis", () => {
  it("print window features", { timeout: 600_000 }, async () => {
    console.log("\n=== ITER 52: PER-WINDOW FEATURES ===");
    const candles = await loadBinanceHistory({
      symbol: "SUIUSDT",
      timeframe: "1h",
      targetCount: 10000,
    });
    const cfg: HighWrConfig = HIGH_WR_SUI_MOM_CONFIG;

    const windows: Array<{ label: string; data: Candle[] }> = [
      ...chronoSplits(candles),
    ];
    for (let i = 0; i < 8; i++) {
      windows.push({
        label: `boot${i}`,
        data: blockBootstrap(candles, 720, 6, 1234 + i * 17),
      });
    }

    console.log(
      "\n" +
        "window".padEnd(12) +
        "bars".padStart(6) +
        "days".padStart(6) +
        "trd".padStart(5) +
        "WR%".padStart(7) +
        "ret%".padStart(8) +
        "Sh".padStart(7) +
        "rv_ann".padStart(8) +
        "trendSlope".padStart(12) +
        " direction",
    );

    const rows: Array<{
      label: string;
      trades: number;
      wr: number;
      ret: number;
      sh: number;
      rv: number;
      slope: number;
    }> = [];

    for (const w of windows) {
      const r = runHighWrScaleOut(w.data, cfg);
      const closes = w.data.map((c) => c.close);
      const rv = realizedVolAnnual(closes);
      const slope = trendSlope(closes);
      const dir = slope > 0.00005 ? "UP" : slope < -0.00005 ? "DOWN" : "flat";
      const days = w.data.length / 24;
      console.log(
        w.label.padEnd(12) +
          w.data.length.toString().padStart(6) +
          days.toFixed(0).padStart(6) +
          r.trades.length.toString().padStart(5) +
          (r.winRate * 100).toFixed(1).padStart(7) +
          (r.netReturnPct * 100).toFixed(1).padStart(8) +
          r.sharpe.toFixed(2).padStart(7) +
          (rv * 100).toFixed(1).padStart(8) +
          (slope * 1e6).toFixed(2).padStart(12) +
          "  " +
          dir,
      );
      rows.push({
        label: w.label,
        trades: r.trades.length,
        wr: r.winRate,
        ret: r.netReturnPct,
        sh: r.sharpe,
        rv,
        slope,
      });
    }

    // Separate into GOOD (WR >= 70%) vs BAD
    const good = rows.filter((r) => r.wr >= 0.7);
    const bad = rows.filter((r) => r.wr < 0.7);
    console.log(
      `\nGOOD (WR≥70): ${good.length}  |  BAD (WR<70): ${bad.length}`,
    );

    function mean(a: number[]) {
      return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    }
    console.log(
      `  mean rv_ann:  GOOD=${(mean(good.map((r) => r.rv)) * 100).toFixed(1)}%  BAD=${(mean(bad.map((r) => r.rv)) * 100).toFixed(1)}%`,
    );
    console.log(
      `  mean slope (×1e6):  GOOD=${(mean(good.map((r) => r.slope)) * 1e6).toFixed(2)}  BAD=${(mean(bad.map((r) => r.slope)) * 1e6).toFixed(2)}`,
    );
    console.log(
      `  mean trades:  GOOD=${mean(good.map((r) => r.trades)).toFixed(1)}  BAD=${mean(bad.map((r) => r.trades)).toFixed(1)}`,
    );
  });
});
