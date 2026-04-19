/**
 * Iter 116 — BTC ensemble #2: concurrent positions + 15m mechanics.
 *
 * iter115 showed that OR-combining 4 mechanics via cooldown LOSES alpha
 * (M1 alone returned +34.6% in iter114, but only +5.1% as part of the
 * ensemble — cooldown stole ~85% of its trades to other mechanics that
 * aren't strictly better).
 *
 * Two fixes explored here:
 *
 * A) "Independent books" on 1h — each of M1/M4/M5/M6 runs standalone with
 *    iter114 params; portfolio = equal-weighted compound (0.25 per book).
 *    Captures per-mechanic alpha additively, preserves full trade count, but
 *    requires 4× capital.
 *
 * B) "Concurrent positions, cap=K" — merge signals from all 4 mechanics,
 *    allow up to K simultaneous positions with 1/K sizing each. This is the
 *    realistic single-book version of A.
 *
 * C) Repeat the iter114 scan on 15m BTC (same 6 mechanics) to see if shorter
 *    bars can deliver more tpd per mechanic while keeping multi-year survival.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const BTC = "BTCUSDT";

// ───── shared helpers ─────

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

// ───── execution ─────

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
): { exitBar: number; pnl: number; holdBars: number } | null {
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
  return {
    exitBar: l2B,
    pnl: 0.5 * leg1 + 0.5 * leg2,
    holdBars: l2B - (i + 1),
  };
}

// ───── signal generators (parameterizable) ─────

type Mech = "M1" | "M4" | "M5" | "M6";

interface SigGen {
  mech: Mech;
  fire: (candles: Candle[], ctx: CandleCtx, i: number) => boolean;
  readyFromBar: (candles: Candle[], ctx: CandleCtx) => number;
}

interface CandleCtx {
  closes: number[];
  highs: number[];
  r7: number[];
  htfLen: number;
  trendMask: boolean[];
}

function mkCtx(candles: Candle[], htfLen: number): CandleCtx {
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

function genM1_nDown(): SigGen {
  return {
    mech: "M1",
    readyFromBar: (_, ctx) => ctx.htfLen + 2,
    fire: (candles, ctx, i) => {
      if (!ctx.trendMask[i]) return false;
      return (
        ctx.closes[i] < ctx.closes[i - 1] &&
        ctx.closes[i - 1] < ctx.closes[i - 2]
      );
    },
  };
}
function genM4_rsi(th: number): SigGen {
  return {
    mech: "M4",
    readyFromBar: (_, ctx) => Math.max(ctx.htfLen, 8),
    fire: (_, ctx, i) => ctx.trendMask[i] && ctx.r7[i] <= th,
  };
}
function genM5_brk(nHi: number): SigGen {
  return {
    mech: "M5",
    readyFromBar: (_, ctx) => Math.max(ctx.htfLen, nHi + 1),
    fire: (candles, ctx, i) => {
      if (!ctx.trendMask[i]) return false;
      const prevMax = maxLast(ctx.highs.slice(i - nHi, i), nHi);
      return candles[i].close > prevMax;
    },
  };
}
function genM6_redBar(thPct: number): SigGen {
  return {
    mech: "M6",
    readyFromBar: (_, ctx) => ctx.htfLen + 1,
    fire: (candles, ctx, i) => {
      if (!ctx.trendMask[i]) return false;
      const o = candles[i].open;
      const c = candles[i].close;
      if (o <= 0) return false;
      return (c - o) / o <= -thPct;
    },
  };
}

// ───── standalone runner (with internal cooldown, per-mechanic) ─────

interface Trade {
  pnl: number;
  openBar: number;
  exitBar: number;
  mech: Mech;
}

function runStandalone(
  candles: Candle[],
  ctx: CandleCtx,
  gen: SigGen,
  p: ExecParams,
  avoidHour0 = true,
): Trade[] {
  const trades: Trade[] = [];
  let cool = -1;
  const start = gen.readyFromBar(candles, ctx);
  for (let i = start; i < candles.length - 1; i++) {
    if (i < cool) continue;
    if (avoidHour0 && new Date(candles[i].openTime).getUTCHours() === 0)
      continue;
    if (!gen.fire(candles, ctx, i)) continue;
    const r = executeLong(candles, i, p);
    if (!r) continue;
    trades.push({ pnl: r.pnl, openBar: i, exitBar: r.exitBar, mech: gen.mech });
    cool = r.exitBar + 1;
  }
  return trades;
}

// ───── concurrent-positions runner (capK) ─────

function runConcurrent(
  candles: Candle[],
  gens: SigGen[],
  ctxMap: Map<Mech, CandleCtx>,
  p: ExecParams,
  capK: number,
  avoidHour0 = true,
): Trade[] {
  const openExits: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const longest = Math.max(...Array.from(ctxMap.values()).map((c) => c.htfLen));
  for (let i = longest + 2; i < candles.length - 1; i++) {
    // Drop positions whose exit is in the past
    for (let k = openExits.length - 1; k >= 0; k--) {
      if (openExits[k].exitBar < i) openExits.splice(k, 1);
    }
    if (openExits.length >= capK) continue;
    if (avoidHour0 && new Date(candles[i].openTime).getUTCHours() === 0)
      continue;
    for (const gen of gens) {
      if (openExits.length >= capK) break;
      const ctx = ctxMap.get(gen.mech)!;
      if (i < gen.readyFromBar(candles, ctx)) continue;
      if (!gen.fire(candles, ctx, i)) continue;
      // Skip if this mechanic already has an open position (to diversify)
      if (openExits.some((o) => o.mech === gen.mech)) continue;
      const r = executeLong(candles, i, p);
      if (!r) continue;
      // size = 1/capK so concurrent-maxed-out equals 1x leverage
      trades.push({
        pnl: r.pnl / capK,
        openBar: i,
        exitBar: r.exitBar,
        mech: gen.mech,
      });
      openExits.push({ exitBar: r.exitBar, mech: gen.mech });
    }
  }
  return trades;
}

function reportTrades(
  label: string,
  trades: Trade[],
  days: number,
  bpw: number,
  barsPerYear: number,
  seed: number,
): void {
  if (trades.length === 0) {
    console.log(`${label} — empty`);
    return;
  }
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const sh = sharpeOf(pnls, barsPerYear);
  const tpd = trades.length / days;
  const wr = wins / trades.length;
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
    30,
    Math.max(10, Math.floor(pnls.length / 15)),
    seed,
  );
  console.log(
    `${label}  n=${trades.length} tpd=${tpd.toFixed(2)} WR=${(wr * 100).toFixed(
      1,
    )}% ret=${(ret * 100).toFixed(1)}% Shp=${sh.toFixed(
      2,
    )} %prof=${(pctProf * 100).toFixed(0)}% minW=${(minWin * 100).toFixed(
      1,
    )}% bs+=${(bs.pctPositive * 100).toFixed(0)}% bs5%=${(bs.p5 * 100).toFixed(1)}%`,
  );
}

describe("iter 116 — BTC ensemble fixes", () => {
  it(
    "independent books + concurrent positions (1h) + 15m scan",
    { timeout: 1_200_000 },
    async () => {
      console.log("\n=== ITER 116: concurrent + 15m BTC ===");

      // ═══ 1h ═══
      console.log("\n── Loading 50k 1h BTC candles (2083 days) ──");
      const c1 = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const days1 = c1.length / 24;
      const bpw1 = Math.floor(c1.length / 10);
      const HTF_1H = 168;

      const ctxH1 = mkCtx(c1, HTF_1H);
      const EXEC_1H: ExecParams = {
        tp1: 0.008,
        tp2: 0.04,
        stop: 0.01,
        hold: 24,
      };

      const genList1h: SigGen[] = [
        genM1_nDown(),
        genM4_rsi(40),
        genM5_brk(48),
        genM6_redBar(0.005),
      ];
      const ctxMap1h: Map<Mech, CandleCtx> = new Map();
      for (const g of genList1h) ctxMap1h.set(g.mech, ctxH1);

      console.log("\n── Standalone per-mechanic (1h) ──");
      const standalone1h: Map<Mech, Trade[]> = new Map();
      for (const g of genList1h) {
        const t = runStandalone(c1, ctxH1, g, EXEC_1H);
        standalone1h.set(g.mech, t);
        reportTrades(`${g.mech} standalone (1h)`, t, days1, bpw1, 365 * 24, 1);
      }

      // ── A) Independent books: equal-weighted, 0.25 per book ──
      console.log("\n── A) Independent books (0.25 per mechanic, 1h) ──");
      const capital = [0.25, 0.25, 0.25, 0.25];
      const mechIds: Mech[] = ["M1", "M4", "M5", "M6"];
      const perBookRet: number[] = mechIds.map((m) => {
        const t = standalone1h.get(m)!;
        return t.reduce((a, x) => a * (1 + x.pnl), 1) - 1;
      });
      const totalRet = capital.reduce(
        (acc, w, i) => acc + w * perBookRet[i],
        0,
      );
      const totalTrades = mechIds.reduce(
        (a, m) => a + standalone1h.get(m)!.length,
        0,
      );
      console.log(
        `  equal-weighted compound: totalRet=${(totalRet * 100).toFixed(
          1,
        )}% totalTrades=${totalTrades} tpd=${(totalTrades / days1).toFixed(2)}`,
      );
      perBookRet.forEach((r, i) =>
        console.log(
          `    book ${mechIds[i]}: ret=${(r * 100).toFixed(1)}% n=${standalone1h.get(mechIds[i])!.length}`,
        ),
      );

      // ── B) Concurrent positions, cap K = {2,3,4} (1h) ──
      console.log("\n── B) Concurrent positions (1h, caps 2/3/4) ──");
      for (const K of [2, 3, 4]) {
        const t = runConcurrent(c1, genList1h, ctxMap1h, EXEC_1H, K);
        reportTrades(
          `concurrent cap=${K} (1h)`,
          t,
          days1,
          bpw1,
          365 * 24,
          100 + K,
        );
        const byMech = new Map<Mech, number>();
        for (const tr of t) byMech.set(tr.mech, (byMech.get(tr.mech) ?? 0) + 1);
        console.log(
          `  by-mech: ${Array.from(byMech.entries())
            .map(([m, n]) => `${m}=${n}`)
            .join(" ")}`,
        );
      }

      // ═══ 15m ═══
      console.log("\n── Loading 100k 15m BTC candles (1041 days) ──");
      const c15 = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "15m",
        targetCount: 100_000,
        maxPages: 100,
      });
      const days15 = c15.length / 96;
      const bpw15 = Math.floor(c15.length / 10);
      const HTF_15M = 4 * 168; // same ~7 days HTF

      const ctxH15 = mkCtx(c15, HTF_15M);
      const EXEC_15M: ExecParams = {
        tp1: 0.003,
        tp2: 0.012,
        stop: 0.005,
        hold: 4 * 12, // 12 hours
      };

      const genList15: SigGen[] = [
        genM1_nDown(),
        genM4_rsi(40),
        genM5_brk(4 * 48), // 48h breakout on 15m
        genM6_redBar(0.003),
      ];
      const ctxMap15: Map<Mech, CandleCtx> = new Map();
      for (const g of genList15) ctxMap15.set(g.mech, ctxH15);

      console.log("\n── Standalone per-mechanic (15m) ──");
      for (const g of genList15) {
        const t = runStandalone(c15, ctxH15, g, EXEC_15M);
        reportTrades(
          `${g.mech} standalone (15m)`,
          t,
          days15,
          bpw15,
          365 * 24 * 4,
          200 + g.mech.charCodeAt(1),
        );
      }

      console.log("\n── Concurrent cap=3 (15m) ──");
      const t15c = runConcurrent(c15, genList15, ctxMap15, EXEC_15M, 3);
      reportTrades(
        `concurrent cap=3 (15m)`,
        t15c,
        days15,
        bpw15,
        365 * 24 * 4,
        999,
      );

      // Q1/Q2/Q3/Q4 stress on 15m cap=3
      console.log("\n── 15m cap=3 walk-forward ──");
      const qSize = Math.floor(c15.length / 4);
      for (let k = 0; k < 4; k++) {
        const sub = c15.slice(k * qSize, (k + 1) * qSize);
        const ctxSub = mkCtx(sub, HTF_15M);
        const map: Map<Mech, CandleCtx> = new Map();
        for (const g of genList15) map.set(g.mech, ctxSub);
        const tq = runConcurrent(sub, genList15, map, EXEC_15M, 3);
        const days = sub.length / 96;
        if (tq.length === 0) {
          console.log(`Q${k + 1}: no trades`);
          continue;
        }
        const pnls = tq.map((x) => x.pnl);
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const w = pnls.filter((p) => p > 0).length;
        const sh = sharpeOf(pnls, 365 * 24 * 4);
        console.log(
          `Q${k + 1} n=${tq.length} tpd=${(tq.length / days).toFixed(
            2,
          )} WR=${((w / tq.length) * 100).toFixed(1)}% ret=${(ret * 100).toFixed(1)}% Shp=${sh.toFixed(2)}`,
        );
      }
    },
  );
});
