/**
 * Iter 117 — finalise & stress-test the BTC 1h concurrent cap=3 ensemble.
 *
 * iter116 found the winner: 1h, 4 mechanics (M1/M4/M5/M6) running as a
 * signal union with up to 3 concurrent long positions, 1/3 size each.
 *   → 2.18 trades/day, Sharpe 3.59, +84.3% over 2083 days,
 *     bootstrap 100% positive, bs5%ile +35.6%, 70% windows profitable.
 *
 * This iter's job is to confirm robustness before shipping:
 *   1. Re-run with 100-sample bootstrap (vs 30 in iter116) on full 2083d.
 *   2. Walk-forward: Q1/Q2/Q3/Q4 and 2-half — does the edge hold in the
 *      most-recent quarter (the failure point of iter101-104 HF system)?
 *   3. Sweep cap ∈ {2..6} to confirm cap=3 is the plateau.
 *   4. Sensitivity: ±30% on tp1/tp2/stop/hold to verify no knife's-edge.
 *
 * Success criteria for production ship:
 *   - full-history: tpd ≥ 2, Sharpe ≥ 3, bootstrap ≥ 95% positive
 *   - each quarter: positive cumRet (allow Sharpe < 0 on worst quarter only if
 *     return stays within -5%)
 *   - ±30% param perturbation: Sharpe stays above 2.5 in ≥ 80% of variants
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const BTC = "BTCUSDT";
const TARGET_CANDLES = 50_000;

// ───── shared helpers (dup from iter116) ─────

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
): {
  pctPositive: number;
  medRet: number;
  p5: number;
  p25: number;
  p75: number;
} {
  if (pnls.length < blockLen)
    return { pctPositive: 0, medRet: 0, p5: 0, p25: 0, p75: 0 };
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
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
  };
}

interface ExecParams {
  tp1: number;
  tp2: number;
  stop: number;
  hold: number;
}

function executeLong(
  candles: Candle[],
  i: number,
  p: ExecParams,
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
    const sH = bar.low <= sL;
    const t1 = bar.high >= tp1L;
    const t2 = bar.high >= tp2L;
    if (!tp1Hit) {
      if (sH) {
        l2B = j;
        l2P = sL;
        break;
      }
      if (t1) {
        tp1Hit = true;
        tp1Bar = j;
        sL = entry;
        if (t2) {
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

type Mech = "M1" | "M4" | "M5" | "M6";

interface Trade {
  pnl: number;
  openBar: number;
  exitBar: number;
  mech: Mech;
}

interface Ctx {
  closes: number[];
  highs: number[];
  r7: number[];
  htfLen: number;
  trendMask: boolean[];
}

function mkCtx(candles: Candle[], htfLen: number): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const r7 = rsiSeries(closes, 7);
  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = htfLen; i < candles.length; i++) {
    const sma = smaLast(closes.slice(i - htfLen, i), htfLen);
    trendMask[i] = candles[i].close > sma;
  }
  return { closes, highs, r7, htfLen, trendMask };
}

function fireM(
  candles: Candle[],
  ctx: Ctx,
  i: number,
  m: Mech,
  p: { rsiTh: number; nHi: number; redPct: number },
): boolean {
  if (!ctx.trendMask[i]) return false;
  switch (m) {
    case "M1":
      if (i < 2) return false;
      return (
        ctx.closes[i] < ctx.closes[i - 1] &&
        ctx.closes[i - 1] < ctx.closes[i - 2]
      );
    case "M4":
      return ctx.r7[i] <= p.rsiTh;
    case "M5": {
      if (i < p.nHi + 1) return false;
      const prevMax = maxLast(ctx.highs.slice(i - p.nHi, i), p.nHi);
      return candles[i].close > prevMax;
    }
    case "M6": {
      const o = candles[i].open;
      const c = candles[i].close;
      if (o <= 0) return false;
      return (c - o) / o <= -p.redPct;
    }
  }
}

function runConcurrent(
  candles: Candle[],
  ctx: Ctx,
  p: ExecParams,
  capK: number,
  params: { rsiTh: number; nHi: number; redPct: number },
): Trade[] {
  const openExits: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  for (let i = ctx.htfLen + 2; i < candles.length - 1; i++) {
    for (let k = openExits.length - 1; k >= 0; k--) {
      if (openExits[k].exitBar < i) openExits.splice(k, 1);
    }
    if (openExits.length >= capK) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    for (const m of mechs) {
      if (openExits.length >= capK) break;
      if (openExits.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m, params)) continue;
      const r = executeLong(candles, i, p);
      if (!r) continue;
      trades.push({
        pnl: r.pnl / capK,
        openBar: i,
        exitBar: r.exitBar,
        mech: m,
      });
      openExits.push({ exitBar: r.exitBar, mech: m });
    }
  }
  return trades;
}

function stats(
  trades: Trade[],
  days: number,
  bpw: number,
  barsPerYear: number,
  seed: number,
) {
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const sh = sharpeOf(pnls, barsPerYear);
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
  return { ret, sh, tpd, wr, pctProf, minWin, bs, winRet, n: trades.length };
}

const DEFAULT = {
  rsiTh: 40,
  nHi: 48,
  redPct: 0.005,
};
const EXEC: ExecParams = { tp1: 0.008, tp2: 0.04, stop: 0.01, hold: 24 };
const HTF = 168;

describe("iter 117 — BTC ensemble final validation", () => {
  it(
    "full-history + walk-forward + cap sweep + param sensitivity",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 117: BTC ensemble final validation ===");
      const c = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1h",
        targetCount: TARGET_CANDLES,
        maxPages: 100,
      });
      const days = c.length / 24;
      const bpw = Math.floor(c.length / 10);
      console.log(
        `loaded ${c.length} 1h BTC candles (${days.toFixed(0)} days)`,
      );
      const ctx = mkCtx(c, HTF);

      // 1) Full-history with 100 bootstrap resamples
      console.log("\n── 1) Full history, cap=3, 100-resample bootstrap ──");
      const tAll = runConcurrent(c, ctx, EXEC, 3, DEFAULT);
      const s = stats(tAll, days, bpw, 365 * 24, 777);
      console.log(
        `n=${s.n} tpd=${s.tpd.toFixed(2)} WR=${(s.wr * 100).toFixed(
          1,
        )}% ret=${(s.ret * 100).toFixed(1)}% Shp=${s.sh.toFixed(
          2,
        )} %prof=${(s.pctProf * 100).toFixed(0)}% minW=${(s.minWin * 100).toFixed(1)}%`,
      );
      console.log(
        `bs+=${(s.bs.pctPositive * 100).toFixed(0)}% bs5%=${(
          s.bs.p5 * 100
        ).toFixed(1)}% bs25%=${(s.bs.p25 * 100).toFixed(1)}% bsMed=${(
          s.bs.medRet * 100
        ).toFixed(1)}% bs75%=${(s.bs.p75 * 100).toFixed(1)}%`,
      );
      console.log(
        `windows: [${s.winRet.map((r) => (r * 100).toFixed(1) + "%").join(", ")}]`,
      );

      // 2) Walk-forward: halves + quarters
      console.log("\n── 2) Walk-forward ──");
      const wf = (label: string, sub: Candle[], seed: number) => {
        const sctx = mkCtx(sub, HTF);
        const t = runConcurrent(sub, sctx, EXEC, 3, DEFAULT);
        const d = sub.length / 24;
        const bpwS = Math.floor(sub.length / 10);
        const ss = stats(t, d, bpwS, 365 * 24, seed);
        console.log(
          `${label.padEnd(20)} n=${ss.n.toString().padStart(4)} tpd=${ss.tpd.toFixed(
            2,
          )} WR=${(ss.wr * 100).toFixed(1)}% ret=${(ss.ret * 100).toFixed(
            1,
          )}% Shp=${ss.sh.toFixed(2)} bs+=${(ss.bs.pctPositive * 100).toFixed(0)}%`,
        );
        return ss;
      };
      const half1 = wf(
        "Half1 (first 50%)",
        c.slice(0, Math.floor(c.length / 2)),
        101,
      );
      const half2 = wf(
        "Half2 (last 50%)",
        c.slice(Math.floor(c.length / 2)),
        102,
      );
      const qSize = Math.floor(c.length / 4);
      const qResults = [0, 1, 2, 3].map((k) =>
        wf(`Q${k + 1}`, c.slice(k * qSize, (k + 1) * qSize), 200 + k),
      );

      // 3) Cap sweep
      console.log("\n── 3) Cap sweep {1..6} ──");
      for (const K of [1, 2, 3, 4, 5, 6]) {
        const t = runConcurrent(c, ctx, EXEC, K, DEFAULT);
        const ss = stats(t, days, bpw, 365 * 24, 300 + K);
        console.log(
          `cap=${K}  n=${ss.n} tpd=${ss.tpd.toFixed(2)} WR=${(
            ss.wr * 100
          ).toFixed(1)}% ret=${(ss.ret * 100).toFixed(1)}% Shp=${ss.sh.toFixed(
            2,
          )} bs+=${(ss.bs.pctPositive * 100).toFixed(
            0,
          )}% %prof=${(ss.pctProf * 100).toFixed(0)}% minW=${(ss.minWin * 100).toFixed(1)}%`,
        );
      }

      // 4) Param sensitivity (±30%) — tp1, tp2, stop, hold
      console.log("\n── 4) Param sensitivity (cap=3) ──");
      const variants: Array<{
        label: string;
        exec: ExecParams;
        p: typeof DEFAULT;
      }> = [];
      // tp1 ±30%
      variants.push({
        label: "tp1 -30%",
        exec: { ...EXEC, tp1: 0.008 * 0.7 },
        p: DEFAULT,
      });
      variants.push({
        label: "tp1 +30%",
        exec: { ...EXEC, tp1: 0.008 * 1.3 },
        p: DEFAULT,
      });
      variants.push({
        label: "tp2 -30%",
        exec: { ...EXEC, tp2: 0.04 * 0.7 },
        p: DEFAULT,
      });
      variants.push({
        label: "tp2 +30%",
        exec: { ...EXEC, tp2: 0.04 * 1.3 },
        p: DEFAULT,
      });
      variants.push({
        label: "stop -30%",
        exec: { ...EXEC, stop: 0.01 * 0.7 },
        p: DEFAULT,
      });
      variants.push({
        label: "stop +30%",
        exec: { ...EXEC, stop: 0.01 * 1.3 },
        p: DEFAULT,
      });
      variants.push({
        label: "hold x0.5",
        exec: { ...EXEC, hold: 12 },
        p: DEFAULT,
      });
      variants.push({
        label: "hold x2.0",
        exec: { ...EXEC, hold: 48 },
        p: DEFAULT,
      });
      variants.push({
        label: "rsiTh=35",
        exec: EXEC,
        p: { ...DEFAULT, rsiTh: 35 },
      });
      variants.push({
        label: "rsiTh=45",
        exec: EXEC,
        p: { ...DEFAULT, rsiTh: 45 },
      });
      variants.push({
        label: "nHi=24",
        exec: EXEC,
        p: { ...DEFAULT, nHi: 24 },
      });
      variants.push({
        label: "nHi=72",
        exec: EXEC,
        p: { ...DEFAULT, nHi: 72 },
      });
      variants.push({
        label: "redPct=0.003",
        exec: EXEC,
        p: { ...DEFAULT, redPct: 0.003 },
      });
      variants.push({
        label: "redPct=0.008",
        exec: EXEC,
        p: { ...DEFAULT, redPct: 0.008 },
      });
      let passed = 0;
      for (const v of variants) {
        const t = runConcurrent(c, ctx, v.exec, 3, v.p);
        const ss = stats(t, days, bpw, 365 * 24, 400);
        const pass = ss.sh >= 2.5 && ss.ret > 0;
        if (pass) passed++;
        console.log(
          `  ${v.label.padEnd(14)} n=${ss.n} tpd=${ss.tpd.toFixed(2)} WR=${(
            ss.wr * 100
          ).toFixed(1)}% ret=${(ss.ret * 100).toFixed(1)}% Shp=${ss.sh.toFixed(
            2,
          )} ${pass ? "★" : ""}`,
        );
      }
      console.log(
        `Sensitivity passed: ${passed}/${variants.length} (${((passed / variants.length) * 100).toFixed(0)}%)`,
      );

      // Verdict
      const gateA =
        s.tpd >= 2 && s.sh >= 3 && s.bs.pctPositive >= 0.95 && s.ret > 0;
      const gateB = qResults.every((q) => q.ret >= -0.05);
      const gateC = passed / variants.length >= 0.8;
      console.log("\n── VERDICT ──");
      console.log(
        `${gateA ? "✓" : "✗"} gate A: tpd≥2, Sharpe≥3, bs+≥95%, ret>0`,
      );
      console.log(`${gateB ? "✓" : "✗"} gate B: all quarters ret≥-5%`);
      console.log(
        `${gateC ? "✓" : "✗"} gate C: ≥80% param variants Shp≥2.5 & ret>0`,
      );
      if (gateA && gateB && gateC) {
        console.log("\n★★★ BTC ENSEMBLE VALIDATED — READY TO SHIP ★★★");
      } else {
        console.log("\n✗ fails at least one gate — needs more work");
      }
      // suppress unused warnings
      void half1;
      void half2;
    },
  );
});
