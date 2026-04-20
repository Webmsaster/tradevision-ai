/**
 * Iter 151 — Alt-coin daytrade: last architectural frontier.
 *
 * BTC scans (iter145-150) all failed 5% mean at daytrade hold. Hypothesis:
 * higher-beta alt-coins have larger daily moves, so 5% TP within 24h may
 * be statistically reachable.
 *
 * Candidates (sorted by historical daily vol):
 *   DOGEUSDT — meme-coin, ~6-10% daily moves
 *   SOLUSDT — high-beta L1, ~5-7% daily
 *   AVAXUSDT — L1, ~5-7% daily
 *   LINKUSDT — ~4-6% daily
 *   XRPUSDT — ~3-5% daily (for reference)
 *
 * Scan (per asset): 4-mech ensemble, hold ≤ 24h, TP 3-15%, stop 1-5%.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

function smaLast(v: number[], n: number): number {
  if (v.length < n) return v[v.length - 1] ?? 0;
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function maxLast(v: number[], n: number): number {
  const s = v.slice(-n);
  let m = -Infinity;
  for (const x of s) if (x > m) m = x;
  return m;
}
function rsiSeries(closes: number[], len: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= len) return out;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss += -d;
  }
  gain /= len;
  loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (len - 1) + g) / len;
    loss = (loss * (len - 1) + l) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function sharpeOf(pnls: number[]): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(365 * 24);
}
function bootstrap(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): { pctPositive: number; p5: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, p5: 0 };
  let s = seed;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const rets: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sampled: number[] = [];
    const nBlocks = Math.ceil(pnls.length / blockLen);
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * Math.max(1, pnls.length - blockLen));
      for (let k = 0; k < blockLen; k++) sampled.push(pnls[start + k]);
    }
    const ret = sampled.reduce((a, p) => a * (1 + p), 1) - 1;
    rets.push(ret);
  }
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    pctPositive: rets.filter((r) => r > 0).length / rets.length,
    p5: sorted[Math.floor(sorted.length * 0.05)],
  };
}

type Mech = "M1" | "M4" | "M5" | "M6";
const PBASE = {
  htfLen: 168,
  macroBars: 720,
  nHi: 36,
  rsiTh: 42,
  redPct: 0.005,
  nDown: 2,
  capK: 4,
};

interface Ctx {
  closes: number[];
  highs: number[];
  r7: number[];
  trendMask: boolean[];
  macroMask: boolean[];
}
function mkCtx(candles: Candle[]): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const r7 = rsiSeries(closes, 7);
  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = PBASE.htfLen; i < candles.length; i++) {
    const s = smaLast(closes.slice(i - PBASE.htfLen, i), PBASE.htfLen);
    trendMask[i] = candles[i].close > s;
  }
  const macroMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = PBASE.macroBars; i < candles.length; i++) {
    const past = closes[i - PBASE.macroBars];
    if (past > 0) macroMask[i] = (closes[i] - past) / past > 0;
  }
  return { closes, highs, r7, trendMask, macroMask };
}

function fireM(candles: Candle[], ctx: Ctx, i: number, m: Mech): boolean {
  if (!ctx.trendMask[i] || !ctx.macroMask[i]) return false;
  switch (m) {
    case "M1":
      if (i < PBASE.nDown + 1) return false;
      for (let k = 0; k < PBASE.nDown; k++) {
        if (ctx.closes[i - k] >= ctx.closes[i - k - 1]) return false;
      }
      return true;
    case "M4":
      return ctx.r7[i] <= PBASE.rsiTh;
    case "M5":
      if (i < PBASE.nHi + 1) return false;
      return (
        candles[i].close > maxLast(ctx.highs.slice(i - PBASE.nHi, i), PBASE.nHi)
      );
    case "M6": {
      const o = candles[i].open;
      const c = candles[i].close;
      if (o <= 0) return false;
      return (c - o) / o <= -PBASE.redPct;
    }
  }
}

interface Trade {
  pnl: number;
  openBar: number;
}
function run(
  candles: Candle[],
  ctx: Ctx,
  tpPct: number,
  stopPct: number,
  hold: number,
): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  for (let i = PBASE.macroBars + 2; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= PBASE.capK) continue;
    for (const m of mechs) {
      if (open.length >= PBASE.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m)) continue;
      const eb = candles[i + 1];
      if (!eb) break;
      const entry = eb.open;
      const tp = entry * (1 + tpPct);
      const stop = entry * (1 - stopPct);
      const mx = Math.min(i + 1 + hold, candles.length - 1);
      let exitBar = mx;
      let exitPrice = candles[mx].close;
      for (let j = i + 2; j <= mx; j++) {
        const bar = candles[j];
        if (bar.low <= stop) {
          exitBar = j;
          exitPrice = stop;
          break;
        }
        if (bar.high >= tp) {
          exitBar = j;
          exitPrice = tp;
          break;
        }
      }
      const pnl = applyCosts({
        entry,
        exit: exitPrice,
        direction: "long",
        holdingHours: exitBar - (i + 1),
        config: MAKER_COSTS,
      }).netPnlPct;
      trades.push({ pnl: pnl / PBASE.capK, openBar: i });
      open.push({ exitBar, mech: m });
    }
  }
  return trades;
}

describe("iter 151 — alt-coin daytrade 5% hunt", () => {
  it(
    "scan high-vol alts on 1h with hold ≤ 24h for ≥ 5% mean",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 151: Alt-coin daytrade ===");
      const assets = ["DOGEUSDT", "SOLUSDT", "AVAXUSDT", "LINKUSDT", "XRPUSDT"];
      interface Row {
        sym: string;
        tp: number;
        stop: number;
        hold: number;
        n: number;
        wr: number;
        mean: number;
        sh: number;
        bsPos: number;
        dailyVol: number;
      }
      const results: Row[] = [];

      for (const sym of assets) {
        console.log(`\nloading ${sym}...`);
        const c = await loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 50_000,
          maxPages: 100,
        });
        const days = c.length / 24;
        console.log(`  ${c.length} candles = ${days.toFixed(0)} days`);

        // Estimate daily vol from ~200 recent bars
        const recentCloses = c.slice(-1000).map((x) => x.close);
        const logRets: number[] = [];
        for (let i = 1; i < recentCloses.length; i++) {
          if (recentCloses[i - 1] > 0) {
            logRets.push(Math.log(recentCloses[i] / recentCloses[i - 1]));
          }
        }
        const meanR = logRets.reduce((a, b) => a + b, 0) / logRets.length;
        const varR =
          logRets.reduce((a, b) => a + (b - meanR) * (b - meanR), 0) /
          logRets.length;
        const hourlyStd = Math.sqrt(varR);
        const dailyStd = hourlyStd * Math.sqrt(24);
        console.log(
          `  hourly std = ${(hourlyStd * 100).toFixed(3)}% → daily vol ≈ ${(dailyStd * 100).toFixed(2)}%`,
        );

        const ctx = mkCtx(c);

        for (const tp of [0.03, 0.05, 0.07, 0.1, 0.15]) {
          for (const stop of [0.01, 0.02, 0.03, 0.05]) {
            for (const hold of [12, 18, 24]) {
              const trades = run(c, ctx, tp, stop, hold);
              if (trades.length < 30) continue;
              const pnls = trades.map((t) => t.pnl);
              const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
              const wr = pnls.filter((p) => p > 0).length / pnls.length;
              const sh = sharpeOf(pnls);
              const bs = bootstrap(
                pnls,
                30,
                Math.max(5, Math.floor(pnls.length / 15)),
                Math.round(tp * 1000 + stop * 100 + hold),
              );
              results.push({
                sym,
                tp,
                stop,
                hold,
                n: trades.length,
                wr,
                mean,
                sh,
                bsPos: bs.pctPositive,
                dailyVol: dailyStd,
              });
            }
          }
        }
      }

      console.log(
        `\nTotal configs across all alts with n ≥ 30: ${results.length}`,
      );

      // Top 20 by mean
      const top = [...results].sort((a, b) => b.mean - a.mean).slice(0, 20);
      console.log("\n── Top 20 by mean ──");
      console.log(
        "sym       tp  stop  hold    n    WR     mean%    Sharpe  bs+   dailyVol",
      );
      for (const r of top) {
        const robust = r.bsPos >= 0.9 && r.n >= 50 ? "★" : " ";
        const at5 = r.mean >= 0.05 && r.bsPos >= 0.9 && r.n >= 50 ? " 5%!" : "";
        console.log(
          `${r.sym.padEnd(10)} ${(r.tp * 100).toFixed(0).padStart(2)}%  ${(r.stop * 100).toFixed(0).padStart(2)}%  ${r.hold.toString().padStart(3)}h ${r.n.toString().padStart(4)} ${(r.wr * 100).toFixed(1).padStart(5)}% ${(r.mean * 100).toFixed(2).padStart(6)}% ${r.sh.toFixed(2).padStart(6)} ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(r.dailyVol * 100).toFixed(1).padStart(5)}% ${robust}${at5}`,
        );
      }

      const fiveTarget = results.filter(
        (r) => r.mean >= 0.05 && r.bsPos >= 0.9 && r.n >= 50,
      );
      console.log(
        `\nConfigs meeting mean ≥ 5% AND bs+ ≥ 90% AND n ≥ 50: **${fiveTarget.length}**`,
      );
      if (fiveTarget.length > 0) {
        const best = fiveTarget.sort((a, b) => b.sh - a.sh)[0];
        console.log(
          `Best Sharpe at 5%: ${best.sym} tp=${(best.tp * 100).toFixed(0)}% s=${(best.stop * 100).toFixed(0)}% h=${best.hold}h → n=${best.n} WR=${(best.wr * 100).toFixed(1)}% mean=${(best.mean * 100).toFixed(2)}% Shp=${best.sh.toFixed(2)}`,
        );
      }

      // Per-asset best robust mean
      console.log("\n── Per-asset best robust mean ──");
      for (const sym of assets) {
        const best = results
          .filter((r) => r.sym === sym && r.bsPos >= 0.9 && r.n >= 50)
          .sort((a, b) => b.mean - a.mean)[0];
        if (best) {
          console.log(
            `${sym}: tp=${(best.tp * 100).toFixed(0)}% s=${(best.stop * 100).toFixed(0)}% h=${best.hold}h → mean=${(best.mean * 100).toFixed(2)}% Shp=${best.sh.toFixed(2)} n=${best.n}`,
          );
        } else {
          console.log(`${sym}: no robust config`);
        }
      }
    },
  );
});
