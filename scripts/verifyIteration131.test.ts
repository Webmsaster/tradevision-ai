/**
 * Iter 131 — multi-timeframe confluence on BTC iter123 baseline.
 *
 * Add HTF confirmation filters on top of the iter123 entry signal:
 *   MTF1: 4h close > SMA(4h, 42)   (same 7-day trend on 4h)
 *   MTF2: 1d close > SMA(1d, 7)    (weekly trend)
 *   MTF3: 4h close > EMA(4h, 20)   (medium-term momentum)
 *   MTF4: 1d close > 1d 7-bar high (new weekly high = strong trend)
 *   MTF5: BOTH MTF1 AND MTF2
 *
 * The 1h entry loop stays iter123; we resample 1h bar timestamps to find
 * the relevant 4h / 1d bar that closed before the entry bar.
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
function emaSeries(values: number[], len: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < len) return out;
  const k = 2 / (len + 1);
  let e = values.slice(0, len).reduce((a, b) => a + b, 0) / len;
  out[len - 1] = e;
  for (let i = len; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
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
  tp2: 0.04,
  stop: 0.01,
  hold: 24,
};

interface Ctx {
  closes: number[];
  highs: number[];
  r7: number[];
  trendMask: boolean[];
  macroMask: boolean[];
  mtf4hTrend: boolean[]; // precomputed for each 1h bar
  mtf1dTrend: boolean[];
  mtf4hEma: boolean[];
  mtf1dHigh: boolean[];
}

// Map each 1h bar i to the most-recent fully-closed HTF bar.
function mapHtfToHourly(
  hourly: Candle[],
  htf: Candle[],
  htfMs: number,
): number[] {
  const out: number[] = new Array(hourly.length).fill(-1);
  let j = 0;
  for (let i = 0; i < hourly.length; i++) {
    const hourlyTs = hourly[i].openTime;
    while (j + 1 < htf.length && htf[j + 1].openTime + htfMs <= hourlyTs) j++;
    if (htf[j] && htf[j].openTime + htfMs <= hourlyTs) {
      out[i] = j;
    }
  }
  return out;
}

function mkCtx(hourly: Candle[], h4: Candle[], d1: Candle[]): Ctx {
  const closes = hourly.map((c) => c.close);
  const highs = hourly.map((c) => c.high);
  const r7 = rsiSeries(closes, 7);
  const trendMask: boolean[] = new Array(hourly.length).fill(false);
  for (let i = P.htfLen; i < hourly.length; i++) {
    const s = smaLast(closes.slice(i - P.htfLen, i), P.htfLen);
    trendMask[i] = hourly[i].close > s;
  }
  const macroMask: boolean[] = new Array(hourly.length).fill(false);
  for (let i = P.macroBars; i < hourly.length; i++) {
    const past = closes[i - P.macroBars];
    if (past > 0) macroMask[i] = (closes[i] - past) / past > 0;
  }

  // 4h trend: close > SMA(42)
  const h4Closes = h4.map((c) => c.close);
  const h4TrendArr: boolean[] = new Array(h4.length).fill(false);
  for (let i = 42; i < h4.length; i++) {
    const s = smaLast(h4Closes.slice(i - 42, i), 42);
    h4TrendArr[i] = h4[i].close > s;
  }
  const h4Ema20 = emaSeries(h4Closes, 20);
  const h4EmaArr: boolean[] = new Array(h4.length).fill(false);
  for (let i = 20; i < h4.length; i++) {
    h4EmaArr[i] = h4[i].close > h4Ema20[i];
  }

  // 1d trend: close > SMA(7)
  const d1Closes = d1.map((c) => c.close);
  const d1TrendArr: boolean[] = new Array(d1.length).fill(false);
  for (let i = 7; i < d1.length; i++) {
    const s = smaLast(d1Closes.slice(i - 7, i), 7);
    d1TrendArr[i] = d1[i].close > s;
  }
  // 1d new 7-bar high
  const d1Highs = d1.map((c) => c.high);
  const d1HighArr: boolean[] = new Array(d1.length).fill(false);
  for (let i = 7; i < d1.length; i++) {
    d1HighArr[i] = d1[i].close > maxLast(d1Highs.slice(i - 7, i), 7);
  }

  // Map hourly → 4h / 1d bar
  const map4h = mapHtfToHourly(hourly, h4, 4 * 3600_000);
  const map1d = mapHtfToHourly(hourly, d1, 24 * 3600_000);

  const mtf4hTrend: boolean[] = new Array(hourly.length).fill(false);
  const mtf1dTrend: boolean[] = new Array(hourly.length).fill(false);
  const mtf4hEma: boolean[] = new Array(hourly.length).fill(false);
  const mtf1dHigh: boolean[] = new Array(hourly.length).fill(false);
  for (let i = 0; i < hourly.length; i++) {
    const j4 = map4h[i];
    const j1 = map1d[i];
    mtf4hTrend[i] = j4 >= 0 && (h4TrendArr[j4] ?? false);
    mtf1dTrend[i] = j1 >= 0 && (d1TrendArr[j1] ?? false);
    mtf4hEma[i] = j4 >= 0 && (h4EmaArr[j4] ?? false);
    mtf1dHigh[i] = j1 >= 0 && (d1HighArr[j1] ?? false);
  }

  return {
    closes,
    highs,
    r7,
    trendMask,
    macroMask,
    mtf4hTrend,
    mtf1dTrend,
    mtf4hEma,
    mtf1dHigh,
  };
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

type MtfFilter =
  | "none"
  | "mtf_4h"
  | "mtf_1d"
  | "mtf_4h_ema"
  | "mtf_1d_highbreak"
  | "mtf_4h_and_1d";

function mtfOk(ctx: Ctx, i: number, f: MtfFilter): boolean {
  switch (f) {
    case "none":
      return true;
    case "mtf_4h":
      return ctx.mtf4hTrend[i];
    case "mtf_1d":
      return ctx.mtf1dTrend[i];
    case "mtf_4h_ema":
      return ctx.mtf4hEma[i];
    case "mtf_1d_highbreak":
      return ctx.mtf1dHigh[i];
    case "mtf_4h_and_1d":
      return ctx.mtf4hTrend[i] && ctx.mtf1dTrend[i];
  }
}

function executeLong(
  candles: Candle[],
  i: number,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp1L = entry * (1 + P.tp1);
  const tp2L = entry * (1 + P.tp2);
  let sL = entry * (1 - P.stop);
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

function runWithMtf(candles: Candle[], ctx: Ctx, f: MtfFilter): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  for (let i = P.macroBars + 2; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= P.capK) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    if (!mtfOk(ctx, i, f)) continue;
    for (const m of mechs) {
      if (open.length >= P.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m)) continue;
      const r = executeLong(candles, i);
      if (!r) continue;
      trades.push({ pnl: r.pnl / P.capK, openBar: i });
      open.push({ exitBar: r.exitBar, mech: m });
    }
  }
  return trades;
}

describe("iter 131 — MTF confluence", () => {
  it(
    "add 4h/1d trend gate on top of iter123 BTC",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 131: MTF confluence ===");
      const c = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1h",
        targetCount: TARGET_CANDLES,
        maxPages: 100,
      });
      const c4 = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "4h",
        targetCount: 15_000,
        maxPages: 100,
      });
      const cd = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1d",
        targetCount: 3_000,
        maxPages: 100,
      });
      console.log(`loaded 1h=${c.length}, 4h=${c4.length}, 1d=${cd.length}`);
      const days = c.length / 24;
      const bpw = Math.floor(c.length / 10);
      const ctx = mkCtx(c, c4, cd);

      const filters: MtfFilter[] = [
        "none",
        "mtf_4h",
        "mtf_1d",
        "mtf_4h_ema",
        "mtf_1d_highbreak",
        "mtf_4h_and_1d",
      ];

      console.log(
        "\nfilter                   n      tpd   WR     meanPct   cumRet    Shp    bs+   bs5%    %prof  minW",
      );
      for (const f of filters) {
        const t = runWithMtf(c, ctx, f);
        if (t.length < 30) {
          console.log(`${f.padEnd(24)} SKIP`);
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
          `${f.padEnd(24)} ${t.length.toString().padStart(5)} ${tpd.toFixed(2)} ${(wr * 100).toFixed(1).padStart(5)}% ${(mean * 100).toFixed(3).padStart(6)}% ${(ret * 100).toFixed(1).padStart(6)}% ${sh.toFixed(2).padStart(5)} ${(bs.pctPositive * 100).toFixed(0).padStart(3)}% ${(bs.p5 * 100).toFixed(1).padStart(6)}% ${(pctProf * 100).toFixed(0).padStart(3)}% ${(minWin * 100).toFixed(1).padStart(6)}%`,
        );
      }
    },
  );
});
