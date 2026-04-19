/**
 * Iter 124 — single-exit scan: raise avg profit/trade above 2%.
 *
 * User goal: keep WR ≈ 58%, lift avg profit/trade from current ~0.09% (full
 * size) to ≥ 2%. Current scale-out half-exits at +0.8% (TP1) which caps
 * roughly half of every winner at a tiny amount. REMOVE the scale-out and
 * let winners ride to a single exit with wider targets.
 *
 * We test on 1h (same mechanic ensemble as iter123) but with:
 *   - single-exit TP at {2%, 3%, 4%, 5%, 8%, 10%, 15%}
 *   - stops at {1%, 1.5%, 2%, 2.5%, 3%}
 *   - hold window {24, 48, 96, 168} hours
 *   - trailing-stop variant after +1% and +2% threshold
 *   - ATR-based target/stop (targetK × ATR, stopK × ATR)
 *
 * Collect avg profit/trade (arithmetic mean of pnl in %) and WR on 50k 1h
 * candles (2083 days). Top configs go to iter126 for full 5-gate validation.
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
function atrSeries(candles: Candle[], len: number): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < 2) return out;
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

interface Params {
  rsiTh: number;
  nHi: number;
  redPct: number;
  nDown: number;
  capK: number;
}

interface Ctx {
  closes: number[];
  highs: number[];
  r7: number[];
  atr: number[];
  trendMask: boolean[];
  macroMask: boolean[];
}
function mkCtx(candles: Candle[]): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const r7 = rsiSeries(closes, 7);
  const atr = atrSeries(candles, 14);
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
  return { closes, highs, r7, atr, trendMask, macroMask };
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

// ─── single-exit executor ───

type ExitMode =
  | { kind: "fixed"; tpPct: number; stopPct: number; hold: number }
  | {
      kind: "trail";
      tpPct: number;
      stopPct: number;
      hold: number;
      trailAfter: number;
      trailPct: number;
    }
  | {
      kind: "atr";
      tpMult: number;
      stopMult: number;
      hold: number;
    };

function executeLongSingle(
  candles: Candle[],
  i: number,
  atr: number[],
  mode: ExitMode,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  let tp: number, stop: number, hold: number;
  if (mode.kind === "atr") {
    const a = atr[i];
    if (!isFinite(a) || a <= 0) return null;
    tp = entry + mode.tpMult * a;
    stop = entry - mode.stopMult * a;
    hold = mode.hold;
  } else {
    tp = entry * (1 + mode.tpPct);
    stop = entry * (1 - mode.stopPct);
    hold = mode.hold;
  }
  const mx = Math.min(i + 1 + hold, candles.length - 1);
  let exitBar = mx;
  let exitPrice = candles[mx].close;
  let highSinceEntry = entry;

  for (let j = i + 2; j <= mx; j++) {
    const bar = candles[j];
    // Stop check first (pessimistic — order uncertain intrabar)
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
    // Trailing logic
    if (mode.kind === "trail") {
      if (bar.high > highSinceEntry) highSinceEntry = bar.high;
      const gain = (highSinceEntry - entry) / entry;
      if (gain >= mode.trailAfter) {
        const newStop = highSinceEntry * (1 - mode.trailPct);
        if (newStop > stop) stop = newStop;
      }
    }
  }
  const pnl = applyCosts({
    entry,
    exit: exitPrice,
    direction: "long",
    holdingHours: exitBar - (i + 1),
    config: MAKER_COSTS,
  }).netPnlPct;
  return { exitBar, pnl };
}

interface Trade {
  pnl: number;
  openBar: number;
}

function runConcurrent(
  candles: Candle[],
  ctx: Ctx,
  p: Params,
  mode: ExitMode,
): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
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
      const r = executeLongSingle(candles, i, ctx.atr, mode);
      if (!r) continue;
      // NOTE: no sizing division — we report full-size per-trade stats here
      trades.push({ pnl: r.pnl, openBar: i });
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
  meanPct: number;
  medPct: number;
  cumRet: number;
  sh: number;
  bsPos: number;
  bs5: number;
}

describe("iter 124 — single-exit scan: target ≥ 2% per trade", () => {
  it(
    "scan single-exit variants (fixed / trail / ATR) on 1h BTC",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 124: single-exit scan (target 2%/trade) ===");
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

      // Trigger params: iter123 default (same mechanics, same gates)
      const TRIG: Params = {
        rsiTh: 42,
        nHi: 36,
        redPct: 0.002,
        nDown: 2,
        capK: 4,
      };

      const results: Summary[] = [];
      const runOne = (label: string, mode: ExitMode, seed: number) => {
        const t = runConcurrent(c, ctx, TRIG, mode);
        if (t.length < 50) {
          console.log(`  ${label} — only ${t.length} trades, skipping`);
          return;
        }
        const pnls = t.map((x) => x.pnl);
        const wins = pnls.filter((p) => p > 0).length;
        const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
        const sorted = [...pnls].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        const cumRet = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const sh = sharpeOf(pnls);
        const tpd = t.length / days;
        const wr = wins / t.length;
        const bs = bootstrap(
          pnls,
          50,
          Math.max(10, Math.floor(pnls.length / 15)),
          seed,
        );
        results.push({
          label,
          n: t.length,
          tpd,
          wr,
          meanPct: mean,
          medPct: med,
          cumRet,
          sh,
          bsPos: bs.pctPositive,
          bs5: bs.p5,
        });
      };

      // 1) Fixed TP/stop grid
      for (const tp of [0.02, 0.03, 0.04, 0.05, 0.08, 0.1, 0.15]) {
        for (const stop of [0.01, 0.015, 0.02, 0.025, 0.03]) {
          for (const hold of [24, 48, 96]) {
            runOne(
              `fix tp=${(tp * 100).toFixed(0)}% stop=${(stop * 100).toFixed(1)}% hold=${hold}`,
              { kind: "fixed", tpPct: tp, stopPct: stop, hold },
              Math.round(tp * 10000 + stop * 1000 + hold),
            );
          }
        }
      }

      // 2) Trailing-stop grid (after reaching +trailAfter%, trail stop by trailPct of high)
      for (const tp of [0.05, 0.08, 0.1, 0.15]) {
        for (const stop of [0.015, 0.02, 0.025]) {
          for (const trailAfter of [0.01, 0.02, 0.03]) {
            for (const trailPct of [0.01, 0.02, 0.03]) {
              if (trailPct <= trailAfter) {
                runOne(
                  `trl tp=${(tp * 100).toFixed(0)}% s=${(stop * 100).toFixed(1)}% after=${(trailAfter * 100).toFixed(1)}% tr=${(trailPct * 100).toFixed(1)}%`,
                  {
                    kind: "trail",
                    tpPct: tp,
                    stopPct: stop,
                    hold: 96,
                    trailAfter,
                    trailPct,
                  },
                  Math.round(
                    tp * 1e5 + stop * 1e4 + trailAfter * 1e3 + trailPct * 100,
                  ),
                );
              }
            }
          }
        }
      }

      // 3) ATR-based grid
      for (const tpM of [1.5, 2, 3, 4, 5, 6, 8]) {
        for (const stopM of [0.5, 1, 1.5, 2]) {
          for (const hold of [48, 96, 168]) {
            runOne(
              `atr tp=${tpM}× s=${stopM}× hold=${hold}`,
              { kind: "atr", tpMult: tpM, stopMult: stopM, hold },
              Math.round(tpM * 1000 + stopM * 100 + hold),
            );
          }
        }
      }

      // Filter: WR ≥ 55% and meanPct ≥ 0.02 (2%)
      const winners = results
        .filter((r) => r.wr >= 0.55 && r.meanPct >= 0.02 && r.cumRet > 0)
        .sort((a, b) => b.meanPct - a.meanPct);

      console.log(
        "\n═══ Top 30 by meanPct, filtered (WR≥55% AND mean≥2% AND ret>0) ═══",
      );
      console.log(
        "label".padEnd(48) +
          "    n   tpd   WR    mean%  cumRet   Shp   bs+  bs5%",
      );
      for (const r of winners.slice(0, 30)) {
        console.log(
          `${r.label.padEnd(48)}${r.n.toString().padStart(5)} ${r.tpd.toFixed(2)} ${(r.wr * 100).toFixed(1)}% ${(r.meanPct * 100).toFixed(2).padStart(6)}% ${(r.cumRet * 100).toFixed(0).padStart(6)}% ${r.sh.toFixed(2).padStart(5)} ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(r.bs5 * 100).toFixed(1).padStart(6)}%`,
        );
      }
      console.log(`\ntotal configs passed filter: ${winners.length}`);

      // Also show top 10 by cumRet (compounding) filter WR ≥ 55%
      const byCum = results
        .filter((r) => r.wr >= 0.55 && r.cumRet > 0)
        .sort((a, b) => b.cumRet - a.cumRet)
        .slice(0, 10);
      console.log("\n── Top 10 by cumRet (WR≥55%) for reference ──");
      for (const r of byCum) {
        console.log(
          `${r.label.padEnd(48)}${r.n.toString().padStart(5)} tpd=${r.tpd.toFixed(2)} WR=${(r.wr * 100).toFixed(1)}% mean=${(r.meanPct * 100).toFixed(2)}% ret=${(r.cumRet * 100).toFixed(0)}% Shp=${r.sh.toFixed(2)}`,
        );
      }

      // Top 10 by WR (to see what happens if we optimize for WR only)
      const byWr = results
        .filter((r) => r.n >= 100)
        .sort((a, b) => b.wr - a.wr)
        .slice(0, 10);
      console.log("\n── Top 10 by WR (n≥100) for reference ──");
      for (const r of byWr) {
        console.log(
          `${r.label.padEnd(48)}${r.n.toString().padStart(5)} tpd=${r.tpd.toFixed(2)} WR=${(r.wr * 100).toFixed(1)}% mean=${(r.meanPct * 100).toFixed(2)}% ret=${(r.cumRet * 100).toFixed(0)}% Shp=${r.sh.toFixed(2)}`,
        );
      }
    },
  );
});
