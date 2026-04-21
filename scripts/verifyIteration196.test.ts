/**
 * Iter 196 — push pass rate to 60% via trend + confluence filter.
 *
 * Web research confirmed:
 *   - Higher-timeframe trend filter (D1/H4) lifts win rate 60-90%
 *   - RSI + EMA + trend confluence is key
 *   - Mean reversion at extremes (RSI ≤25 / ≥75) is the edge
 *
 * Apply to iter195 12h-hold config:
 *   A) Daily SMA direction filter (only long if daily up, short if daily down)
 *   B) RSI confluence: 2-down + RSI < 30 = long, 2-up + RSI > 70 = short
 *   C) Combined: trend + RSI
 *   D) EMA-20 position filter (counter-trend mean-reversion)
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

interface Trade {
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
}

function rsiSeries(closes: number[], len: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= len) return out;
  let g = 0,
    l = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l += -d;
  }
  g /= len;
  l /= len;
  out[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gi = d > 0 ? d : 0;
    const li = d < 0 ? -d : 0;
    g = (g * (len - 1) + gi) / len;
    l = (l * (len - 1) + li) / len;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function smaSeries(closes: number[], len: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= len) sum -= closes[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

interface FilterOpts {
  rsi?: number[];
  rsiLong?: number; // max RSI for long entry
  rsiShort?: number; // min RSI for short entry
  dailySma?: number[]; // daily SMA trend direction
  onlyWithTrend?: boolean; // long if close > daily SMA
}

function run(
  c: Candle[],
  tp: number,
  stop: number,
  hold: number,
  wS: number,
  wE: number,
  costBp: number,
  triggerBars: number,
  opts: FilterOpts = {},
): Trade[] {
  const out: Trade[] = [];
  if (!c[wS]) return out;
  const ts0 = c[wS].openTime;
  const cost = costBp / 10000;
  for (const dir of ["long", "short"] as const) {
    let cd = -1;
    for (let i = Math.max(triggerBars + 1, wS); i < wE - 1; i++) {
      if (i < cd) continue;
      let ok = true;
      for (let k = 0; k < triggerBars; k++) {
        const cmp =
          dir === "long"
            ? c[i - k].close >= c[i - k - 1].close
            : c[i - k].close <= c[i - k - 1].close;
        if (cmp) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      // RSI confluence filter
      if (opts.rsi && !isNaN(opts.rsi[i])) {
        if (
          dir === "long" &&
          opts.rsiLong !== undefined &&
          opts.rsi[i] > opts.rsiLong
        )
          continue;
        if (
          dir === "short" &&
          opts.rsiShort !== undefined &&
          opts.rsi[i] < opts.rsiShort
        )
          continue;
      }

      // Daily trend filter (only mean-revert WITH daily trend direction)
      if (opts.dailySma && opts.onlyWithTrend) {
        const dsma = opts.dailySma[i];
        if (isNaN(dsma)) continue;
        if (dir === "long" && c[i].close < dsma) continue; // skip long if below daily SMA
        if (dir === "short" && c[i].close > dsma) continue;
      }

      const eb = c[i + 1];
      if (!eb) break;
      const entry = eb.open;
      const entryEff =
        dir === "long" ? entry * (1 + cost / 2) : entry * (1 - cost / 2);
      const tpPx = dir === "long" ? entry * (1 + tp) : entry * (1 - tp);
      const stPx = dir === "long" ? entry * (1 - stop) : entry * (1 + stop);
      const mx = Math.min(i + 1 + hold, wE - 1);
      let xb = mx,
        xp = c[mx].close;
      for (let j = i + 2; j <= mx; j++) {
        const bar = c[j];
        if (dir === "long") {
          if (bar.low <= stPx) {
            xb = j;
            xp = stPx;
            break;
          }
          if (bar.high >= tpPx) {
            xb = j;
            xp = tpPx;
            break;
          }
        } else {
          if (bar.high >= stPx) {
            xb = j;
            xp = stPx;
            break;
          }
          if (bar.low <= tpPx) {
            xb = j;
            xp = tpPx;
            break;
          }
        }
      }
      const exitEff =
        dir === "long" ? xp * (1 - cost / 2) : xp * (1 + cost / 2);
      const pnl =
        dir === "long"
          ? (exitEff - entryEff) / entryEff
          : (entryEff - exitEff) / entryEff;
      const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
      if (day >= 0)
        out.push({
          rawPnl: pnl,
          day,
          entryTime: eb.openTime,
          exitTime: c[xb].closeTime,
        });
      cd = xb + 1;
    }
  }
  return out;
}

const compound = (eq: number): number => {
  if (eq >= 1.08) return 0.15;
  if (eq >= 1.03) return 0.45;
  return 0.3;
};

function simFtmo(trades: Trade[], leverage: number) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  let passDay = -1;
  for (const t of trades.sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  )) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    const risk = compound(eq);
    if (risk <= 0) continue;
    const pnlF = Math.max(t.rawPnl * leverage * risk, -risk);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq <= 0.9) return { passed: false, daysToPass: -1 };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) return { passed: false, daysToPass: -1 };
    if (eq >= 1.1 && td.size >= 4) {
      passDay = t.day + 1;
      break;
    }
  }
  return {
    passed: passDay > 0 || (eq >= 1.1 && td.size >= 4),
    daysToPass: passDay > 0 ? passDay : eq >= 1.1 && td.size >= 4 ? 30 : -1,
  };
}

describe("iter 196 — trend + RSI filter for 60% pass", () => {
  it("test filters", { timeout: 1_200_000 }, async () => {
    console.log("\n=== ITER 196: TREND + RSI FILTER ===");
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    const c4h: Record<string, Candle[]> = {};
    const rsi14: Record<string, number[]> = {};
    const rsi7: Record<string, number[]> = {};
    const dailySma: Record<string, number[]> = {}; // daily SMA mapped to 4h bars

    for (const s of symbols) {
      c4h[s] = await loadBinanceHistory({
        symbol: s as "BTCUSDT",
        timeframe: "4h",
        targetCount: 20_000,
        maxPages: 100,
      });
      const closes = c4h[s].map((x) => x.close);
      rsi14[s] = rsiSeries(closes, 14);
      rsi7[s] = rsiSeries(closes, 7);
      // Daily SMA20 on 4h bars = SMA of last 20 × 6 = 120 4h-bars (20 days)
      dailySma[s] = smaSeries(closes, 120);
    }
    const aligned = Math.min(...symbols.map((s) => c4h[s].length));
    for (const s of symbols) {
      c4h[s] = c4h[s].slice(c4h[s].length - aligned);
      rsi14[s] = rsi14[s].slice(rsi14[s].length - aligned);
      rsi7[s] = rsi7[s].slice(rsi7[s].length - aligned);
      dailySma[s] = dailySma[s].slice(dailySma[s].length - aligned);
    }
    const cost: Record<string, number> = {
      BTCUSDT: 40,
      ETHUSDT: 30,
      SOLUSDT: 40,
    };

    const winBars = 30 * 6;
    const wNO: { start: number; end: number }[] = [];
    for (let s = 0; s + winBars < aligned; s += winBars)
      wNO.push({ start: s, end: s + winBars });
    console.log(`${wNO.length} non-overlap windows\n`);

    function batch(filterFactory: (sym: string) => FilterOpts, label: string) {
      let passed = 0;
      const days: number[] = [];
      for (const w of wNO) {
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(
            ...run(
              c4h[s],
              0.08,
              0.005,
              3,
              w.start,
              w.end,
              cost[s],
              2,
              filterFactory(s),
            ),
          );
        }
        const r = simFtmo(all, 2);
        if (r.passed) {
          passed++;
          days.push(r.daysToPass);
        }
      }
      days.sort((a, b) => a - b);
      const med = days.length > 0 ? days[Math.floor(days.length / 2)] : 0;
      const avg =
        days.length > 0 ? days.reduce((a, b) => a + b, 0) / days.length : 0;
      console.log(
        `${label.padEnd(40)} pass ${((passed / wNO.length) * 100).toFixed(2).padStart(5)}%  avgDays ${avg.toFixed(1)}  med ${med}  EV +$${((passed / wNO.length) * 0.5 * 8000 - 99).toFixed(0)}`,
      );
      return passed / wNO.length;
    }

    console.log(
      "filter                                pass%   avgDays  medDays  EV($)",
    );
    batch(() => ({}), "iter195 baseline (no filter)");

    // A) RSI confluence
    batch(
      (s) => ({ rsi: rsi14[s], rsiLong: 30, rsiShort: 70 }),
      "RSI14 <30 long / >70 short",
    );
    batch(
      (s) => ({ rsi: rsi14[s], rsiLong: 35, rsiShort: 65 }),
      "RSI14 <35 long / >65 short",
    );
    batch(
      (s) => ({ rsi: rsi14[s], rsiLong: 40, rsiShort: 60 }),
      "RSI14 <40 long / >60 short",
    );
    batch(
      (s) => ({ rsi: rsi7[s], rsiLong: 30, rsiShort: 70 }),
      "RSI7 <30 long / >70 short",
    );
    batch(
      (s) => ({ rsi: rsi7[s], rsiLong: 35, rsiShort: 65 }),
      "RSI7 <35 long / >65 short",
    );

    // B) Daily SMA trend filter (only mean-revert WITH trend)
    batch(
      (s) => ({ dailySma: dailySma[s], onlyWithTrend: true }),
      "Daily SMA20 trend only",
    );

    // C) Combined: trend + RSI
    batch(
      (s) => ({
        rsi: rsi14[s],
        rsiLong: 35,
        rsiShort: 65,
        dailySma: dailySma[s],
        onlyWithTrend: true,
      }),
      "RSI14 + Daily trend combined",
    );
    batch(
      (s) => ({
        rsi: rsi14[s],
        rsiLong: 40,
        rsiShort: 60,
        dailySma: dailySma[s],
        onlyWithTrend: true,
      }),
      "RSI14 ±60 + Daily trend",
    );
    batch(
      (s) => ({
        rsi: rsi7[s],
        rsiLong: 35,
        rsiShort: 65,
        dailySma: dailySma[s],
        onlyWithTrend: true,
      }),
      "RSI7 ±65 + Daily trend",
    );

    // D) RSI only (simpler)
    batch(
      (s) => ({ rsi: rsi14[s], rsiLong: 45, rsiShort: 55 }),
      "RSI14 loose ±55",
    );
    batch(
      (s) => ({ rsi: rsi14[s], rsiLong: 50, rsiShort: 50 }),
      "RSI14 ±50 (basically all)",
    );

    expect(true).toBe(true);
  });
});
