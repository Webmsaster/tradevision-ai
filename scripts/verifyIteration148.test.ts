/**
 * Iter 148 — weekly timeframe 5%-mean hunt.
 *
 * Last honest attempt before accepting the physical limit. 1w bars have
 * ~7× the amplitude of 1d bars. With hold ≤ 4 weeks, we get ~4× the
 * move-potential of iter147's 72h compromise. BTC weekly typical range:
 * 5-12% per bar in trending markets, up to 30%+ in volatile weeks.
 *
 * Scaled triggers:
 *   htfLen = 4 (4 weeks = ~1 month trend gate)
 *   macroBars = 12 (12 weeks = ~3 months macro gate)
 *   nHi = 2-4 (2-4 week breakout)
 *   nDown = 2 (2 consecutive red weeks = uncommon but strong pullback)
 *
 * Test:
 *   TP ∈ {5, 10, 15, 20, 30, 50, 75%}
 *   stop ∈ {2, 3, 5, 7, 10%}
 *   hold ∈ {1, 2, 3, 4, 6, 8} weeks
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
function sharpeOf(pnls: number[], barsPerYear: number): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(barsPerYear);
}
function bootstrap(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): { pctPositive: number; p5: number; medRet: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, p5: 0, medRet: 0 };
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
    medRet: sorted[Math.floor(sorted.length / 2)],
  };
}

type Mech = "M1" | "M4" | "M5" | "M6";
interface Params {
  htfLen: number;
  macroBars: number;
  nHi: number;
  rsiTh: number;
  redPct: number;
  nDown: number;
  capK: number;
  tpPct: number;
  stopPct: number;
  hold: number;
}

interface Ctx {
  closes: number[];
  highs: number[];
  r7: number[];
  trendMask: boolean[];
  macroMask: boolean[];
}
function mkCtx(candles: Candle[], p: Params): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const r7 = rsiSeries(closes, Math.min(7, candles.length - 1));
  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = p.htfLen; i < candles.length; i++) {
    const s = smaLast(closes.slice(i - p.htfLen, i), p.htfLen);
    trendMask[i] = candles[i].close > s;
  }
  const macroMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = p.macroBars; i < candles.length; i++) {
    const past = closes[i - p.macroBars];
    if (past > 0) macroMask[i] = (closes[i] - past) / past > 0;
  }
  return { closes, highs, r7, trendMask, macroMask };
}
function fireM(
  candles: Candle[],
  ctx: Ctx,
  i: number,
  m: Mech,
  p: Params,
): boolean {
  if (!ctx.trendMask[i] || !ctx.macroMask[i]) return false;
  switch (m) {
    case "M1":
      if (i < p.nDown + 1) return false;
      for (let k = 0; k < p.nDown; k++) {
        if (ctx.closes[i - k] >= ctx.closes[i - k - 1]) return false;
      }
      return true;
    case "M4":
      return ctx.r7[i] <= p.rsiTh;
    case "M5":
      if (i < p.nHi + 1) return false;
      return candles[i].close > maxLast(ctx.highs.slice(i - p.nHi, i), p.nHi);
    case "M6": {
      const o = candles[i].open;
      const c = candles[i].close;
      if (o <= 0) return false;
      return (c - o) / o <= -p.redPct;
    }
  }
}

interface Trade {
  pnl: number;
  openBar: number;
}
function executeLong(
  candles: Candle[],
  i: number,
  p: Params,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp = entry * (1 + p.tpPct);
  const stop = entry * (1 - p.stopPct);
  const mx = Math.min(i + 1 + p.hold, candles.length - 1);
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
  const holdingHours = (exitBar - (i + 1)) * 24 * 7; // 1w bars
  const pnl = applyCosts({
    entry,
    exit: exitPrice,
    direction: "long",
    holdingHours,
    config: MAKER_COSTS,
  }).netPnlPct;
  return { exitBar, pnl };
}
function run(candles: Candle[], ctx: Ctx, p: Params): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  const startAt = Math.max(p.htfLen, p.macroBars, p.nHi + 1) + 1;
  for (let i = startAt; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= p.capK) continue;
    for (const m of mechs) {
      if (open.length >= p.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m, p)) continue;
      const r = executeLong(candles, i, p);
      if (!r) continue;
      trades.push({ pnl: r.pnl, openBar: i });
      open.push({ exitBar: r.exitBar, mech: m });
    }
  }
  return trades;
}

describe("iter 148 — weekly 5%-mean hunt", () => {
  it("scan 1w BTC bars wide grid", { timeout: 600_000 }, async () => {
    console.log("\n=== ITER 148: Weekly 5% hunt ===");
    const c = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1w",
      targetCount: 500,
      maxPages: 100,
    });
    const weeks = c.length;
    const years = weeks / 52;
    console.log(`loaded ${weeks} 1w candles (${years.toFixed(1)} years)`);

    const baseP = {
      htfLen: 4,
      macroBars: 12,
      nHi: 3,
      rsiTh: 45,
      redPct: 0.03,
      nDown: 2,
      capK: 4,
    };

    interface Row {
      tp: number;
      stop: number;
      hold: number;
      n: number;
      mean: number;
      wr: number;
      sh: number;
      bsPos: number;
      bs5: number;
    }
    const results: Row[] = [];

    for (const tp of [0.05, 0.1, 0.15, 0.2, 0.3, 0.5]) {
      for (const stop of [0.02, 0.03, 0.05, 0.07, 0.1]) {
        for (const hold of [1, 2, 3, 4, 6, 8]) {
          const p: Params = { ...baseP, tpPct: tp, stopPct: stop, hold };
          const ctx = mkCtx(c, p);
          const trades = run(c, ctx, p);
          if (trades.length < 20) continue;
          const pnls = trades.map((t) => t.pnl);
          const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
          const wr = pnls.filter((p) => p > 0).length / pnls.length;
          const sh = sharpeOf(pnls, 52);
          const bs = bootstrap(
            pnls,
            30,
            Math.max(3, Math.floor(pnls.length / 15)),
            Math.round(tp * 1000 + stop * 100 + hold),
          );
          results.push({
            tp,
            stop,
            hold,
            n: trades.length,
            mean,
            wr,
            sh,
            bsPos: bs.pctPositive,
            bs5: bs.p5,
          });
        }
      }
    }

    const top = [...results].sort((a, b) => b.mean - a.mean).slice(0, 25);
    console.log("\n── Top 25 by mean (1w bars, hold 1-8 weeks) ──");
    console.log("tp   stop hold   n    mean%    WR     Sharpe  bs+   bs5%");
    for (const r of top) {
      const robust = r.bsPos >= 0.9 && r.n >= 30 ? "★" : " ";
      const at5 = r.mean >= 0.05 && r.bsPos >= 0.9 && r.n >= 30 ? " 5%!" : "";
      console.log(
        `${(r.tp * 100).toFixed(0).padStart(2)}%  ${(r.stop * 100).toFixed(1).padStart(4)}% ${r.hold.toString().padStart(3)}w  ${r.n.toString().padStart(3)} ${(r.mean * 100).toFixed(2).padStart(6)}% ${(r.wr * 100).toFixed(1).padStart(5)}% ${r.sh.toFixed(2).padStart(6)} ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(r.bs5 * 100).toFixed(1).padStart(6)}% ${robust}${at5}`,
      );
    }

    const fiveTarget = results.filter(
      (r) => r.mean >= 0.05 && r.bsPos >= 0.9 && r.n >= 30,
    );
    console.log(
      `\nConfigs meeting mean ≥ 5% AND bs+ ≥ 90% AND n ≥ 30: **${fiveTarget.length}**`,
    );
    if (fiveTarget.length > 0) {
      const best = fiveTarget.sort((a, b) => b.sh - a.sh)[0];
      console.log(
        `Best Sharpe: tp=${(best.tp * 100).toFixed(0)}% s=${(best.stop * 100).toFixed(1)}% h=${best.hold}w → n=${best.n} mean=${(best.mean * 100).toFixed(2)}% WR=${(best.wr * 100).toFixed(1)}% Shp=${best.sh.toFixed(2)} bs+=${(best.bsPos * 100).toFixed(0)}%`,
      );
    }
  });
});
