/**
 * Iter 134 — ATR-adaptive stops on iter133 baseline.
 *
 * iter133 uses fixed 1% stop. In low-volatility regimes this can be too wide
 * (letting trades drift). In high-volatility regimes it can be too tight
 * (random noise triggers the stop). ATR-adaptive stops scale with the
 * recent 14-bar ATR:
 *   stop = entry - stopMult × ATR(14)
 *   tp2  = entry + tpMult × ATR(14)  (optional ATR-adaptive tp2)
 *
 * Test grid:
 *   stopMult ∈ {1, 1.5, 2, 2.5, 3}
 *   tpMult   ∈ {fixed 4%, 4×ATR, 6×ATR, 8×ATR}
 *
 * Target: higher Sharpe than iter133's 8.23 and bs+ ≥ 95%.
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
function atrSeries(candles: Candle[], len: number): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < len + 1) return out;
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
  }
  let sum = 0;
  for (let i = 1; i <= len; i++) sum += tr[i];
  out[len] = sum / len;
  for (let i = len + 1; i < candles.length; i++) {
    out[i] = (out[i - 1] * (len - 1) + tr[i]) / len;
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
const P = {
  htfLen: 168,
  macroBars: 720,
  nHi: 36,
  rsiTh: 42,
  redPct: 0.002,
  nDown: 2,
  capK: 4,
  tp1: 0.008,
  hold: 24,
  volMult: 1.2,
  volMedLen: 96,
};

interface Ctx {
  closes: number[];
  highs: number[];
  volumes: number[];
  r7: number[];
  atr: number[];
  trendMask: boolean[];
  macroMask: boolean[];
  volMedian: number[];
}
function mkCtx(candles: Candle[]): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);
  const r7 = rsiSeries(closes, 7);
  const atr = atrSeries(candles, 14);
  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = P.htfLen; i < candles.length; i++) {
    const s = smaLast(closes.slice(i - P.htfLen, i), P.htfLen);
    trendMask[i] = candles[i].close > s;
  }
  const macroMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = P.macroBars; i < candles.length; i++) {
    const past = closes[i - P.macroBars];
    if (past > 0) macroMask[i] = (closes[i] - past) / past > 0;
  }
  const volMedian: number[] = new Array(candles.length).fill(0);
  for (let i = P.volMedLen; i < candles.length; i++) {
    volMedian[i] = medianLast(volumes.slice(i - P.volMedLen, i), P.volMedLen);
  }
  return { closes, highs, volumes, r7, atr, trendMask, macroMask, volMedian };
}

function fireM(candles: Candle[], ctx: Ctx, i: number, m: Mech): boolean {
  if (!ctx.trendMask[i] || !ctx.macroMask[i]) return false;
  switch (m) {
    case "M1":
      if (i < P.nDown + 1) return false;
      for (let k = 0; k < P.nDown; k++) {
        if (ctx.closes[i - k] >= ctx.closes[i - k - 1]) return false;
      }
      return true;
    case "M4":
      return ctx.r7[i] <= P.rsiTh;
    case "M5":
      if (i < P.nHi + 1) return false;
      return candles[i].close > maxLast(ctx.highs.slice(i - P.nHi, i), P.nHi);
    case "M6": {
      const o = candles[i].open;
      const c = candles[i].close;
      if (o <= 0) return false;
      return (c - o) / o <= -P.redPct;
    }
  }
}

interface ExitSpec {
  // Stop: either fixed pct or atrMult × ATR(i)
  stopKind: "fixed" | "atr";
  stopParam: number; // pct if "fixed", mult if "atr"
  tpKind: "fixed" | "atr";
  tpParam: number;
}

function executeLong(
  candles: Candle[],
  ctx: Ctx,
  i: number,
  spec: ExitSpec,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp1L = entry * (1 + P.tp1);
  const atrI = ctx.atr[i];
  if (spec.stopKind === "atr" && (!isFinite(atrI) || atrI <= 0)) return null;
  const tp2L =
    spec.tpKind === "fixed"
      ? entry * (1 + spec.tpParam)
      : entry + spec.tpParam * atrI;
  let sL =
    spec.stopKind === "fixed"
      ? entry * (1 - spec.stopParam)
      : entry - spec.stopParam * atrI;
  if (sL >= entry) return null; // sanity
  const mx = Math.min(i + 1 + P.hold, candles.length - 1);
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
function run(candles: Candle[], ctx: Ctx, spec: ExitSpec): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  for (let i = P.macroBars + 2; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= P.capK) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    if (ctx.volumes[i] <= P.volMult * ctx.volMedian[i]) continue;
    for (const m of mechs) {
      if (open.length >= P.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m)) continue;
      const r = executeLong(candles, ctx, i, spec);
      if (!r) continue;
      trades.push({ pnl: r.pnl / P.capK, openBar: i });
      open.push({ exitBar: r.exitBar, mech: m });
    }
  }
  return trades;
}

describe("iter 134 — ATR-adaptive stops", () => {
  it(
    "test fixed vs ATR stops/tps on iter133 baseline",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 134: ATR-adaptive stops ===");
      const c = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1h",
        targetCount: TARGET_CANDLES,
        maxPages: 100,
      });
      const days = c.length / 24;
      const bpw = Math.floor(c.length / 10);
      console.log(`loaded ${c.length} BTC candles (${days.toFixed(0)} days)`);
      const ctx = mkCtx(c);

      const cases: Array<{ label: string; spec: ExitSpec }> = [
        {
          label: "iter133 baseline (fixed 1%/4%)",
          spec: {
            stopKind: "fixed",
            stopParam: 0.01,
            tpKind: "fixed",
            tpParam: 0.04,
          },
        },
        {
          label: "atrStop 1×, tp fixed 4%",
          spec: {
            stopKind: "atr",
            stopParam: 1.0,
            tpKind: "fixed",
            tpParam: 0.04,
          },
        },
        {
          label: "atrStop 1.5×, tp fixed 4%",
          spec: {
            stopKind: "atr",
            stopParam: 1.5,
            tpKind: "fixed",
            tpParam: 0.04,
          },
        },
        {
          label: "atrStop 2×, tp fixed 4%",
          spec: {
            stopKind: "atr",
            stopParam: 2.0,
            tpKind: "fixed",
            tpParam: 0.04,
          },
        },
        {
          label: "atrStop 2.5×, tp fixed 4%",
          spec: {
            stopKind: "atr",
            stopParam: 2.5,
            tpKind: "fixed",
            tpParam: 0.04,
          },
        },
        {
          label: "atrStop 3×, tp fixed 4%",
          spec: {
            stopKind: "atr",
            stopParam: 3.0,
            tpKind: "fixed",
            tpParam: 0.04,
          },
        },
        {
          label: "fixed 1%, tp atr 4×",
          spec: {
            stopKind: "fixed",
            stopParam: 0.01,
            tpKind: "atr",
            tpParam: 4,
          },
        },
        {
          label: "fixed 1%, tp atr 6×",
          spec: {
            stopKind: "fixed",
            stopParam: 0.01,
            tpKind: "atr",
            tpParam: 6,
          },
        },
        {
          label: "fixed 1%, tp atr 8×",
          spec: {
            stopKind: "fixed",
            stopParam: 0.01,
            tpKind: "atr",
            tpParam: 8,
          },
        },
        {
          label: "atrStop 1.5×, tp atr 6×",
          spec: { stopKind: "atr", stopParam: 1.5, tpKind: "atr", tpParam: 6 },
        },
        {
          label: "atrStop 2×, tp atr 6×",
          spec: { stopKind: "atr", stopParam: 2.0, tpKind: "atr", tpParam: 6 },
        },
      ];

      console.log(
        "\nlabel                            n     tpd    WR     mean%    cumRet   Shp    bs+   bs5%    %prof  minW",
      );
      for (const c2 of cases) {
        const t = run(c, ctx, c2.spec);
        if (t.length < 30) {
          console.log(`${c2.label.padEnd(32)} skipped (n=${t.length})`);
          continue;
        }
        const pnls = t.map((x) => x.pnl);
        const wins = pnls.filter((p) => p > 0).length;
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
        const sh = sharpeOf(pnls);
        const tpd = t.length / days;
        const wr = wins / t.length;
        const bs = bootstrap(
          pnls,
          50,
          Math.max(10, Math.floor(pnls.length / 15)),
          42,
        );
        const winRet: number[] = [];
        for (let w = 0; w < 10; w++) {
          const lo = w * bpw;
          const hi = (w + 1) * bpw;
          const wt = t.filter((x) => x.openBar >= lo && x.openBar < hi);
          winRet.push(wt.reduce((a, x) => a * (1 + x.pnl), 1) - 1);
        }
        const pctProf = winRet.filter((r) => r > 0).length / winRet.length;
        const minWin = Math.min(...winRet);
        console.log(
          `${c2.label.padEnd(32)} ${t.length.toString().padStart(4)} ${tpd.toFixed(2)} ${(wr * 100).toFixed(1).padStart(5)}% ${(mean * 100).toFixed(3).padStart(6)}% ${(ret * 100).toFixed(1).padStart(6)}% ${sh.toFixed(2).padStart(5)} ${(bs.pctPositive * 100).toFixed(0).padStart(3)}% ${(bs.p5 * 100).toFixed(1).padStart(6)}% ${(pctProf * 100).toFixed(0).padStart(3)}% ${(minWin * 100).toFixed(1).padStart(6)}%`,
        );
      }
    },
  );
});
