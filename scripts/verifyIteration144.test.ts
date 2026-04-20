/**
 * Iter 144 — 5-gate validation for MAX-tier (mean ≥ 5% per trade).
 *
 * iter143 top candidates (1d BTC, 3000 days):
 *   A: tp=60% s=5% h=40  → n=178, WR 30.9%, **mean 5.79%**, Shp 5.64, bs+ 100%, bs5% +1997%, pctProf 60%
 *   B: tp=50% s=15% h=30 → n=158, WR 50.6%, **mean 5.61%**, Shp 5.39, bs+ 98%, bs5% +202%, pctProf 60%
 *   C: tp=60% s=7% h=60  → n=147, WR 32.0%, **mean 6.39%**, Shp 5.35, bs+ 96%, bs5% +35%
 *
 * Gates (tightened for MAX-tier — high per-trade mean implies high variance):
 *   G1 full: n ≥ 120, mean ≥ 5%, Sharpe ≥ 4, bs+ ≥ 90%, ret > 0, pctProf ≥ 50%
 *   G2 quarters: Q1-3 positive, Q4 ≥ -30% (allow swing DD)
 *   G3 TP sweep {45%, 50%, 60%}: all Sharpe ≥ 3.5 & mean ≥ 4%
 *   G4 sensitivity 10 variants: ≥ 60% pass Sharpe ≥ 3 & mean ≥ 3%
 *   G5 OOS 60/40: Sharpe ≥ 2.5, mean ≥ 3%
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_YEAR = 365;

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
  return (m / sd) * Math.sqrt(BARS_PER_YEAR);
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
  const r7 = rsiSeries(closes, 7);
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
  const holdingHours = (exitBar - (i + 1)) * 24;
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

function stats(trades: Trade[], days: number, bpw: number, seed: number) {
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const mean =
    trades.length > 0 ? pnls.reduce((a, p) => a + p, 0) / pnls.length : 0;
  const sh = sharpeOf(pnls);
  const tpd = trades.length / days;
  const wr = trades.length > 0 ? wins / trades.length : 0;
  const winRet: number[] = [];
  for (let w = 0; w < 10; w++) {
    const lo = w * bpw;
    const hi = (w + 1) * bpw;
    const wt = trades.filter((t) => t.openBar >= lo && t.openBar < hi);
    winRet.push(wt.reduce((a, t) => a * (1 + t.pnl), 1) - 1);
  }
  const pctProf = winRet.filter((r) => r > 0).length / winRet.length;
  const minWin = Math.min(...winRet);
  const bs = bootstrap(
    pnls,
    100,
    Math.max(5, Math.floor(pnls.length / 15)),
    seed,
  );
  return { n: trades.length, tpd, wr, ret, sh, mean, pctProf, minWin, bs };
}

const CANDIDATES: Array<{ label: string; p: Params }> = [
  {
    label: "MAX-A tp=60% s=5% h=40",
    p: {
      htfLen: 7,
      macroBars: 30,
      nHi: 3,
      rsiTh: 42,
      redPct: 0.01,
      nDown: 2,
      capK: 4,
      tpPct: 0.6,
      stopPct: 0.05,
      hold: 40,
    },
  },
  {
    label: "MAX-B tp=50% s=15% h=30",
    p: {
      htfLen: 7,
      macroBars: 30,
      nHi: 3,
      rsiTh: 42,
      redPct: 0.01,
      nDown: 2,
      capK: 4,
      tpPct: 0.5,
      stopPct: 0.15,
      hold: 30,
    },
  },
  {
    label: "MAX-C tp=60% s=7% h=40",
    p: {
      htfLen: 7,
      macroBars: 30,
      nHi: 3,
      rsiTh: 42,
      redPct: 0.01,
      nDown: 2,
      capK: 4,
      tpPct: 0.6,
      stopPct: 0.07,
      hold: 40,
    },
  },
];

describe("iter 144 — 5-gate MAX-tier validation", () => {
  it(
    "full battery on 3 candidates for mean ≥ 5% per trade",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 144: MAX-tier 5-gate ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1d",
        targetCount: 3000,
        maxPages: 100,
      });
      const days = c.length;
      const bpw = Math.floor(c.length / 10);
      console.log(
        `loaded ${c.length} 1d candles (${(days / 365).toFixed(1)} years)`,
      );

      const verdicts: Record<string, boolean> = {};
      for (const cand of CANDIDATES) {
        console.log(`\n════════ ${cand.label} ════════`);
        const ctx = mkCtx(c, cand.p);
        const tAll = run(c, ctx, cand.p);
        const s = stats(tAll, days, bpw, 777);
        console.log(
          `G1 FULL n=${s.n} tpd=${s.tpd.toFixed(3)} WR=${(s.wr * 100).toFixed(1)}% mean=${(s.mean * 100).toFixed(2)}% ret=${(s.ret * 100).toFixed(0)}% Shp=${s.sh.toFixed(2)} bs+=${(s.bs.pctPositive * 100).toFixed(0)}% bs5%=${(s.bs.p5 * 100).toFixed(0)}% pctProf=${(s.pctProf * 100).toFixed(0)}% minW=${(s.minWin * 100).toFixed(0)}%`,
        );
        const g1 =
          s.n >= 120 &&
          s.mean >= 0.05 &&
          s.sh >= 4 &&
          s.bs.pctPositive >= 0.9 &&
          s.ret > 0 &&
          s.pctProf >= 0.5;

        // G2 quarters
        const qSize = Math.floor(c.length / 4);
        const qRet: number[] = [];
        console.log("G2 quarters:");
        for (let k = 0; k < 4; k++) {
          const sub = c.slice(k * qSize, (k + 1) * qSize);
          const sctx = mkCtx(sub, cand.p);
          const tq = run(sub, sctx, cand.p);
          const ss = stats(
            tq,
            sub.length,
            Math.floor(sub.length / 10),
            100 + k,
          );
          qRet.push(ss.ret);
          console.log(
            `  Q${k + 1} n=${ss.n} WR=${(ss.wr * 100).toFixed(1)}% mean=${(ss.mean * 100).toFixed(2)}% ret=${(ss.ret * 100).toFixed(1)}%`,
          );
        }
        const g2 = qRet[0] > 0 && qRet[1] > 0 && qRet[2] > 0 && qRet[3] >= -0.3;

        // G3 TP sweep
        console.log("G3 TP sweep:");
        let g3 = true;
        for (const tp of [0.45, 0.5, 0.6]) {
          const p = { ...cand.p, tpPct: tp };
          const t = run(c, ctx, p);
          const ss = stats(t, days, bpw, 300 + Math.round(tp * 100));
          if (ss.sh < 3.5 || ss.mean < 0.04) g3 = false;
          console.log(
            `  tp=${(tp * 100).toFixed(0)}% n=${ss.n} mean=${(ss.mean * 100).toFixed(2)}% Shp=${ss.sh.toFixed(2)}`,
          );
        }

        // G4 sensitivity
        console.log("G4 sensitivity:");
        const vs: Array<{ label: string; p: Params }> = [
          { label: "tp-20%", p: { ...cand.p, tpPct: cand.p.tpPct * 0.8 } },
          { label: "tp+20%", p: { ...cand.p, tpPct: cand.p.tpPct * 1.2 } },
          {
            label: "stop-30%",
            p: { ...cand.p, stopPct: cand.p.stopPct * 0.7 },
          },
          {
            label: "stop+30%",
            p: { ...cand.p, stopPct: cand.p.stopPct * 1.3 },
          },
          {
            label: "hold/2",
            p: { ...cand.p, hold: Math.max(10, Math.floor(cand.p.hold / 2)) },
          },
          {
            label: "hold*1.5",
            p: { ...cand.p, hold: Math.floor(cand.p.hold * 1.5) },
          },
          { label: "rsi-5", p: { ...cand.p, rsiTh: cand.p.rsiTh - 5 } },
          { label: "rsi+5", p: { ...cand.p, rsiTh: cand.p.rsiTh + 5 } },
          { label: "nHi=2", p: { ...cand.p, nHi: 2 } },
          { label: "cap=3", p: { ...cand.p, capK: 3 } },
        ];
        let vPass = 0;
        for (const v of vs) {
          const t = run(c, ctx, v.p);
          const ss = stats(t, days, bpw, 500);
          const ok = ss.sh >= 3 && ss.mean >= 0.03 && ss.ret > 0;
          if (ok) vPass++;
          console.log(
            `  ${v.label.padEnd(10)} n=${ss.n.toString().padStart(3)} mean=${(ss.mean * 100).toFixed(2).padStart(5)}% Shp=${ss.sh.toFixed(2).padStart(5)} ${ok ? "★" : ""}`,
          );
        }
        const g4 = vPass / vs.length >= 0.6;

        // G5 OOS
        const split = Math.floor(c.length * 0.6);
        const oosC = c.slice(split);
        const oosCtx = mkCtx(oosC, cand.p);
        const oosT = run(oosC, oosCtx, cand.p);
        const oosS = stats(
          oosT,
          oosC.length,
          Math.floor(oosC.length / 10),
          888,
        );
        console.log(
          `G5 OOS n=${oosS.n} WR=${(oosS.wr * 100).toFixed(1)}% mean=${(oosS.mean * 100).toFixed(2)}% ret=${(oosS.ret * 100).toFixed(0)}% Shp=${oosS.sh.toFixed(2)} bs+=${(oosS.bs.pctPositive * 100).toFixed(0)}%`,
        );
        const g5 = oosS.sh >= 2.5 && oosS.mean >= 0.03;

        const pass = g1 && g2 && g3 && g4 && g5;
        verdicts[cand.label] = pass;
        console.log(
          `\n  G1=${g1 ? "✓" : "✗"} G2=${g2 ? "✓" : "✗"} G3=${g3 ? "✓" : "✗"} G4=${g4 ? "✓" : "✗"} G5=${g5 ? "✓" : "✗"}  ${pass ? "★★★ ALL PASS" : "— fails"}`,
        );
      }

      console.log("\n════ FINAL SUMMARY ════");
      for (const [label, passed] of Object.entries(verdicts)) {
        console.log(`${passed ? "★ PASS" : "✗ FAIL"}  ${label}`);
      }
    },
  );
});
