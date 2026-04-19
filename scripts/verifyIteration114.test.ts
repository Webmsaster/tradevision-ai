/**
 * Iter 114 — BTC-only multi-mechanic deep scan.
 *
 * Goal: find BTC daytrading configs that (a) survive ~2000 days of 1h data,
 * (b) produce ≥2 trades/day at portfolio level, (c) post Sharpe≥3 and positive
 * cumRet. iter113's dip-buy works but only 0.31 tpd solo / 1.17 tpd on 4-asset
 * basket. We now try 6 orthogonal LONG-ONLY BTC mechanics in parallel so the
 * final stack can fire multiple times per day on the same symbol.
 *
 * Execution is uniform across mechanics (scale-out tp1/tp2, BE after tp1,
 * stop, max-hold). Only the TRIGGER differs. This is deliberate so the
 * mechanics are comparable and can later be OR-combined into one engine.
 *
 * Mechanics:
 *   M1 nDown   — N consecutive close-lower bars in HTF uptrend  (baseline iter109)
 *   M2 nUp     — N consecutive close-higher bars in HTF uptrend (momentum)
 *   M3 pullSma — close dips ≤ SMA(htf) by ≤k% then bounces (mean-revert-to-trend)
 *   M4 rsiOS   — RSI(len) ≤ th in HTF uptrend (oversold rebound)
 *   M5 brkOut  — close > max(last Nhi highs) in HTF uptrend   (breakout)
 *   M6 redBar  — one candle (close−open)/open ≤ -k% in uptrend (single-bar fade)
 *
 * Pass gate:
 *   trades ≥ 300, tpd ≥ 0.15, WR ≥ 52%, cumRet > 0, Sharpe ≥ 2,
 *   ≥ 50% of 10 disjoint windows profitable.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const BTC = "BTCUSDT";
const TARGET_CANDLES = 50_000; // ~2083 days

// ────────────────────────────── helpers ────────────────────────────────

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

interface Trade {
  pnl: number;
  openBar: number;
}

// Uniform long-only scale-out executor. Returns one trade (or null).
function executeLong(
  candles: Candle[],
  i: number,
  tp1Pct: number,
  tp2Pct: number,
  stopPct: number,
  holdBars: number,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp1 = entry * (1 + tp1Pct);
  const tp2 = entry * (1 + tp2Pct);
  let sL = entry * (1 - stopPct);
  const mx = Math.min(i + 1 + holdBars, candles.length - 1);
  let tp1Hit = false;
  let tp1Bar = -1;
  let l2P = candles[mx].close;
  let l2B = mx;
  for (let j = i + 2; j <= mx; j++) {
    const bar = candles[j];
    const sH = bar.low <= sL;
    const t1 = bar.high >= tp1;
    const t2 = bar.high >= tp2;
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
          l2P = tp2;
          break;
        }
        continue;
      }
    } else {
      const s2 = bar.low <= sL;
      const t22 = bar.high >= tp2;
      if (s2) {
        l2B = j;
        l2P = sL;
        break;
      }
      if (t22) {
        l2B = j;
        l2P = tp2;
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
        exit: tp1,
        direction: "long",
        holdingHours: tp1Bar - (i + 1),
        config: MAKER_COSTS,
      }).netPnlPct
    : leg2;
  return { exitBar: l2B, pnl: 0.5 * leg1 + 0.5 * leg2 };
}

// ────────────────────────── mechanic generators ───────────────────────
// Each generator returns a sorted list of candidate bar indices for entry.

function trendMaskFn(closes: number[], htfLen: number) {
  const mask: boolean[] = new Array(closes.length).fill(false);
  if (closes.length <= htfLen) return mask;
  for (let i = htfLen; i < closes.length; i++) {
    const sma = smaLast(closes.slice(i - htfLen, i), htfLen);
    mask[i] = closes[i] > sma;
  }
  return mask;
}

function entriesNDown(
  candles: Candle[],
  n: number,
  htfLen: number,
  avoidHour0 = true,
): number[] {
  const closes = candles.map((c) => c.close);
  const trend = trendMaskFn(closes, htfLen);
  const out: number[] = [];
  for (let i = Math.max(htfLen, n + 1); i < candles.length - 1; i++) {
    if (!trend[i]) continue;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (closes[i - k] >= closes[i - k - 1]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (avoidHour0 && new Date(candles[i].openTime).getUTCHours() === 0)
      continue;
    out.push(i);
  }
  return out;
}

function entriesNUp(
  candles: Candle[],
  n: number,
  htfLen: number,
  avoidHour0 = true,
): number[] {
  const closes = candles.map((c) => c.close);
  const trend = trendMaskFn(closes, htfLen);
  const out: number[] = [];
  for (let i = Math.max(htfLen, n + 1); i < candles.length - 1; i++) {
    if (!trend[i]) continue;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (closes[i - k] <= closes[i - k - 1]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (avoidHour0 && new Date(candles[i].openTime).getUTCHours() === 0)
      continue;
    out.push(i);
  }
  return out;
}

function entriesPullSma(
  candles: Candle[],
  htfLen: number,
  tolPct: number,
): number[] {
  // Low of bar i dips within tolPct of SMA but close is back above.
  const closes = candles.map((c) => c.close);
  const out: number[] = [];
  for (let i = htfLen; i < candles.length - 1; i++) {
    const sma = smaLast(closes.slice(i - htfLen, i), htfLen);
    if (sma <= 0) continue;
    const low = candles[i].low;
    const close = candles[i].close;
    const prevClose = closes[i - 1];
    if (close <= sma) continue; // trend gate (same: above sma)
    const dipped = low <= sma * (1 + tolPct) && low >= sma * (1 - tolPct);
    const bounced = close > low && close >= prevClose;
    if (!dipped || !bounced) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    out.push(i);
  }
  return out;
}

function entriesRsiOs(
  candles: Candle[],
  rsiLen: number,
  rsiTh: number,
  htfLen: number,
): number[] {
  const closes = candles.map((c) => c.close);
  const r = rsiSeries(closes, rsiLen);
  const trend = trendMaskFn(closes, htfLen);
  const out: number[] = [];
  for (let i = Math.max(htfLen, rsiLen + 1); i < candles.length - 1; i++) {
    if (!trend[i]) continue;
    if (!(r[i] <= rsiTh)) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    out.push(i);
  }
  return out;
}

function entriesBreakout(
  candles: Candle[],
  nHi: number,
  htfLen: number,
): number[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const trend = trendMaskFn(closes, htfLen);
  const out: number[] = [];
  for (let i = Math.max(htfLen, nHi + 1); i < candles.length - 1; i++) {
    if (!trend[i]) continue;
    const prevMax = maxLast(highs.slice(i - nHi, i), nHi);
    if (!(candles[i].close > prevMax)) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    out.push(i);
  }
  return out;
}

function entriesRedBar(
  candles: Candle[],
  thPct: number,
  htfLen: number,
): number[] {
  const closes = candles.map((c) => c.close);
  const trend = trendMaskFn(closes, htfLen);
  const out: number[] = [];
  for (let i = htfLen; i < candles.length - 1; i++) {
    if (!trend[i]) continue;
    const o = candles[i].open;
    const c = candles[i].close;
    if (o <= 0) continue;
    if (!((c - o) / o <= -thPct)) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    out.push(i);
  }
  return out;
}

// ────────────────────────── backtest runner ─────────────────────────────

function runMechanic(
  candles: Candle[],
  entries: number[],
  tp1: number,
  tp2: number,
  stop: number,
  hold: number,
): Trade[] {
  const trades: Trade[] = [];
  let cooldownUntil = -1;
  for (const i of entries) {
    if (i < cooldownUntil) continue;
    const r = executeLong(candles, i, tp1, tp2, stop, hold);
    if (!r) continue;
    trades.push({ pnl: r.pnl, openBar: i });
    cooldownUntil = r.exitBar + 1;
  }
  return trades;
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

function reportRun(
  label: string,
  trades: Trade[],
  days: number,
  bpw: number,
): { pass: boolean; sharpe: number; tpd: number; wr: number; ret: number } {
  if (trades.length === 0) {
    console.log(`  ${label.padEnd(44)} n=0 — SKIP`);
    return { pass: false, sharpe: 0, tpd: 0, wr: 0, ret: 0 };
  }
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const sh = sharpeOf(pnls);
  const tpd = trades.length / days;
  const wr = wins / trades.length;
  // 10 disjoint windows by openBar
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
    42,
  );
  const pass =
    trades.length >= 300 &&
    tpd >= 0.15 &&
    wr >= 0.52 &&
    ret > 0 &&
    sh >= 2 &&
    pctProf >= 0.5;
  console.log(
    `  ${label.padEnd(44)} n=${trades.length
      .toString()
      .padStart(4)} tpd=${tpd.toFixed(2)} WR=${(wr * 100)
      .toFixed(1)
      .padStart(5)}% ret=${(ret * 100)
      .toFixed(1)
      .padStart(7)}% Shp=${sh.toFixed(2).padStart(5)} %prof=${(pctProf * 100)
      .toFixed(0)
      .padStart(3)}% minW=${(minWin * 100).toFixed(1).padStart(5)}% bs+=${(
      bs.pctPositive * 100
    )
      .toFixed(0)
      .padStart(3)}% ${pass ? "★" : " "}`,
  );
  return { pass, sharpe: sh, tpd, wr, ret };
}

describe("iter 114 — BTC multi-mechanic deep scan", () => {
  it(
    "scan 6 orthogonal BTC long-only mechanics over ~2000 days",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 114: BTC multi-mechanic scan ===");
      console.log(
        `Loading ${TARGET_CANDLES} 1h BTC candles (≈${Math.round(
          TARGET_CANDLES / 24,
        )} days)...`,
      );
      const candles = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1h",
        targetCount: TARGET_CANDLES,
        maxPages: 100,
      });
      console.log(
        `  loaded ${candles.length} candles = ${(candles.length / 24).toFixed(0)} days`,
      );
      const days = candles.length / 24;
      const bpw = Math.floor(candles.length / 10);

      // Uniform execution params (proven in iter113 as decent baseline)
      const TP1 = 0.008;
      const TP2 = 0.04;
      const STOP = 0.01;
      const HOLD = 24;

      // ────── M1 nDown grid ──────
      console.log("\n-- M1 nDown (N consecutive red closes, HTF SMA gate) --");
      for (const n of [2, 3, 4]) {
        for (const htf of [24, 48, 96, 168]) {
          const e = entriesNDown(candles, n, htf);
          const t = runMechanic(candles, e, TP1, TP2, STOP, HOLD);
          reportRun(`nDown=${n} htf=${htf}`, t, days, bpw);
        }
      }

      // ────── M2 nUp grid ──────
      console.log("\n-- M2 nUp (N consecutive green closes, HTF SMA gate) --");
      for (const n of [2, 3, 4]) {
        for (const htf of [24, 48, 96, 168]) {
          const e = entriesNUp(candles, n, htf);
          const t = runMechanic(candles, e, TP1, TP2, STOP, HOLD);
          reportRun(`nUp=${n} htf=${htf}`, t, days, bpw);
        }
      }

      // ────── M3 pullSma grid ──────
      console.log("\n-- M3 pullSma (low touches SMA, close recovers) --");
      for (const htf of [48, 96, 168]) {
        for (const tol of [0.002, 0.005, 0.01]) {
          const e = entriesPullSma(candles, htf, tol);
          const t = runMechanic(candles, e, TP1, TP2, STOP, HOLD);
          reportRun(
            `pullSma htf=${htf} tol=${(tol * 100).toFixed(1)}%`,
            t,
            days,
            bpw,
          );
        }
      }

      // ────── M4 rsi os grid ──────
      console.log("\n-- M4 rsiOS (RSI ≤ th in uptrend) --");
      for (const rlen of [7, 14, 21]) {
        for (const th of [25, 30, 35, 40]) {
          for (const htf of [48, 168]) {
            const e = entriesRsiOs(candles, rlen, th, htf);
            const t = runMechanic(candles, e, TP1, TP2, STOP, HOLD);
            reportRun(`rsi len=${rlen} th=${th} htf=${htf}`, t, days, bpw);
          }
        }
      }

      // ────── M5 breakout grid ──────
      console.log("\n-- M5 breakout (close > max(Nhi) in uptrend) --");
      for (const nhi of [6, 12, 24, 48]) {
        for (const htf of [48, 168]) {
          const e = entriesBreakout(candles, nhi, htf);
          const t = runMechanic(candles, e, TP1, TP2, STOP, HOLD);
          reportRun(`brk nHi=${nhi} htf=${htf}`, t, days, bpw);
        }
      }

      // ────── M6 red-bar grid ──────
      console.log("\n-- M6 redBar (single big red candle in uptrend) --");
      for (const th of [0.005, 0.01, 0.015, 0.02]) {
        for (const htf of [48, 168]) {
          const e = entriesRedBar(candles, th, htf);
          const t = runMechanic(candles, e, TP1, TP2, STOP, HOLD);
          reportRun(
            `redBar ≤-${(th * 100).toFixed(1)}% htf=${htf}`,
            t,
            days,
            bpw,
          );
        }
      }

      console.log(
        "\nDone. Mark ★ configs are candidates for iter115 ensemble.",
      );
    },
  );
});
