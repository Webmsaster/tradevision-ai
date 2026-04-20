/**
 * Iter 143 — hunt for configs with mean ≥ 5% per trade on 1d BTC.
 *
 * Current best: iter128 1D-C tp=20%/s=7%/h=40 → mean 3.17%, WR 42%.
 * User target: 5% mean per trade. To get there we need bigger TPs and
 * longer holds, which will further reduce WR. Scan wide grid:
 *
 *   TP ∈ {25%, 30%, 40%, 50%, 60%}
 *   stop ∈ {5%, 7%, 10%, 15%}
 *   hold (days) ∈ {20, 30, 40, 60, 90}
 *   trigger params: iter128 baseline (rsiTh=42, nHi=3, redPct=0.01, nDown=2)
 *
 * Pass filter (coarse, for screening): n ≥ 80, mean ≥ 5%, cumRet > 0, Sharpe ≥ 2.
 * Tight filter for shortlist: also bs+ ≥ 90%.
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

describe("iter 143 — 5% mean swing scan", () => {
  it(
    "scan wide TP/stop/hold grid on 1d BTC for mean ≥ 5%",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 143: 5% mean hunt ===");
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

      const baseP = {
        htfLen: 7,
        macroBars: 30,
        nHi: 3,
        rsiTh: 42,
        redPct: 0.01,
        nDown: 2,
        capK: 4,
      };

      interface Result {
        tp: number;
        stop: number;
        hold: number;
        n: number;
        wr: number;
        mean: number;
        ret: number;
        sh: number;
        bsPos: number;
        bs5: number;
        pctProf: number;
        minWin: number;
      }

      const results: Result[] = [];

      for (const tp of [0.25, 0.3, 0.35, 0.4, 0.5, 0.6]) {
        for (const stop of [0.05, 0.07, 0.1, 0.12, 0.15]) {
          for (const hold of [20, 30, 40, 60, 90]) {
            const p: Params = {
              ...baseP,
              tpPct: tp,
              stopPct: stop,
              hold,
            };
            const ctx = mkCtx(c, p);
            const trades = runConcurrent(c, ctx, p);
            if (trades.length < 50) continue;
            const pnls = trades.map((t) => t.pnl);
            const wins = pnls.filter((x) => x > 0).length;
            const ret = pnls.reduce((a, x) => a * (1 + x), 1) - 1;
            const mean = pnls.reduce((a, x) => a + x, 0) / pnls.length;
            const sh = sharpeOf(pnls);
            const wr = wins / trades.length;
            const bs = bootstrap(
              pnls,
              50,
              Math.max(5, Math.floor(pnls.length / 15)),
              Math.round(tp * 1000 + stop * 100 + hold),
            );
            const winRet: number[] = [];
            for (let w = 0; w < 10; w++) {
              const lo = w * bpw;
              const hi = (w + 1) * bpw;
              const wt = trades.filter(
                (t) => t.openBar >= lo && t.openBar < hi,
              );
              winRet.push(wt.reduce((a, t) => a * (1 + t.pnl), 1) - 1);
            }
            const pctProf = winRet.filter((r) => r > 0).length / winRet.length;
            const minWin = Math.min(...winRet);
            results.push({
              tp,
              stop,
              hold,
              n: trades.length,
              wr,
              mean,
              ret,
              sh,
              bsPos: bs.pctPositive,
              bs5: bs.p5,
              pctProf,
              minWin,
            });
          }
        }
      }

      // Filter: mean ≥ 5%, cumRet > 0, n ≥ 80, Sharpe ≥ 2
      const winners = results
        .filter((r) => r.mean >= 0.05 && r.ret > 0 && r.n >= 80 && r.sh >= 2)
        .sort((a, b) => b.mean - a.mean);
      console.log("\n── All configs with mean ≥ 5%, n ≥ 80, Sharpe ≥ 2 ──");
      console.log(
        "tp  stop hold   n    WR     mean%    cumRet    Shp   bs+   bs5%    %prof  minW",
      );
      for (const r of winners.slice(0, 40)) {
        const tight =
          r.bsPos >= 0.9 && r.pctProf >= 0.5 && r.minWin >= -0.2 ? " ★" : "";
        console.log(
          `${(r.tp * 100).toFixed(0).padStart(2)}% ${(r.stop * 100).toFixed(0).padStart(3)}% ${r.hold.toString().padStart(3)}  ${r.n.toString().padStart(3)}  ${(r.wr * 100).toFixed(1).padStart(5)}% ${(r.mean * 100).toFixed(2).padStart(6)}% ${(r.ret * 100).toFixed(0).padStart(7)}% ${r.sh.toFixed(2).padStart(5)}  ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(r.bs5 * 100).toFixed(0).padStart(6)}% ${(r.pctProf * 100).toFixed(0).padStart(3)}% ${(r.minWin * 100).toFixed(0).padStart(5)}%${tight}`,
        );
      }
      console.log(`\ntotal winners: ${winners.length}`);

      // Reference 3% and 2% for context
      console.log("\n── Reference: mean ≥ 2% configs ──");
      const ref = results
        .filter((r) => r.mean >= 0.02 && r.mean < 0.05)
        .sort((a, b) => b.sh - a.sh)
        .slice(0, 10);
      for (const r of ref) {
        console.log(
          `tp=${(r.tp * 100).toFixed(0)}% s=${(r.stop * 100).toFixed(0)}% h=${r.hold}  n=${r.n} WR=${(r.wr * 100).toFixed(1)}% mean=${(r.mean * 100).toFixed(2)}% Shp=${r.sh.toFixed(2)} bs+=${(r.bsPos * 100).toFixed(0)}% %prof=${(r.pctProf * 100).toFixed(0)}%`,
        );
      }
    },
  );
});
