/**
 * Iter 118 — rescue Q4 with macro-regime gates.
 *
 * iter117 showed the BTC cap=3 ensemble is great on 8-year history
 * (tpd 2.18, Sharpe 3.59, bs+ 97%) BUT Q4 (last ~520d) loses -11%.
 * Q2 also loses -4%. The 168h HTF-SMA gate on each trade is too weak.
 *
 * Hypothesis: during choppy / bear regimes the ensemble's wide stop (1%)
 * and 4% runner tp2 rarely hit — trades cluster around tp1 (+0.8%) with
 * many stop-outs. Adding a macro-regime gate that forbids entries when
 * BTC is structurally weak should cut out the bad windows.
 *
 * Candidates:
 *   MG1  BTC close > SMA(336h)     — 14-day SMA
 *   MG2  BTC close > SMA(720h)     — 30-day SMA
 *   MG3  BTC 30d return > 0        — simple drift positivity
 *   MG4  SMA(168) > SMA(336)       — golden-cross-ish (short > long)
 *   MG5  BTC 90d return > 0        — long-term drift
 *   MG6  vol regime: realized 30d vol within 30-70 percentile of 2y window
 *   MG7  combination: MG1 AND MG4   — both trend + slope alignment
 *
 * Pass: full ret positive, Q4 ret ≥ -5%, bs+ ≥ 95%, tpd ≥ 1.2.
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
  macroMask: boolean[];
}

type MacroGate =
  | "none"
  | "MG1_sma336"
  | "MG2_sma720"
  | "MG3_ret30d"
  | "MG4_sma168gt336"
  | "MG5_ret90d"
  | "MG6_vol"
  | "MG7_sma336_and_slope";

function buildMacroMask(candles: Candle[], gate: MacroGate): boolean[] {
  const n = candles.length;
  const mask: boolean[] = new Array(n).fill(true);
  const closes = candles.map((c) => c.close);
  switch (gate) {
    case "none":
      return mask;
    case "MG1_sma336":
      for (let i = 336; i < n; i++) {
        const s = smaLast(closes.slice(i - 336, i), 336);
        mask[i] = closes[i] > s;
      }
      for (let i = 0; i < 336 && i < n; i++) mask[i] = false;
      return mask;
    case "MG2_sma720":
      for (let i = 720; i < n; i++) {
        const s = smaLast(closes.slice(i - 720, i), 720);
        mask[i] = closes[i] > s;
      }
      for (let i = 0; i < 720 && i < n; i++) mask[i] = false;
      return mask;
    case "MG3_ret30d":
      for (let i = 720; i < n; i++) {
        const past = closes[i - 720];
        if (past <= 0) {
          mask[i] = false;
          continue;
        }
        mask[i] = (closes[i] - past) / past > 0;
      }
      for (let i = 0; i < 720 && i < n; i++) mask[i] = false;
      return mask;
    case "MG4_sma168gt336":
      for (let i = 336; i < n; i++) {
        const s168 = smaLast(closes.slice(i - 168, i), 168);
        const s336 = smaLast(closes.slice(i - 336, i), 336);
        mask[i] = s168 > s336;
      }
      for (let i = 0; i < 336 && i < n; i++) mask[i] = false;
      return mask;
    case "MG5_ret90d":
      for (let i = 2160; i < n; i++) {
        const past = closes[i - 2160];
        if (past <= 0) {
          mask[i] = false;
          continue;
        }
        mask[i] = (closes[i] - past) / past > 0;
      }
      for (let i = 0; i < 2160 && i < n; i++) mask[i] = false;
      return mask;
    case "MG6_vol": {
      // realized vol over last 720 hourly log-returns (30 days).
      // Pass only when within 30..70 pctile of 2-year rolling window.
      const rv: number[] = new Array(n).fill(NaN);
      for (let i = 720; i < n; i++) {
        let sumSq = 0;
        let cnt = 0;
        for (let k = i - 720 + 1; k <= i; k++) {
          if (closes[k - 1] <= 0 || closes[k] <= 0) continue;
          const r = Math.log(closes[k] / closes[k - 1]);
          sumSq += r * r;
          cnt++;
        }
        rv[i] = Math.sqrt((sumSq / Math.max(1, cnt)) * 24 * 365);
      }
      const WINDOW = 17520; // 2y of hours
      for (let i = 0; i < n; i++) {
        if (isNaN(rv[i])) {
          mask[i] = false;
          continue;
        }
        const lo = Math.max(720, i - WINDOW);
        const slice: number[] = [];
        for (let k = lo; k <= i; k++) if (!isNaN(rv[k])) slice.push(rv[k]);
        if (slice.length < 200) {
          mask[i] = false;
          continue;
        }
        slice.sort((a, b) => a - b);
        const p30 = slice[Math.floor(slice.length * 0.3)];
        const p70 = slice[Math.floor(slice.length * 0.7)];
        mask[i] = rv[i] >= p30 && rv[i] <= p70;
      }
      return mask;
    }
    case "MG7_sma336_and_slope":
      for (let i = 336; i < n; i++) {
        const s336 = smaLast(closes.slice(i - 336, i), 336);
        const s168 = smaLast(closes.slice(i - 168, i), 168);
        mask[i] = closes[i] > s336 && s168 > s336;
      }
      for (let i = 0; i < 336 && i < n; i++) mask[i] = false;
      return mask;
  }
}

function mkCtx(candles: Candle[], htfLen: number, gate: MacroGate): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const r7 = rsiSeries(closes, 7);
  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = htfLen; i < candles.length; i++) {
    const sma = smaLast(closes.slice(i - htfLen, i), htfLen);
    trendMask[i] = candles[i].close > sma;
  }
  const macroMask = buildMacroMask(candles, gate);
  return { closes, highs, r7, htfLen, trendMask, macroMask };
}

function fireM(
  candles: Candle[],
  ctx: Ctx,
  i: number,
  m: Mech,
  p: { rsiTh: number; nHi: number; redPct: number },
): boolean {
  if (!ctx.trendMask[i]) return false;
  if (!ctx.macroMask[i]) return false;
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

const DEFAULT = { rsiTh: 40, nHi: 48, redPct: 0.005 };
const EXEC: ExecParams = { tp1: 0.008, tp2: 0.04, stop: 0.01, hold: 24 };

describe("iter 118 — macro gate rescue", () => {
  it(
    "test 7 macro-regime gates to rescue Q4 without killing the edge",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 118: macro-gate rescue ===");
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

      const gates: MacroGate[] = [
        "none",
        "MG1_sma336",
        "MG2_sma720",
        "MG3_ret30d",
        "MG4_sma168gt336",
        "MG5_ret90d",
        "MG6_vol",
        "MG7_sma336_and_slope",
      ];

      const qSize = Math.floor(c.length / 4);
      const q = [0, 1, 2, 3].map((k) => c.slice(k * qSize, (k + 1) * qSize));

      for (const gate of gates) {
        console.log(`\n── Gate: ${gate} ──`);
        const ctx = mkCtx(c, 168, gate);
        const tAll = runConcurrent(c, ctx, EXEC, 3, DEFAULT);
        const pnls = tAll.map((t) => t.pnl);
        const wins = pnls.filter((p) => p > 0).length;
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const sh = sharpeOf(pnls, 365 * 24);
        const tpd = tAll.length / days;
        const wr = tAll.length > 0 ? wins / tAll.length : 0;
        const bs = bootstrap(
          pnls,
          100,
          Math.max(10, Math.floor(pnls.length / 15)),
          gate.length * 13,
        );
        // windows
        const winRet: number[] = [];
        for (let w = 0; w < 10; w++) {
          const lo = w * bpw;
          const hi = (w + 1) * bpw;
          const wt = tAll.filter((t) => t.openBar >= lo && t.openBar < hi);
          winRet.push(wt.reduce((a, t) => a * (1 + t.pnl), 1) - 1);
        }
        const pctProf = winRet.filter((r) => r > 0).length / winRet.length;
        const minWin = Math.min(...winRet);
        console.log(
          `  FULL n=${tAll.length} tpd=${tpd.toFixed(2)} WR=${(
            wr * 100
          ).toFixed(1)}% ret=${(ret * 100).toFixed(1)}% Shp=${sh.toFixed(
            2,
          )} %prof=${(pctProf * 100).toFixed(0)}% minW=${(minWin * 100).toFixed(
            1,
          )}% bs+=${(bs.pctPositive * 100).toFixed(0)}% bs5%=${(bs.p5 * 100).toFixed(1)}%`,
        );
        // Quarters
        for (let k = 0; k < 4; k++) {
          const sub = q[k];
          const sctx = mkCtx(sub, 168, gate);
          const tq = runConcurrent(sub, sctx, EXEC, 3, DEFAULT);
          const pq = tq.map((t) => t.pnl);
          const rq = pq.reduce((a, p) => a * (1 + p), 1) - 1;
          const sq = sharpeOf(pq, 365 * 24);
          const wrq =
            pq.length > 0 ? pq.filter((p) => p > 0).length / pq.length : 0;
          console.log(
            `    Q${k + 1} n=${tq.length.toString().padStart(4)} tpd=${(
              tq.length /
              (sub.length / 24)
            ).toFixed(2)} WR=${(wrq * 100).toFixed(1)}% ret=${(
              rq * 100
            ).toFixed(1)}% Shp=${sq.toFixed(2)}`,
          );
        }
      }
    },
  );
});
