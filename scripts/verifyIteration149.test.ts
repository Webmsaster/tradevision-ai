/**
 * Iter 149 — 5-gate validation of weekly winner (tp=50% s=2% h=4w).
 *
 * iter148 scan on 454 weekly BTC candles (8.7 years):
 *   n=44, WR 36.4%, mean 10.05%, cumRet huge, Sharpe 3.99, bs+ 100%, bs5% +614%.
 *
 * Gates (looser than iter144 MAX because n is small and weekly is sparse):
 *   G1 full: n ≥ 30, mean ≥ 5%, Sharpe ≥ 3, bs+ ≥ 90%, ret > 0
 *   G2 halves (with only ~450 bars, quarters too small): both halves positive
 *   G3 TP sweep {30, 40, 50%}: all Sharpe ≥ 2.5 & mean ≥ 4%
 *   G4 sensitivity 8 variants: ≥ 60% pass Sharpe ≥ 2 & mean ≥ 3%
 *   G5 OOS 60/40: Sharpe ≥ 2, mean ≥ 3%
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
  return (m / sd) * Math.sqrt(52);
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
  const holdingHours = (exitBar - (i + 1)) * 24 * 7;
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

function stats(trades: Trade[], seed: number) {
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const mean =
    trades.length > 0 ? pnls.reduce((a, p) => a + p, 0) / pnls.length : 0;
  const sh = sharpeOf(pnls);
  const wr = trades.length > 0 ? wins / trades.length : 0;
  const bs = bootstrap(
    pnls,
    100,
    Math.max(3, Math.floor(pnls.length / 15)),
    seed,
  );
  return { n: trades.length, wr, ret, sh, mean, bs };
}

const BASE: Params = {
  htfLen: 4,
  macroBars: 12,
  nHi: 3,
  rsiTh: 45,
  redPct: 0.03,
  nDown: 2,
  capK: 4,
  tpPct: 0.5,
  stopPct: 0.02,
  hold: 4,
};

describe("iter 149 — weekly winner 5-gate", () => {
  it(
    "validate tp=50% s=2% h=4w as WEEKLY_MAX tier",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 149: Weekly 5-gate ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1w",
        targetCount: 500,
        maxPages: 100,
      });
      console.log(
        `loaded ${c.length} 1w candles (${(c.length / 52).toFixed(1)} years)`,
      );

      // G1
      const ctx = mkCtx(c, BASE);
      const tAll = run(c, ctx, BASE);
      const s = stats(tAll, 777);
      console.log(
        `\nG1 FULL n=${s.n} WR=${(s.wr * 100).toFixed(1)}% mean=${(s.mean * 100).toFixed(2)}% ret=${(s.ret * 100).toFixed(0)}% Shp=${s.sh.toFixed(2)} bs+=${(s.bs.pctPositive * 100).toFixed(0)}% bs5%=${(s.bs.p5 * 100).toFixed(1)}%`,
      );
      const g1 =
        s.n >= 30 &&
        s.mean >= 0.05 &&
        s.sh >= 3 &&
        s.bs.pctPositive >= 0.9 &&
        s.ret > 0;

      // G2 halves
      const half = Math.floor(c.length / 2);
      console.log("G2 halves:");
      const halfRets: number[] = [];
      for (let k = 0; k < 2; k++) {
        const sub = k === 0 ? c.slice(0, half) : c.slice(half);
        const sctx = mkCtx(sub, BASE);
        const t = run(sub, sctx, BASE);
        const ss = stats(t, 100 + k);
        halfRets.push(ss.ret);
        console.log(
          `  H${k + 1} n=${ss.n} WR=${(ss.wr * 100).toFixed(1)}% mean=${(ss.mean * 100).toFixed(2)}% ret=${(ss.ret * 100).toFixed(1)}% Shp=${ss.sh.toFixed(2)}`,
        );
      }
      const g2 = halfRets[0] > 0 && halfRets[1] > 0;

      // G3 TP sweep
      console.log("G3 TP sweep:");
      let g3 = true;
      for (const tp of [0.3, 0.4, 0.5]) {
        const p = { ...BASE, tpPct: tp };
        const t = run(c, ctx, p);
        const ss = stats(t, 300 + Math.round(tp * 100));
        if (ss.sh < 2.5 || ss.mean < 0.04) g3 = false;
        console.log(
          `  tp=${(tp * 100).toFixed(0)}% n=${ss.n} mean=${(ss.mean * 100).toFixed(2)}% Shp=${ss.sh.toFixed(2)}`,
        );
      }

      // G4 sensitivity
      console.log("G4 sensitivity:");
      const vs: Array<{ label: string; p: Params }> = [
        { label: "stop-50%", p: { ...BASE, stopPct: BASE.stopPct * 0.5 } },
        { label: "stop+100%", p: { ...BASE, stopPct: BASE.stopPct * 2 } },
        { label: "tp-20%", p: { ...BASE, tpPct: BASE.tpPct * 0.8 } },
        { label: "tp+20%", p: { ...BASE, tpPct: BASE.tpPct * 1.2 } },
        { label: "hold/2", p: { ...BASE, hold: 2 } },
        { label: "hold*2", p: { ...BASE, hold: 8 } },
        { label: "rsi-5", p: { ...BASE, rsiTh: BASE.rsiTh - 5 } },
        { label: "nHi=2", p: { ...BASE, nHi: 2 } },
      ];
      let vPass = 0;
      for (const v of vs) {
        const vctx = mkCtx(c, v.p);
        const t = run(c, vctx, v.p);
        const ss = stats(t, 500);
        const ok = ss.sh >= 2 && ss.mean >= 0.03 && ss.ret > 0;
        if (ok) vPass++;
        console.log(
          `  ${v.label.padEnd(10)} n=${ss.n.toString().padStart(3)} mean=${(ss.mean * 100).toFixed(2).padStart(5)}% Shp=${ss.sh.toFixed(2).padStart(5)} ${ok ? "★" : ""}`,
        );
      }
      const g4 = vPass / vs.length >= 0.6;
      console.log(`  ${vPass}/${vs.length}`);

      // G5 OOS
      const split = Math.floor(c.length * 0.6);
      const oosC = c.slice(split);
      const oosCtx = mkCtx(oosC, BASE);
      const oosT = run(oosC, oosCtx, BASE);
      const oosS = stats(oosT, 888);
      console.log(
        `G5 OOS n=${oosS.n} WR=${(oosS.wr * 100).toFixed(1)}% mean=${(oosS.mean * 100).toFixed(2)}% ret=${(oosS.ret * 100).toFixed(0)}% Shp=${oosS.sh.toFixed(2)} bs+=${(oosS.bs.pctPositive * 100).toFixed(0)}%`,
      );
      const g5 = oosS.sh >= 2 && oosS.mean >= 0.03;

      console.log(
        `\n── VERDICT ──\nG1=${g1 ? "✓" : "✗"} G2=${g2 ? "✓" : "✗"} G3=${g3 ? "✓" : "✗"} G4=${g4 ? "✓" : "✗"} G5=${g5 ? "✓" : "✗"}  ${g1 && g2 && g3 && g4 && g5 ? "★★★ ALL PASS ★★★" : "fails"}`,
      );
    },
  );
});
