/**
 * Iter 195 — Max 12h hold constraint.
 *
 * User: "ich muss under 24h halten besser unter 12h"
 *
 * iter194 had hold 16h (4 × 4h bars). Need to reduce to max 12h.
 *
 * Options:
 *   A) 4h bars, hold 2-3 (8-12h) — less time for TP, smaller TP needed
 *   B) 1h bars, hold 6-12 (6-12h) — more signals but 40bp cost eats edge
 *   C) 4h bars, hold 3 + smaller TP (4-6%)
 *
 * Apply compound sizing from iter194 to best variant.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

interface Trade {
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
  holdBars: number;
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
      const holdBars = xb - (i + 1);
      if (day >= 0)
        out.push({
          rawPnl: pnl,
          day,
          entryTime: eb.openTime,
          exitTime: c[xb].closeTime,
          holdBars,
        });
      cd = xb + 1;
    }
  }
  return out;
}

interface SizingFn {
  (equity: number): number;
}
const compound: SizingFn = (eq) => {
  if (eq >= 1.08) return 0.15;
  if (eq >= 1.03) return 0.45;
  return 0.3;
};
const flat40: SizingFn = () => 0.4;

function simFtmo(trades: Trade[], leverage: number, sizing: SizingFn) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  let passDay = -1;
  for (const t of trades.sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  )) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    const risk = sizing(eq);
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

describe("iter 195 — max 12h hold", () => {
  it("find best 12h-constraint config", { timeout: 1_200_000 }, async () => {
    console.log("\n=== ITER 195: MAX 12H HOLD ===");
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    const c4h: Record<string, Candle[]> = {};
    const c1h: Record<string, Candle[]> = {};
    for (const s of symbols) {
      c4h[s] = await loadBinanceHistory({
        symbol: s as "BTCUSDT",
        timeframe: "4h",
        targetCount: 20_000,
        maxPages: 100,
      });
      c1h[s] = await loadBinanceHistory({
        symbol: s as "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 200,
      });
    }
    const a4h = Math.min(...symbols.map((s) => c4h[s].length));
    const a1h = Math.min(...symbols.map((s) => c1h[s].length));
    for (const s of symbols) {
      c4h[s] = c4h[s].slice(c4h[s].length - a4h);
      c1h[s] = c1h[s].slice(c1h[s].length - a1h);
    }
    const cost: Record<string, number> = {
      BTCUSDT: 40,
      ETHUSDT: 30,
      SOLUSDT: 40,
    };

    const w4h: { start: number; end: number }[] = [];
    for (let s = 0; s + 30 * 6 < a4h; s += 30 * 6)
      w4h.push({ start: s, end: s + 30 * 6 });
    const w1h: { start: number; end: number }[] = [];
    for (let s = 0; s + 30 * 24 < a1h; s += 30 * 24)
      w1h.push({ start: s, end: s + 30 * 24 });

    function batch(
      cc: Record<string, Candle[]>,
      tp: number,
      stop: number,
      hold: number,
      trig: number,
      sizing: SizingFn,
      wins: { start: number; end: number }[],
    ) {
      let passed = 0;
      const daysArr: number[] = [];
      for (const w of wins) {
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(
            ...run(cc[s], tp, stop, hold, w.start, w.end, cost[s], trig),
          );
        }
        const r = simFtmo(all, 2, sizing);
        if (r.passed) {
          passed++;
          daysArr.push(r.daysToPass);
        }
      }
      daysArr.sort((a, b) => a - b);
      const med =
        daysArr.length > 0 ? daysArr[Math.floor(daysArr.length / 2)] : 0;
      const avg =
        daysArr.length > 0
          ? daysArr.reduce((a, b) => a + b, 0) / daysArr.length
          : 0;
      return { passRate: passed / wins.length, avgDays: avg, medDays: med };
    }

    // ─── A: 4h bars hold 2 (=8h) and 3 (=12h) ───
    console.log("── A: 4h bars with 12h or 8h hold ──");
    console.log(
      "tp%   stop%  hold(bars/h)  trig  sizing     pass%   avgDays  medDays",
    );
    for (const tp of [0.04, 0.05, 0.06, 0.08]) {
      for (const stop of [0.005, 0.0075]) {
        for (const hold of [2, 3]) {
          for (const trig of [2, 3]) {
            for (const [sn, sf] of [
              ["compound", compound],
              ["flat40", flat40],
            ] as const) {
              const r = batch(c4h, tp, stop, hold, trig, sf, w4h);
              if (r.passRate >= 0.35) {
                console.log(
                  `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${hold}(${hold * 4}h)    ${trig}     ${sn.padEnd(9)}  ${(r.passRate * 100).toFixed(2).padStart(5)}%  ${r.avgDays.toFixed(1).padStart(5)}    ${r.medDays}`,
                );
              }
            }
          }
        }
      }
    }

    // ─── B: 1h bars hold 6-12 ───
    console.log("\n── B: 1h bars with 6-12h hold ──");
    console.log(
      "tp%   stop%  hold(h)  trig  sizing     pass%   avgDays  medDays",
    );
    for (const tp of [0.02, 0.03, 0.04, 0.05]) {
      for (const stop of [0.003, 0.005]) {
        for (const hold of [6, 8, 12]) {
          for (const trig of [2, 3]) {
            for (const [sn, sf] of [
              ["compound", compound],
              ["flat40", flat40],
            ] as const) {
              const r = batch(c1h, tp, stop, hold, trig, sf, w1h);
              if (r.passRate >= 0.3) {
                console.log(
                  `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${hold.toString().padStart(2)}h     ${trig}     ${sn.padEnd(9)}  ${(r.passRate * 100).toFixed(2).padStart(5)}%  ${r.avgDays.toFixed(1).padStart(5)}    ${r.medDays}`,
                );
              }
            }
          }
        }
      }
    }

    expect(true).toBe(true);
  });
});
