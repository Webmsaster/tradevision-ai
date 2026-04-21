/**
 * Iter 194 — COMPOUND sizing to boost both speed AND pass rate.
 *
 * User: "ich will maximum speed mit höher pass rate"
 *
 * iter193 found r30% gives 52% pass rate (higher than r40% 49%).
 *
 * Compound idea: start low, after first winner ramp up for speed.
 *   - Risk 25% initial
 *   - After +4% equity: risk 40% (ride the wave)
 *   - After +8% equity: risk 20% (protect gains, but keep trading)
 *
 * Test multiple compound schemes vs fixed to see if both pass rate
 * AND time-to-pass improve.
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

interface SizingFn {
  (equity: number): number;
}

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

describe("iter 194 — compound sizing", () => {
  it("find best pass+speed combo", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 194: COMPOUND SIZING ===");
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    const c4h: Record<string, Candle[]> = {};
    for (const s of symbols) {
      c4h[s] = await loadBinanceHistory({
        symbol: s as "BTCUSDT",
        timeframe: "4h",
        targetCount: 20_000,
        maxPages: 100,
      });
    }
    const aligned = Math.min(...symbols.map((s) => c4h[s].length));
    for (const s of symbols) c4h[s] = c4h[s].slice(c4h[s].length - aligned);

    const cost: Record<string, number> = {
      BTCUSDT: 40,
      ETHUSDT: 30,
      SOLUSDT: 40,
    };
    const winBars = 30 * 6;
    const wNO: { start: number; end: number }[] = [];
    for (let s = 0; s + winBars < aligned; s += winBars)
      wNO.push({ start: s, end: s + winBars });

    function batch(
      sizing: SizingFn,
      tp = 0.08,
      stop = 0.005,
      hold = 4,
      trig = 2,
    ) {
      let passed = 0;
      let sumDays = 0;
      const daysArr: number[] = [];
      for (const w of wNO) {
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(
            ...run(c4h[s], tp, stop, hold, w.start, w.end, cost[s], trig),
          );
        }
        const r = simFtmo(all, 2, sizing);
        if (r.passed) {
          passed++;
          sumDays += r.daysToPass;
          daysArr.push(r.daysToPass);
        }
      }
      daysArr.sort((a, b) => a - b);
      const med =
        daysArr.length > 0 ? daysArr[Math.floor(daysArr.length / 2)] : 0;
      return {
        passRate: passed / wNO.length,
        avgDays: passed > 0 ? sumDays / passed : 0,
        medDays: med,
      };
    }

    console.log(`${wNO.length} non-overlap windows\n`);
    console.log(
      "config                           pass%   avgDays  medDays  EV($)",
    );

    // Fixed sizings (baseline)
    const fixed =
      (r: number): SizingFn =>
      () =>
        r;
    const b1 = batch(fixed(0.4));
    console.log(
      `fixed r40% (iter191)            ${(b1.passRate * 100).toFixed(2).padStart(5)}%    ${b1.avgDays.toFixed(1)}     ${b1.medDays.toString().padStart(2)}     +$${(b1.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
    );
    const b2 = batch(fixed(0.3));
    console.log(
      `fixed r30% (iter193)            ${(b2.passRate * 100).toFixed(2).padStart(5)}%    ${b2.avgDays.toFixed(1)}     ${b2.medDays.toString().padStart(2)}     +$${(b2.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    // Compound: start low, ramp after first winner
    const compound1: SizingFn = (eq) => {
      if (eq >= 1.08) return 0.1; // protect
      if (eq >= 1.04) return 0.4; // accelerate
      return 0.25; // start conservative
    };
    const b3 = batch(compound1);
    console.log(
      `compound 25→40→10 @ +4%/+8%     ${(b3.passRate * 100).toFixed(2).padStart(5)}%    ${b3.avgDays.toFixed(1)}     ${b3.medDays.toString().padStart(2)}     +$${(b3.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    const compound2: SizingFn = (eq) => {
      if (eq >= 1.09) return 0.05;
      if (eq >= 1.05) return 0.5;
      return 0.25;
    };
    const b4 = batch(compound2);
    console.log(
      `compound 25→50 @ +5%→lock +9%   ${(b4.passRate * 100).toFixed(2).padStart(5)}%    ${b4.avgDays.toFixed(1)}     ${b4.medDays.toString().padStart(2)}     +$${(b4.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    const compound3: SizingFn = (eq) => {
      if (eq >= 1.08) return 0.15;
      if (eq >= 1.03) return 0.45;
      return 0.3;
    };
    const b5 = batch(compound3);
    console.log(
      `compound 30→45 @ +3%→15 @ +8%   ${(b5.passRate * 100).toFixed(2).padStart(5)}%    ${b5.avgDays.toFixed(1)}     ${b5.medDays.toString().padStart(2)}     +$${(b5.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    // Aggressive: double after first winner
    const compound4: SizingFn = (eq) => {
      if (eq >= 1.08) return 0.1;
      if (eq >= 1.04) return 0.6; // 2× boost after first winner
      return 0.3;
    };
    const b6 = batch(compound4);
    console.log(
      `compound 30→60 @ +4%→10 @ +8%   ${(b6.passRate * 100).toFixed(2).padStart(5)}%    ${b6.avgDays.toFixed(1)}     ${b6.medDays.toString().padStart(2)}     +$${(b6.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    // Half-Kelly style: scale with profit
    const compound5: SizingFn = (eq) => {
      if (eq >= 1.09) return 0;
      const profit = eq - 1;
      const base = 0.3;
      return Math.max(0.2, base + profit * 2); // 30% at 0%, 40% at +5%, 50% at +10%
    };
    const b7 = batch(compound5);
    console.log(
      `profit-scaled linear            ${(b7.passRate * 100).toFixed(2).padStart(5)}%    ${b7.avgDays.toFixed(1)}     ${b7.medDays.toString().padStart(2)}     +$${(b7.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    // Martingale-style: increase after losses (contrarian)
    const martin: SizingFn = (eq) => {
      if (eq >= 1.08) return 0.1;
      if (eq <= 0.98) return 0.45; // after loss, bigger bet
      return 0.3;
    };
    const b8 = batch(martin);
    console.log(
      `martin up-after-loss            ${(b8.passRate * 100).toFixed(2).padStart(5)}%    ${b8.avgDays.toFixed(1)}     ${b8.medDays.toString().padStart(2)}     +$${(b8.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    // Anti-martingale: reduce after loss
    const antimartin: SizingFn = (eq) => {
      if (eq >= 1.08) return 0.1;
      if (eq <= 0.97) return 0.15; // scale down after DD
      if (eq >= 1.03) return 0.45;
      return 0.3;
    };
    const b9 = batch(antimartin);
    console.log(
      `anti-martin reduce-after-loss   ${(b9.passRate * 100).toFixed(2).padStart(5)}%    ${b9.avgDays.toFixed(1)}     ${b9.medDays.toString().padStart(2)}     +$${(b9.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    expect(true).toBe(true);
  });
});
