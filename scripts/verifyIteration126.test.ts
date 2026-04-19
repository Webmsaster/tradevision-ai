/**
 * Iter 126 — 4h SWING tier 5-gate validation.
 *
 * Best config from iter125: 4h, fix tp=30% / stop=7% / hold=96 bars (16 days)
 * on the iter114 4-mechanic ensemble with MG3 macro gate scaled to 180 bars
 * (30d on 4h). Screen results: n=321, tpd 0.154 (1/6.5 days), WR 48.9%,
 * mean 2.98%, Sharpe 11.88, cumRet +176163% (full-size compounded).
 *
 * Also validate a compromise config: tp=15% / stop=5% / hold=48 for higher
 * trade count with still-strong mean profit.
 *
 * Gates (swing tier):
 *   G1 full: n ≥ 200, WR ≥ 45%, meanPct ≥ 2%, Sharpe ≥ 5, bs+ ≥ 90%
 *   G2 quarters: Q1-3 positive, Q4 ≥ -8% (swing trades spike more)
 *   G3 TP sweep: tp ∈ {20%, 25%, 30%} all Sharpe ≥ 5 and mean ≥ 1.5%
 *   G4 sensitivity: 10 variants, ≥ 70% stay Sharpe ≥ 4 AND mean ≥ 1.5%
 *   G5 OOS 60/40: OOS Sharpe ≥ 3, mean ≥ 1.5%
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const BTC = "BTCUSDT";
const TF = "4h" as const;
const BARS_PER_DAY = 6;
const BARS_PER_YEAR = 365 * BARS_PER_DAY;

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
): { pctPositive: number; medRet: number; p5: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, medRet: 0, p5: 0 };
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
    medRet: sorted[Math.floor(sorted.length / 2)],
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
  const barMs = 4 * 3600_000; // 4h
  const holdingHours = ((exitBar - (i + 1)) * barMs) / 3600_000;
  const pnl = applyCosts({
    entry,
    exit: exitPrice,
    direction: "long",
    holdingHours,
    config: MAKER_COSTS,
  }).netPnlPct;
  return { exitBar, pnl };
}

function runConcurrent(candles: Candle[], ctx: Ctx, p: Params): Trade[] {
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

const BASE: Params = {
  htfLen: 42,
  macroBars: 180,
  nHi: 9,
  rsiTh: 42,
  redPct: 0.005,
  nDown: 2,
  capK: 4,
  tpPct: 0.3,
  stopPct: 0.07,
  hold: 96,
};

describe("iter 126 — 4h SWING 5-gate validation", () => {
  it(
    "full gate battery on tp=30%/s=7% and alternatives",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 126: 4h SWING 5-gate battery ===");
      const c = await loadBinanceHistory({
        symbol: BTC,
        timeframe: TF,
        targetCount: 12_500,
        maxPages: 100,
      });
      const days = c.length / BARS_PER_DAY;
      const bpw = Math.floor(c.length / 10);
      console.log(`loaded ${c.length} 4h candles (${days.toFixed(0)} days)`);

      const tiers: Array<{ label: string; p: Params }> = [
        { label: "SWING-A tp=30% s=7% h=96 (best mean)", p: BASE },
        {
          label: "SWING-B tp=20% s=5% h=96 (milder)",
          p: { ...BASE, tpPct: 0.2, stopPct: 0.05 },
        },
        {
          label: "SWING-C tp=15% s=5% h=48 (frequent)",
          p: { ...BASE, tpPct: 0.15, stopPct: 0.05, hold: 48 },
        },
      ];

      for (const tier of tiers) {
        console.log(`\n════════════ ${tier.label} ════════════`);
        const ctx = mkCtx(c, tier.p);

        // G1
        const tAll = runConcurrent(c, ctx, tier.p);
        const s = stats(tAll, days, bpw, 777);
        console.log(
          `G1 FULL n=${s.n} tpd=${s.tpd.toFixed(3)} WR=${(s.wr * 100).toFixed(
            1,
          )}% mean=${(s.mean * 100).toFixed(2)}% ret=${(s.ret * 100).toFixed(
            0,
          )}% Shp=${s.sh.toFixed(2)} bs+=${(s.bs.pctPositive * 100).toFixed(0)}% bs5%=${(s.bs.p5 * 100).toFixed(1)}% pctProf=${(s.pctProf * 100).toFixed(0)}% minW=${(s.minWin * 100).toFixed(0)}%`,
        );
        const g1 =
          s.n >= 200 &&
          s.wr >= 0.45 &&
          s.mean >= 0.02 &&
          s.sh >= 5 &&
          s.bs.pctPositive >= 0.9;

        // G2 quarters
        const qSize = Math.floor(c.length / 4);
        const qRet: number[] = [];
        for (let k = 0; k < 4; k++) {
          const sub = c.slice(k * qSize, (k + 1) * qSize);
          const sctx = mkCtx(sub, tier.p);
          const tq = runConcurrent(sub, sctx, tier.p);
          const ss = stats(
            tq,
            sub.length / BARS_PER_DAY,
            Math.floor(sub.length / 10),
            100 + k,
          );
          qRet.push(ss.ret);
          console.log(
            `  Q${k + 1} n=${ss.n} tpd=${ss.tpd.toFixed(3)} WR=${(ss.wr * 100).toFixed(1)}% mean=${(ss.mean * 100).toFixed(2)}% ret=${(ss.ret * 100).toFixed(1)}% Shp=${ss.sh.toFixed(2)}`,
          );
        }
        const g2 =
          qRet[0] > 0 && qRet[1] > 0 && qRet[2] > 0 && qRet[3] >= -0.08;

        // G3 tp sweep
        console.log("G3 TP sweep:");
        let g3 = true;
        for (const tp of [0.2, 0.25, 0.3]) {
          const t = runConcurrent(c, ctx, { ...tier.p, tpPct: tp });
          const ss = stats(t, days, bpw, 400 + Math.round(tp * 100));
          if (ss.sh < 5 || ss.mean < 0.015) g3 = false;
          console.log(
            `  tp=${(tp * 100).toFixed(0)}% n=${ss.n} mean=${(ss.mean * 100).toFixed(2)}% Shp=${ss.sh.toFixed(2)}`,
          );
        }

        // G4 sensitivity
        console.log("G4 sensitivity (10 variants):");
        const vs: Array<{ label: string; p: Params }> = [
          { label: "tp-30%", p: { ...tier.p, tpPct: tier.p.tpPct * 0.7 } },
          { label: "tp+30%", p: { ...tier.p, tpPct: tier.p.tpPct * 1.3 } },
          {
            label: "stop-30%",
            p: { ...tier.p, stopPct: tier.p.stopPct * 0.7 },
          },
          {
            label: "stop+30%",
            p: { ...tier.p, stopPct: tier.p.stopPct * 1.3 },
          },
          {
            label: "hold/2",
            p: { ...tier.p, hold: Math.max(12, Math.floor(tier.p.hold / 2)) },
          },
          {
            label: "hold*1.5",
            p: { ...tier.p, hold: Math.floor(tier.p.hold * 1.5) },
          },
          { label: "rsi-5", p: { ...tier.p, rsiTh: tier.p.rsiTh - 5 } },
          { label: "rsi+5", p: { ...tier.p, rsiTh: tier.p.rsiTh + 5 } },
          {
            label: "nHi/2",
            p: { ...tier.p, nHi: Math.max(2, Math.floor(tier.p.nHi / 2)) },
          },
          { label: "cap=3", p: { ...tier.p, capK: 3 } },
        ];
        let vPass = 0;
        for (const v of vs) {
          const t = runConcurrent(c, ctx, v.p);
          const ss = stats(t, days, bpw, 500);
          const ok = ss.sh >= 4 && ss.mean >= 0.015 && ss.ret > 0;
          if (ok) vPass++;
          console.log(
            `  ${v.label.padEnd(10)} n=${ss.n.toString().padStart(4)} mean=${(ss.mean * 100).toFixed(2).padStart(5)}% ret=${(ss.ret * 100).toFixed(0).padStart(6)}% Shp=${ss.sh.toFixed(2).padStart(5)} ${ok ? "★" : ""}`,
          );
        }
        const g4 = vPass / vs.length >= 0.7;

        // G5 OOS
        const split = Math.floor(c.length * 0.6);
        const oosC = c.slice(split);
        const oosCtx = mkCtx(oosC, tier.p);
        const oosT = runConcurrent(oosC, oosCtx, tier.p);
        const oosS = stats(
          oosT,
          oosC.length / BARS_PER_DAY,
          Math.floor(oosC.length / 10),
          888,
        );
        console.log(
          `G5 OOS  n=${oosS.n} tpd=${oosS.tpd.toFixed(3)} WR=${(oosS.wr * 100).toFixed(1)}% mean=${(oosS.mean * 100).toFixed(2)}% ret=${(oosS.ret * 100).toFixed(0)}% Shp=${oosS.sh.toFixed(2)} bs+=${(oosS.bs.pctPositive * 100).toFixed(0)}%`,
        );
        const g5 = oosS.sh >= 3 && oosS.mean >= 0.015;

        console.log(
          `\n   G1=${g1 ? "✓" : "✗"} G2=${g2 ? "✓" : "✗"} G3=${g3 ? "✓" : "✗"} G4=${g4 ? "✓" : "✗"} G5=${g5 ? "✓" : "✗"}  ${g1 && g2 && g3 && g4 && g5 ? "★ ALL PASS" : "— fails"}`,
        );
      }
    },
  );
});
