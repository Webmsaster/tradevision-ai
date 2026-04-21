/**
 * Iter 185 — 4-asset 1d portfolio + seasonality + multi-variant triggers.
 *
 * iter183 baseline: BTC+ETH 1d combined → 55% OOS.
 *
 * Two truly-untested angles on 1d timeframe:
 *   A) 4-asset 1d: BTC+ETH+SOL+AVAX (we only tested 15m for 4-asset, never 1d)
 *   B) Day-of-week filter: skip Mon/weekend, prefer Tue-Thu setups
 *   C) Volatility regime filter (ATR percentile band)
 *   D) 3-bar trigger on 1d with wider TPs
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

interface Trade {
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
  symbol: string;
}

function atrRel(c: Candle[], len: number): number[] {
  const out = new Array(c.length).fill(NaN);
  if (c.length < len + 1) return out;
  let sum = 0;
  for (let i = 1; i <= len; i++) {
    sum += Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
  }
  out[len] = sum / len / c[len].close;
  for (let i = len + 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    const atr = (out[i - 1] * c[i - 1].close * (len - 1) + tr) / len;
    out[i] = atr / c[i].close;
  }
  return out;
}

interface RunOpts {
  symbol: string;
  tp: number;
  stop: number;
  hold: number;
  triggerBars: number;
  costBp: number;
  allowDays?: Set<number>; // day-of-week allow-list (0=Sun..6=Sat)
  atrRel?: number[];
  atrMin?: number;
  atrMax?: number;
}

function run(c: Candle[], wS: number, wE: number, opts: RunOpts): Trade[] {
  const out: Trade[] = [];
  if (!c[wS]) return out;
  const ts0 = c[wS].openTime;
  const costFrac = opts.costBp / 10000;

  for (const dir of ["long", "short"] as const) {
    let cd = -1;
    for (let i = Math.max(opts.triggerBars + 1, wS); i < wE - 1; i++) {
      if (i < cd) continue;
      let ok = true;
      for (let k = 0; k < opts.triggerBars; k++) {
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

      // Day-of-week filter (based on next bar = entry bar)
      if (opts.allowDays) {
        const dow = new Date(c[i + 1].openTime).getUTCDay();
        if (!opts.allowDays.has(dow)) continue;
      }
      // ATR filter
      if (opts.atrRel && !isNaN(opts.atrRel[i])) {
        const a = opts.atrRel[i];
        if (opts.atrMin !== undefined && a < opts.atrMin) continue;
        if (opts.atrMax !== undefined && a > opts.atrMax) continue;
      }

      const eb = c[i + 1];
      if (!eb) break;
      const entry = eb.open;
      const entryEff =
        dir === "long"
          ? entry * (1 + costFrac / 2)
          : entry * (1 - costFrac / 2);
      const tpPx =
        dir === "long" ? entry * (1 + opts.tp) : entry * (1 - opts.tp);
      const stPx =
        dir === "long" ? entry * (1 - opts.stop) : entry * (1 + opts.stop);
      const mx = Math.min(i + 1 + opts.hold, wE - 1);
      let xb = mx;
      let xp = c[mx].close;
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
        dir === "long" ? xp * (1 - costFrac / 2) : xp * (1 + costFrac / 2);
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
          symbol: opts.symbol,
        });
      cd = xb + 1;
    }
  }
  return out;
}

function simFtmo(trades: Trade[], leverage: number, risk: number) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  for (const t of trades.sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  )) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    const pnlF = Math.max(t.rawPnl * leverage * risk, -risk);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq <= 0.9) return { passed: false };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) return { passed: false };
    if (eq >= 1.1 && td.size >= 4) return { passed: true };
  }
  return { passed: eq >= 1.1 && td.size >= 4 };
}

describe("iter 185 — 4-asset 1d + seasonality", () => {
  it("push to 60%+ OOS", { timeout: 1_200_000 }, async () => {
    console.log("\n=== ITER 185: 4-ASSET 1d + SEASONALITY ===");
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT"];
    const candles: Record<string, Candle[]> = {};
    for (const s of symbols) {
      candles[s] = await loadBinanceHistory({
        symbol: s as "BTCUSDT",
        timeframe: "1d",
        targetCount: 3000,
        maxPages: 50,
      });
      console.log(`  ${s}: ${candles[s].length} days`);
    }
    // align
    const minTs = Math.max(...symbols.map((s) => candles[s][0].openTime));
    for (const s of symbols) {
      const idx = candles[s].findIndex((c) => c.openTime >= minTs);
      candles[s] = candles[s].slice(idx);
    }
    const aligned = Math.min(...symbols.map((s) => candles[s].length));
    console.log(`Aligned ${aligned} days\n`);

    const atr: Record<string, number[]> = {};
    for (const s of symbols) atr[s] = atrRel(candles[s], 14);

    const winBars = 30;
    const wNO: { start: number; end: number }[] = [];
    for (let s = 0; s + winBars < aligned; s += winBars)
      wNO.push({ start: s, end: s + winBars });
    const cut = Math.floor(wNO.length * 0.6);
    const wIS = wNO.slice(0, cut);
    const wOOS = wNO.slice(cut);
    console.log(
      `${wNO.length} NOV windows: IS ${wIS.length}, OOS ${wOOS.length}\n`,
    );

    const cost: Record<string, number> = {
      BTCUSDT: 40,
      ETHUSDT: 30,
      SOLUSDT: 40,
      AVAXUSDT: 45,
    };
    const tp: Record<string, number> = {
      BTCUSDT: 0.08,
      ETHUSDT: 0.12,
      SOLUSDT: 0.12,
      AVAXUSDT: 0.15,
    };

    function runBatch(
      useAssets: string[],
      rf: number,
      hold: number,
      triggerBars = 2,
      filter?: {
        allowDays?: Set<number>;
        atrMin?: number;
        atrMax?: number;
      },
    ) {
      let pN = 0,
        pI = 0,
        pO = 0;
      const runW = (w: { start: number; end: number }) => {
        const all: Trade[] = [];
        for (const sym of useAssets) {
          all.push(
            ...run(candles[sym], w.start, w.end, {
              symbol: sym,
              tp: tp[sym],
              stop: 0.02,
              hold,
              triggerBars,
              costBp: cost[sym],
              allowDays: filter?.allowDays,
              atrRel: atr[sym],
              atrMin: filter?.atrMin,
              atrMax: filter?.atrMax,
            }),
          );
        }
        return all;
      };
      for (const w of wNO) if (simFtmo(runW(w), 2, rf).passed) pN++;
      for (const w of wIS) if (simFtmo(runW(w), 2, rf).passed) pI++;
      for (const w of wOOS) if (simFtmo(runW(w), 2, rf).passed) pO++;
      return {
        nov: pN / wNO.length,
        is: pI / wIS.length,
        oos: pO / wOOS.length,
      };
    }

    // ─── A: 4-asset 1d baseline ───
    console.log("── A: 4-asset 1d (BTC+ETH+SOL+AVAX) ──");
    console.log("risk%  hold  NOV%   IS%    OOS%  EV-OOS($)");
    for (const rf of [0.2, 0.25, 0.33, 0.4, 0.5]) {
      for (const hold of [10, 15, 20, 25]) {
        const r = runBatch(symbols, rf, hold);
        if (r.nov >= 0.4) {
          console.log(
            `${(rf * 100).toFixed(0).padStart(3)}%   ${hold.toString().padStart(2)}   ${(r.nov * 100).toFixed(2).padStart(5)}%  ${(r.is * 100).toFixed(2).padStart(5)}%  ${(r.oos * 100).toFixed(2).padStart(5)}%  +$${(r.oos * 0.5 * 8000 - 99).toFixed(0)}`,
          );
        }
      }
    }

    // ─── B: 3-asset top performers (exclude AVAX which has wider spread) ───
    console.log("\n── B: BTC+ETH+SOL 1d ──");
    for (const rf of [0.25, 0.33, 0.4, 0.5]) {
      for (const hold of [15, 20, 25]) {
        const r = runBatch(["BTCUSDT", "ETHUSDT", "SOLUSDT"], rf, hold);
        console.log(
          `  risk ${(rf * 100).toFixed(0)}%  hold ${hold}d  NOV ${(r.nov * 100).toFixed(2)}%  OOS ${(r.oos * 100).toFixed(2)}%  EV +$${(r.oos * 0.5 * 8000 - 99).toFixed(0)}`,
        );
      }
    }

    // ─── C: Day-of-week filter on BTC+ETH ───
    console.log("\n── C: Day-of-week filter (BTC+ETH baseline) ──");
    const allSet = new Set([0, 1, 2, 3, 4, 5, 6]);
    const weekdays = new Set([1, 2, 3, 4, 5]);
    const tueWed = new Set([2, 3]);
    const skipMon = new Set([0, 2, 3, 4, 5, 6]);
    const skipFriSun = new Set([1, 2, 3, 4]);
    for (const [name, days] of [
      ["all (baseline)", allSet],
      ["weekdays", weekdays],
      ["Tue-Wed", tueWed],
      ["skip Mon", skipMon],
      ["Tue-Thu (skip Fri/Sun)", skipFriSun],
    ] as const) {
      const r = runBatch(["BTCUSDT", "ETHUSDT"], 0.5, 20, 2, {
        allowDays: days,
      });
      console.log(
        `  ${name.padEnd(22)} NOV ${(r.nov * 100).toFixed(2)}%  OOS ${(r.oos * 100).toFixed(2)}%`,
      );
    }

    // ─── D: Volatility regime filter ───
    console.log("\n── D: ATR regime filter (BTC+ETH) ──");
    for (const [minA, maxA] of [
      [0, 1],
      [0.02, 0.1],
      [0.03, 0.1],
      [0.015, 0.05],
      [0.02, 0.06],
      [0, 0.05],
    ] as const) {
      const r = runBatch(["BTCUSDT", "ETHUSDT"], 0.5, 20, 2, {
        atrMin: minA,
        atrMax: maxA,
      });
      console.log(
        `  ATR [${(minA * 100).toFixed(1)}%-${(maxA * 100).toFixed(1)}%]  NOV ${(r.nov * 100).toFixed(2)}%  OOS ${(r.oos * 100).toFixed(2)}%`,
      );
    }

    // ─── E: 3-bar trigger on 1d ───
    console.log("\n── E: 3-bar trigger on 1d ──");
    for (const rf of [0.5, 0.7, 1.0]) {
      for (const hold of [20, 30]) {
        const r = runBatch(["BTCUSDT", "ETHUSDT"], rf, hold, 3);
        console.log(
          `  3-bar risk ${(rf * 100).toFixed(0)}% hold ${hold}d: NOV ${(r.nov * 100).toFixed(2)}% OOS ${(r.oos * 100).toFixed(2)}%`,
        );
      }
    }

    expect(true).toBe(true);
  });
});
