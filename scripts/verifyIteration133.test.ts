/**
 * Iter 133 — final 5-gate battery on BTC + volume filter (vol > 1.2 × med96).
 *
 * Upgrade from iter123 baseline. iter132 screen showed:
 *   n=2635, tpd 1.26, WR 57.8%, mean 0.025%, Sharpe 8.23, bs+ 100%,
 *   pctProf 90%, minW -1.7%, ALL quarters positive.
 *
 * Strict gates (iter119 schema, tightened for volume-filter tier):
 *   G1 full: tpd ≥ 1.2, Sharpe ≥ 7, bs+ ≥ 95%, pctProf ≥ 80%, ret > 0
 *   G2 quarters: ALL 4 positive (stricter than iter123 Q4 ≥ -5%)
 *   G3 volMult sweep: {1.0, 1.2, 1.5} all pass Sharpe ≥ 6
 *   G4 sensitivity: 10 param variants, ≥ 80% stay Sharpe ≥ 5 & mean ≥ 0.015%
 *   G5 OOS 60/40: Shp ≥ 5, bs+ ≥ 90%, mean ≥ 0.015%
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const BTC = "BTCUSDT";
const TARGET_CANDLES = 50_000;

function smaLast(v: number[], n: number): number {
  if (v.length < n) return v[v.length - 1] ?? 0;
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function medianLast(v: number[], n: number): number {
  if (v.length < n) return 0;
  const s = [...v.slice(-n)].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
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
  tp1: number;
  tp2: number;
  stop: number;
  hold: number;
  volMult: number;
  volMedLen: number;
}

const BASE: Params = {
  htfLen: 168,
  macroBars: 720,
  nHi: 36,
  rsiTh: 42,
  redPct: 0.002,
  nDown: 2,
  capK: 4,
  tp1: 0.008,
  tp2: 0.04,
  stop: 0.01,
  hold: 24,
  volMult: 1.2,
  volMedLen: 96,
};

interface Ctx {
  closes: number[];
  highs: number[];
  volumes: number[];
  r7: number[];
  trendMask: boolean[];
  macroMask: boolean[];
  volMedian: number[];
}

function mkCtx(candles: Candle[], p: Params): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);
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
  const volMedian: number[] = new Array(candles.length).fill(0);
  for (let i = p.volMedLen; i < candles.length; i++) {
    volMedian[i] = medianLast(volumes.slice(i - p.volMedLen, i), p.volMedLen);
  }
  return { closes, highs, volumes, r7, trendMask, macroMask, volMedian };
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

function executeLong(
  candles: Candle[],
  i: number,
  p: Params,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp1L = entry * (1 + p.tp1);
  const tp2L = entry * (1 + p.tp2);
  let sL = entry * (1 - p.stop);
  const mx = Math.min(i + 1 + p.hold, candles.length - 1);
  let tp1Hit = false;
  let tp1Bar = -1;
  let l2P = candles[mx].close;
  let l2B = mx;
  for (let j = i + 2; j <= mx; j++) {
    const bar = candles[j];
    if (!tp1Hit) {
      if (bar.low <= sL) {
        l2B = j;
        l2P = sL;
        break;
      }
      if (bar.high >= tp1L) {
        tp1Hit = true;
        tp1Bar = j;
        sL = entry;
        if (bar.high >= tp2L) {
          l2B = j;
          l2P = tp2L;
          break;
        }
        continue;
      }
    } else {
      if (bar.low <= sL) {
        l2B = j;
        l2P = sL;
        break;
      }
      if (bar.high >= tp2L) {
        l2B = j;
        l2P = tp2L;
        break;
      }
    }
  }
  const leg2 = applyCosts({
    entry,
    exit: l2P,
    direction: "long",
    holdingHours: l2B - (i + 1),
    config: MAKER_COSTS,
  }).netPnlPct;
  const leg1 = tp1Hit
    ? applyCosts({
        entry,
        exit: tp1L,
        direction: "long",
        holdingHours: tp1Bar - (i + 1),
        config: MAKER_COSTS,
      }).netPnlPct
    : leg2;
  return { exitBar: l2B, pnl: 0.5 * leg1 + 0.5 * leg2 };
}

interface Trade {
  pnl: number;
  openBar: number;
}
function run(candles: Candle[], ctx: Ctx, p: Params): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  for (let i = p.macroBars + 2; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= p.capK) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    if (p.volMult > 0 && ctx.volumes[i] <= p.volMult * ctx.volMedian[i])
      continue;
    for (const m of mechs) {
      if (open.length >= p.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m, p)) continue;
      const r = executeLong(candles, i, p);
      if (!r) continue;
      trades.push({ pnl: r.pnl / p.capK, openBar: i });
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
    Math.max(10, Math.floor(pnls.length / 15)),
    seed,
  );
  return { n: trades.length, tpd, wr, ret, sh, mean, pctProf, minWin, bs };
}

describe("iter 133 — vol-filter final validation", () => {
  it(
    "full 5-gate on BTC + vol 1.2× med96",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 133: FINAL LOCK (vol-filter) ===");
      const c = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1h",
        targetCount: TARGET_CANDLES,
        maxPages: 100,
      });
      const days = c.length / 24;
      const bpw = Math.floor(c.length / 10);
      console.log(
        `loaded ${c.length} BTC 1h candles (${days.toFixed(0)} days)`,
      );

      const ctx = mkCtx(c, BASE);

      // G1
      const tAll = run(c, ctx, BASE);
      const s = stats(tAll, days, bpw, 777);
      console.log(
        `G1 FULL  n=${s.n} tpd=${s.tpd.toFixed(2)} WR=${(s.wr * 100).toFixed(1)}% mean=${(s.mean * 100).toFixed(3)}% ret=${(s.ret * 100).toFixed(1)}% Shp=${s.sh.toFixed(2)} bs+=${(s.bs.pctPositive * 100).toFixed(0)}% bs5%=${(s.bs.p5 * 100).toFixed(1)}% pctProf=${(s.pctProf * 100).toFixed(0)}% minW=${(s.minWin * 100).toFixed(1)}%`,
      );
      const g1 =
        s.tpd >= 1.2 &&
        s.sh >= 7 &&
        s.bs.pctPositive >= 0.95 &&
        s.pctProf >= 0.8 &&
        s.ret > 0;

      // G2
      const qSize = Math.floor(c.length / 4);
      const qRet: number[] = [];
      console.log("G2 quarters (require ALL positive):");
      for (let k = 0; k < 4; k++) {
        const sub = c.slice(k * qSize, (k + 1) * qSize);
        const sctx = mkCtx(sub, BASE);
        const tq = run(sub, sctx, BASE);
        const ss = stats(
          tq,
          sub.length / 24,
          Math.floor(sub.length / 10),
          100 + k,
        );
        qRet.push(ss.ret);
        console.log(
          `  Q${k + 1} n=${ss.n} tpd=${ss.tpd.toFixed(2)} WR=${(ss.wr * 100).toFixed(1)}% mean=${(ss.mean * 100).toFixed(3)}% ret=${(ss.ret * 100).toFixed(1)}% Shp=${ss.sh.toFixed(2)}`,
        );
      }
      const g2 = qRet.every((r) => r > 0);

      // G3 volMult sweep
      console.log("G3 vol-multiplier sweep:");
      let g3 = true;
      for (const volMult of [1.0, 1.2, 1.5]) {
        const p = { ...BASE, volMult };
        const t = run(c, ctx, p);
        const ss = stats(t, days, bpw, 300 + Math.round(volMult * 10));
        if (ss.sh < 6) g3 = false;
        console.log(
          `  volMult=${volMult} n=${ss.n} mean=${(ss.mean * 100).toFixed(3)}% Shp=${ss.sh.toFixed(2)} bs+=${(ss.bs.pctPositive * 100).toFixed(0)}%`,
        );
      }

      // G4 sensitivity
      console.log("G4 sensitivity (10 variants):");
      const vs: Array<{ label: string; p: Params }> = [
        { label: "tp1-30%", p: { ...BASE, tp1: BASE.tp1 * 0.7 } },
        { label: "tp1+30%", p: { ...BASE, tp1: BASE.tp1 * 1.3 } },
        { label: "tp2-30%", p: { ...BASE, tp2: BASE.tp2 * 0.7 } },
        { label: "tp2+30%", p: { ...BASE, tp2: BASE.tp2 * 1.3 } },
        { label: "stop-30%", p: { ...BASE, stop: BASE.stop * 0.7 } },
        { label: "stop+30%", p: { ...BASE, stop: BASE.stop * 1.3 } },
        { label: "hold x0.5", p: { ...BASE, hold: 12 } },
        { label: "hold x2", p: { ...BASE, hold: 48 } },
        { label: "volMedLen=48", p: { ...BASE, volMedLen: 48 } },
        { label: "volMedLen=168", p: { ...BASE, volMedLen: 168 } },
      ];
      let vPass = 0;
      for (const v of vs) {
        const sctx = mkCtx(c, v.p);
        const t = run(c, sctx, v.p);
        const ss = stats(t, days, bpw, 500);
        const ok = ss.sh >= 5 && ss.mean >= 0.00015 && ss.ret > 0;
        if (ok) vPass++;
        console.log(
          `  ${v.label.padEnd(14)} n=${ss.n.toString().padStart(4)} mean=${(ss.mean * 100).toFixed(3).padStart(6)}% Shp=${ss.sh.toFixed(2).padStart(5)} ${ok ? "★" : ""}`,
        );
      }
      const g4 = vPass / vs.length >= 0.8;

      // G5 OOS 60/40
      const split = Math.floor(c.length * 0.6);
      const oosC = c.slice(split);
      const oosCtx = mkCtx(oosC, BASE);
      const oosT = run(oosC, oosCtx, BASE);
      const oosS = stats(
        oosT,
        oosC.length / 24,
        Math.floor(oosC.length / 10),
        888,
      );
      console.log(
        `G5 OOS  n=${oosS.n} tpd=${oosS.tpd.toFixed(2)} WR=${(oosS.wr * 100).toFixed(1)}% mean=${(oosS.mean * 100).toFixed(3)}% ret=${(oosS.ret * 100).toFixed(1)}% Shp=${oosS.sh.toFixed(2)} bs+=${(oosS.bs.pctPositive * 100).toFixed(0)}%`,
      );
      const g5 =
        oosS.sh >= 5 && oosS.mean >= 0.00015 && oosS.bs.pctPositive >= 0.9;

      console.log(
        `\n── VERDICT ──\nG1=${g1 ? "✓" : "✗"} G2=${g2 ? "✓" : "✗"} G3=${g3 ? "✓" : "✗"} G4=${g4 ? "✓" : "✗"} G5=${g5 ? "✓" : "✗"}  ${g1 && g2 && g3 && g4 && g5 ? "★★★ ALL 5 GATES PASSED ★★★" : "— fails"}`,
      );
    },
  );
});
