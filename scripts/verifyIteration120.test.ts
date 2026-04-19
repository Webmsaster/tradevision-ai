/**
 * Iter 120 — lift tpd to 2-3 while keeping iter119 robustness.
 *
 * Goal: user wants MORE trades per day (target 2-3 tpd) without breaking
 * the 5-gate lock from iter119. Strategy: loosen the mechanic params with
 * the MG3 macro gate STILL ON, plus test:
 *
 *   a) looser M4 RSI threshold (higher rsiTh → more oversold bounces)
 *   b) smaller M5 breakout lookback (more breakouts)
 *   c) smaller M6 red-bar threshold (more fades)
 *   d) M1 nDown = 1 or 2 (instead of 2) — more frequent pullbacks
 *   e) higher maxConcurrent (4 or 5)
 *   f) add 5th mechanic: close > high[i−1] + in uptrend (simple continuation)
 *
 * Each config is ranked by:  score = tpd × sqrt(max(0, Sharpe)) × bs+
 * Top configs with tpd ≥ 2 AND Sharpe ≥ 4 AND bs+ ≥ 95% are candidates.
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

interface ExecParams {
  tp1: number;
  tp2: number;
  stop: number;
  hold: number;
}
const EXEC: ExecParams = { tp1: 0.008, tp2: 0.04, stop: 0.01, hold: 24 };

function executeLong(
  candles: Candle[],
  i: number,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp1L = entry * (1 + EXEC.tp1);
  const tp2L = entry * (1 + EXEC.tp2);
  let sL = entry * (1 - EXEC.stop);
  const mx = Math.min(i + 1 + EXEC.hold, candles.length - 1);
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

type Mech = "M1" | "M4" | "M5" | "M6" | "M7";

interface Params {
  rsiTh: number;
  nHi: number;
  redPct: number;
  nDown: number; // M1 consecutive lower closes
  capK: number;
  includeM7: boolean; // higher-high continuation
}

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
  for (let i = 168; i < candles.length; i++) {
    const s = smaLast(closes.slice(i - 168, i), 168);
    trendMask[i] = candles[i].close > s;
  }
  const macroMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = 720; i < candles.length; i++) {
    const past = closes[i - 720];
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
    case "M7":
      if (i < 1) return false;
      return (
        candles[i].close > candles[i - 1].high &&
        candles[i].close > candles[i - 1].close
      );
  }
}

interface Trade {
  pnl: number;
  openBar: number;
  mech: Mech;
}

function runConcurrent(candles: Candle[], ctx: Ctx, p: Params): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = p.includeM7
    ? ["M1", "M4", "M5", "M6", "M7"]
    : ["M1", "M4", "M5", "M6"];
  for (let i = 722; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= p.capK) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    for (const m of mechs) {
      if (open.length >= p.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m, p)) continue;
      const r = executeLong(candles, i);
      if (!r) continue;
      trades.push({ pnl: r.pnl / p.capK, openBar: i, mech: m });
      open.push({ exitBar: r.exitBar, mech: m });
    }
  }
  return trades;
}

interface Summary {
  label: string;
  n: number;
  tpd: number;
  wr: number;
  ret: number;
  sh: number;
  bsPos: number;
  bs5: number;
  score: number;
}

describe("iter 120 — looser param scan", () => {
  it(
    "hunt for 2-3 tpd configs that preserve iter119 bootstrap quality",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 120: looser param scan ===");
      const c = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1h",
        targetCount: TARGET_CANDLES,
        maxPages: 100,
      });
      const days = c.length / 24;
      console.log(
        `loaded ${c.length} 1h BTC candles (${days.toFixed(0)} days)`,
      );
      const ctx = mkCtx(c);

      // Baseline iter119 reference
      const baseline: Params = {
        rsiTh: 40,
        nHi: 48,
        redPct: 0.005,
        nDown: 2,
        capK: 3,
        includeM7: false,
      };

      const results: Summary[] = [];

      const runOne = (label: string, p: Params, seed: number) => {
        const t = runConcurrent(c, ctx, p);
        if (t.length === 0) return;
        const pnls = t.map((x) => x.pnl);
        const wins = pnls.filter((x) => x > 0).length;
        const ret = pnls.reduce((a, x) => a * (1 + x), 1) - 1;
        const sh = sharpeOf(pnls);
        const tpd = t.length / days;
        const wr = wins / t.length;
        const bs = bootstrap(
          pnls,
          50,
          Math.max(10, Math.floor(pnls.length / 15)),
          seed,
        );
        const score = tpd * Math.sqrt(Math.max(0, sh)) * bs.pctPositive;
        results.push({
          label,
          n: t.length,
          tpd,
          wr,
          ret,
          sh,
          bsPos: bs.pctPositive,
          bs5: bs.p5,
          score,
        });
      };

      // 1) cap sweep with baseline params
      for (const capK of [3, 4, 5]) {
        runOne(`base cap=${capK}`, { ...baseline, capK }, 10 + capK);
      }

      // 2) single-dim loosening (keep other dims at baseline, cap=4)
      const baseCap4: Params = { ...baseline, capK: 4 };
      for (const rsiTh of [40, 42, 45, 48, 50]) {
        runOne(`rsiTh=${rsiTh}`, { ...baseCap4, rsiTh }, 100 + rsiTh);
      }
      for (const nHi of [18, 24, 30, 36, 48]) {
        runOne(`nHi=${nHi}`, { ...baseCap4, nHi }, 200 + nHi);
      }
      for (const redPct of [0.002, 0.003, 0.004, 0.005]) {
        runOne(
          `redPct=${(redPct * 100).toFixed(1)}%`,
          { ...baseCap4, redPct },
          300 + Math.round(redPct * 1000),
        );
      }
      for (const nDown of [1, 2, 3]) {
        runOne(`nDown=${nDown}`, { ...baseCap4, nDown }, 400 + nDown);
      }
      runOne("addM7", { ...baseCap4, includeM7: true }, 500);

      // 3) joint loose configs (combinations worth testing)
      const combos: Array<{ name: string; p: Params }> = [
        {
          name: "LOOSE-A rsi45 nHi24 red0.003 nD1 cap4",
          p: {
            rsiTh: 45,
            nHi: 24,
            redPct: 0.003,
            nDown: 1,
            capK: 4,
            includeM7: false,
          },
        },
        {
          name: "LOOSE-B rsi45 nHi24 red0.003 nD2 cap4 +M7",
          p: {
            rsiTh: 45,
            nHi: 24,
            redPct: 0.003,
            nDown: 2,
            capK: 4,
            includeM7: true,
          },
        },
        {
          name: "LOOSE-C rsi50 nHi18 red0.003 nD1 cap4",
          p: {
            rsiTh: 50,
            nHi: 18,
            redPct: 0.003,
            nDown: 1,
            capK: 4,
            includeM7: false,
          },
        },
        {
          name: "LOOSE-D rsi45 nHi36 red0.004 nD2 cap5",
          p: {
            rsiTh: 45,
            nHi: 36,
            redPct: 0.004,
            nDown: 2,
            capK: 5,
            includeM7: false,
          },
        },
        {
          name: "LOOSE-E rsi48 nHi24 red0.003 nD2 cap4 +M7",
          p: {
            rsiTh: 48,
            nHi: 24,
            redPct: 0.003,
            nDown: 2,
            capK: 4,
            includeM7: true,
          },
        },
        {
          name: "LOOSE-F rsi45 nHi24 red0.003 nD1 cap5 +M7",
          p: {
            rsiTh: 45,
            nHi: 24,
            redPct: 0.003,
            nDown: 1,
            capK: 5,
            includeM7: true,
          },
        },
      ];
      for (const c of combos) runOne(c.name, c.p, c.name.length * 7);

      // Print ranked table
      results.sort((a, b) => b.score - a.score);
      console.log(
        "\nlabel".padEnd(48) +
          "   n     tpd    WR     ret      Shp     bs+    bs5%    score",
      );
      for (const r of results.slice(0, 40)) {
        const mark = r.tpd >= 2 && r.sh >= 4 && r.bsPos >= 0.95 ? " ★" : "";
        console.log(
          `${r.label.padEnd(48)} ${r.n
            .toString()
            .padStart(4)} ${r.tpd.toFixed(2)} ${(r.wr * 100).toFixed(
            1,
          )}% ${(r.ret * 100).toFixed(1).padStart(6)}% ${r.sh
            .toFixed(2)
            .padStart(5)} ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(
            r.bs5 * 100
          )
            .toFixed(1)
            .padStart(6)}% ${r.score.toFixed(2)}${mark}`,
        );
      }

      console.log("\nPass (tpd ≥ 2 AND Sharpe ≥ 4 AND bs+ ≥ 95%):");
      for (const r of results) {
        if (r.tpd >= 2 && r.sh >= 4 && r.bsPos >= 0.95) {
          console.log(
            `  ★ ${r.label}  tpd=${r.tpd.toFixed(2)} Shp=${r.sh.toFixed(
              2,
            )} ret=${(r.ret * 100).toFixed(1)}% bs+=${(r.bsPos * 100).toFixed(0)}%`,
          );
        }
      }
    },
  );
});
