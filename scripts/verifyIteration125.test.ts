/**
 * Iter 125 — swing on 4h and 1d: can avg profit/trade break 2%?
 *
 * iter124 proved that on 1h BTC with our 4-mechanic ensemble, the mean
 * profit/trade is structurally capped at ~0.30% (even with 8-15% TP and
 * trailing stops, early trail-outs pull the average down).
 *
 * Shift to higher timeframes where each bar spans a bigger move:
 *   - 4h: 12 500 bars = 2083 days (HTF scaled 42 bars = 168h / macro 180 bars = 30d)
 *   - 1d: ~2900 bars = ~8 years of BTC history (HTF scaled 7 bars = 7d / macro 30 bars)
 *
 * Scaled triggers on each timeframe:
 *   htfLen: 42 (4h) / 7 (1d)        — same 7-day trend gate
 *   macro:  180 (4h) / 30 (1d)      — same 30-day macro drift gate
 *   nDown:  2                        — same structural pullback
 *   rsi:    7-period RSI (same on all timeframes)
 *   nHi:    9 (4h, ≈36h) / 2 (1d, ≈2d)  — approximate iter123 geometry
 *
 * Tested exits:
 *   - Fixed TP/stop grid (TP up to 30%)
 *   - Trailing stops
 *   - Hold: 24/48/96 bars on 4h = 4/8/16 days; 5/10/20 bars on 1d
 *
 * Pass filter: n ≥ 50, WR ≥ 55%, mean ≥ 2%, cumRet > 0
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle, Candle as C2 } from "../src/utils/indicators";
import type { LiveTimeframe } from "../src/hooks/useLiveCandles";

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

interface TFParams {
  htfLen: number;
  macroBars: number;
  nHi: number;
  rsiTh: number;
  redPct: number;
  nDown: number;
  capK: number;
}

interface Ctx {
  closes: number[];
  highs: number[];
  r7: number[];
  trendMask: boolean[];
  macroMask: boolean[];
}

function mkCtx(candles: Candle[], p: TFParams): Ctx {
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
  p: TFParams,
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

type ExitMode =
  | { kind: "fixed"; tpPct: number; stopPct: number; hold: number }
  | {
      kind: "trail";
      tpPct: number;
      stopPct: number;
      hold: number;
      trailAfter: number;
      trailPct: number;
    };

function executeLongSingle(
  candles: C2[],
  i: number,
  mode: ExitMode,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  let tp = entry * (1 + mode.tpPct);
  let stop = entry * (1 - mode.stopPct);
  const hold = mode.hold;
  const mx = Math.min(i + 1 + hold, candles.length - 1);
  let exitBar = mx;
  let exitPrice = candles[mx].close;
  let highSinceEntry = entry;
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
    if (mode.kind === "trail") {
      if (bar.high > highSinceEntry) highSinceEntry = bar.high;
      const gain = (highSinceEntry - entry) / entry;
      if (gain >= mode.trailAfter) {
        const newStop = highSinceEntry * (1 - mode.trailPct);
        if (newStop > stop) stop = newStop;
      }
    }
  }
  const barMs =
    candles.length > 1 ? candles[1].openTime - candles[0].openTime : 3600_000;
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

interface Trade {
  pnl: number;
  openBar: number;
}

function runConcurrent(
  candles: Candle[],
  ctx: Ctx,
  p: TFParams,
  mode: ExitMode,
  startAt: number,
): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  for (let i = startAt; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= p.capK) continue;
    for (const m of mechs) {
      if (open.length >= p.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m, p)) continue;
      const r = executeLongSingle(candles, i, mode);
      if (!r) continue;
      trades.push({ pnl: r.pnl, openBar: i });
      open.push({ exitBar: r.exitBar, mech: m });
    }
  }
  return trades;
}

interface Summary {
  label: string;
  tf: string;
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

describe("iter 125 — 4h and 1d swing tests", () => {
  it(
    "hunt for ≥2% mean profit/trade on higher timeframes",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 125: 4h + 1d swing scan ===");
      const tfs: Array<{
        tf: LiveTimeframe;
        bpd: number;
        p: TFParams;
        holds: number[];
        targetN: number;
      }> = [
        {
          tf: "4h",
          bpd: 6,
          p: {
            htfLen: 42,
            macroBars: 180,
            nHi: 9,
            rsiTh: 42,
            redPct: 0.005,
            nDown: 2,
            capK: 4,
          },
          holds: [12, 24, 48, 96],
          targetN: 12_500,
        },
        {
          tf: "1d",
          bpd: 1,
          p: {
            htfLen: 7,
            macroBars: 30,
            nHi: 3,
            rsiTh: 42,
            redPct: 0.01,
            nDown: 2,
            capK: 4,
          },
          holds: [5, 10, 20, 40],
          targetN: 3000,
        },
      ];

      const results: Summary[] = [];

      for (const t of tfs) {
        console.log(`\n══ Loading ${t.tf} BTC candles ══`);
        const c = await loadBinanceHistory({
          symbol: "BTCUSDT",
          timeframe: t.tf,
          targetCount: t.targetN,
          maxPages: 100,
        });
        const days = c.length / t.bpd;
        console.log(`  ${t.tf}: ${c.length} candles = ${days.toFixed(0)} days`);
        const ctx = mkCtx(c, t.p);
        const startAt = Math.max(t.p.htfLen, t.p.macroBars, t.p.nHi + 1) + 1;
        const barsPerYear = 365 * t.bpd;

        const runOne = (label: string, mode: ExitMode, seed: number) => {
          const trades = runConcurrent(c, ctx, t.p, mode, startAt);
          if (trades.length < 30) return;
          const pnls = trades.map((x) => x.pnl);
          const wins = pnls.filter((p) => p > 0).length;
          const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
          const sorted = [...pnls].sort((a, b) => a - b);
          const med = sorted[Math.floor(sorted.length / 2)];
          const cumRet = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
          const sh = sharpeOf(pnls, barsPerYear);
          const tpd = trades.length / days;
          const wr = wins / trades.length;
          const bs = bootstrap(
            pnls,
            50,
            Math.max(5, Math.floor(pnls.length / 15)),
            seed,
          );
          results.push({
            label,
            tf: t.tf,
            n: trades.length,
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

        // Fixed grid
        for (const tp of [0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3]) {
          for (const stop of [0.02, 0.03, 0.05, 0.07]) {
            for (const hold of t.holds) {
              runOne(
                `fix tp=${(tp * 100).toFixed(0)}% s=${(stop * 100).toFixed(0)}% h=${hold}`,
                { kind: "fixed", tpPct: tp, stopPct: stop, hold },
                Math.round(tp * 10000 + stop * 1000 + hold),
              );
            }
          }
        }
        // Trailing grid
        for (const tp of [0.1, 0.15, 0.2, 0.3]) {
          for (const stop of [0.03, 0.05]) {
            for (const trailAfter of [0.03, 0.05, 0.08]) {
              for (const trailPct of [0.03, 0.05, 0.08]) {
                if (trailPct <= trailAfter) {
                  runOne(
                    `trl tp=${(tp * 100).toFixed(0)}% s=${(stop * 100).toFixed(0)}% a=${(trailAfter * 100).toFixed(0)}% tr=${(trailPct * 100).toFixed(0)}%`,
                    {
                      kind: "trail",
                      tpPct: tp,
                      stopPct: stop,
                      hold: t.holds[t.holds.length - 1],
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
      }

      const winners = results
        .filter(
          (r) => r.wr >= 0.55 && r.meanPct >= 0.02 && r.cumRet > 0 && r.n >= 50,
        )
        .sort((a, b) => b.meanPct - a.meanPct);

      console.log("\n═══ Top 40 winners (WR≥55%, mean≥2%, n≥50, cumRet>0) ═══");
      console.log(
        "tf  label".padEnd(56) +
          "   n    tpd   WR   mean%   med%   cumRet   Shp   bs+",
      );
      for (const r of winners.slice(0, 40)) {
        console.log(
          `${r.tf} ${r.label.padEnd(50)}${r.n.toString().padStart(4)} ${r.tpd.toFixed(3)} ${(r.wr * 100).toFixed(1)}% ${(r.meanPct * 100).toFixed(2).padStart(6)}% ${(r.medPct * 100).toFixed(2).padStart(6)}% ${(r.cumRet * 100).toFixed(0).padStart(7)}% ${r.sh.toFixed(2).padStart(5)} ${(r.bsPos * 100).toFixed(0).padStart(3)}%`,
        );
      }
      console.log(`\nTotal passing: ${winners.length}`);

      // Extra: max mean per TF
      for (const tf of ["4h", "1d"]) {
        const best = results
          .filter((r) => r.tf === tf && r.n >= 50)
          .sort((a, b) => b.meanPct - a.meanPct)
          .slice(0, 5);
        console.log(`\nTop 5 by mean on ${tf} (any WR):`);
        for (const r of best) {
          console.log(
            `  ${r.label.padEnd(50)} n=${r.n} tpd=${r.tpd.toFixed(3)} WR=${(r.wr * 100).toFixed(1)}% mean=${(r.meanPct * 100).toFixed(2)}% ret=${(r.cumRet * 100).toFixed(0)}% Shp=${r.sh.toFixed(2)}`,
          );
        }
      }
    },
  );
});
