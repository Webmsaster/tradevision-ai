/**
 * Iter 193 — maximize pass rate with adaptive sizing.
 *
 * User: "ich will nur einen account und pass rate erhöhen"
 *
 * Current iter191: 49% pass. Goal: 55%+ without overfit.
 *
 * Strategies:
 *   A) Lower risk (20-35%) — safer but slower
 *   B) Adaptive sizing: start low, scale up after profit, back down near target
 *   C) Challenge-aware: pause trading after +8% (near target, protect gains)
 *   D) 3-bar trigger return (fewer but better signals)
 *   E) Longer holds 5-6 bars
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
  (equity: number, baseRisk: number): number;
}

function simFtmo(
  trades: Trade[],
  leverage: number,
  baseRisk: number,
  sizing?: SizingFn,
) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  let passed = false;
  for (const t of trades.sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  )) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    const risk = sizing ? sizing(eq, baseRisk) : baseRisk;
    if (risk <= 0) continue; // skip trade
    const pnlF = Math.max(t.rawPnl * leverage * risk, -risk);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq <= 0.9) return { passed: false, finalEq: eq - 1 };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) return { passed: false, finalEq: eq - 1 };
    if (eq >= 1.1 && td.size >= 4) {
      passed = true;
      break;
    }
  }
  if (!passed && eq >= 1.1 && td.size >= 4) passed = true;
  return { passed, finalEq: eq - 1 };
}

describe("iter 193 — max pass rate", () => {
  it("test sizing strategies", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 193: MAX PASS-RATE ===");
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
    console.log(`${wNO.length} non-overlap windows\n`);

    function batch(
      tp: number,
      stop: number,
      hold: number,
      trig: number,
      baseRisk: number,
      sizing?: SizingFn,
    ) {
      let passed = 0;
      for (const w of wNO) {
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(
            ...run(c4h[s], tp, stop, hold, w.start, w.end, cost[s], trig),
          );
        }
        if (simFtmo(all, 2, baseRisk, sizing).passed) passed++;
      }
      return passed / wNO.length;
    }

    // ─── A: Risk sweep LOW (maximize pass rate) ───
    console.log("── A: Low-risk sweep (tp 8% s 0.5% h 4 trig 2) ──");
    for (const rf of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4]) {
      const r = batch(0.08, 0.005, 4, 2, rf);
      console.log(
        `  risk ${(rf * 100).toFixed(0)}%:  pass ${(r * 100).toFixed(2)}%  EV +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // ─── B: 3-bar trigger at low risk ───
    console.log("\n── B: 3-bar trigger at low risk ──");
    for (const rf of [0.2, 0.25, 0.3, 0.35, 0.4, 0.5]) {
      const r = batch(0.1, 0.005, 4, 3, rf);
      console.log(
        `  3-bar tp10 risk ${(rf * 100).toFixed(0)}%:  pass ${(r * 100).toFixed(2)}%`,
      );
    }

    // ─── C: Longer holds (6 bars = 24h max) ───
    console.log("\n── C: Hold 6 bars (24h) variants ──");
    for (const tp of [0.06, 0.08, 0.1]) {
      for (const trig of [2, 3]) {
        for (const rf of [0.25, 0.3, 0.4]) {
          const r = batch(tp, 0.005, 6, trig, rf);
          console.log(
            `  tp${(tp * 100).toFixed(0)} trig${trig} risk ${(rf * 100).toFixed(0)}%:  pass ${(r * 100).toFixed(2)}%`,
          );
        }
      }
    }

    // ─── D: Adaptive sizing: pause after reaching +9% (lock gains) ───
    console.log("\n── D: Adaptive — pause trading near target ──");
    // After +8% equity, drop risk to 10% to protect; after +9.5% → 0
    const protectGains: SizingFn = (eq, base) => {
      if (eq >= 1.09) return 0; // stop trading near target
      if (eq >= 1.07) return base * 0.3; // scale down
      return base;
    };
    for (const rf of [0.3, 0.4, 0.5]) {
      const r = batch(0.08, 0.005, 4, 2, rf, protectGains);
      console.log(
        `  base ${(rf * 100).toFixed(0)}% + protectGains:  pass ${(r * 100).toFixed(2)}%`,
      );
    }

    // ─── E: Start low, scale up if losing ───
    console.log("\n── E: Challenge-aware dynamic ──");
    // Start 25%, scale up to 40% after first winner (eq > 1.03), protect near target
    const dynamic: SizingFn = (eq, base) => {
      if (eq >= 1.09) return 0; // near target → stop
      if (eq >= 1.07) return base * 0.3; // slow down
      if (eq <= 0.98) return base * 0.5; // drawdown → reduce
      if (eq >= 1.03) return base * 1.0; // on track, normal
      return base * 0.75; // start slightly reduced
    };
    for (const rf of [0.35, 0.4, 0.5]) {
      const r = batch(0.08, 0.005, 4, 2, rf, dynamic);
      console.log(
        `  base ${(rf * 100).toFixed(0)}% + dynamic:  pass ${(r * 100).toFixed(2)}%`,
      );
    }

    // ─── F: Final comparison ───
    console.log("\n── F: Top configs comparison ──");
    const candidates: Array<{ name: string; fn: () => number }> = [
      { name: "iter191 r40% fixed", fn: () => batch(0.08, 0.005, 4, 2, 0.4) },
      { name: "r30% fixed", fn: () => batch(0.08, 0.005, 4, 2, 0.3) },
      { name: "r25% fixed", fn: () => batch(0.08, 0.005, 4, 2, 0.25) },
      { name: "r20% fixed", fn: () => batch(0.08, 0.005, 4, 2, 0.2) },
      {
        name: "r40% + protectGains",
        fn: () => batch(0.08, 0.005, 4, 2, 0.4, protectGains),
      },
      {
        name: "r30% + protectGains",
        fn: () => batch(0.08, 0.005, 4, 2, 0.3, protectGains),
      },
      {
        name: "r40% + dynamic",
        fn: () => batch(0.08, 0.005, 4, 2, 0.4, dynamic),
      },
      { name: "3-bar r40% (iter190)", fn: () => batch(0.1, 0.005, 4, 3, 0.4) },
      {
        name: "hold 6 tp8 trig2 r30%",
        fn: () => batch(0.08, 0.005, 6, 2, 0.3),
      },
    ];
    console.log("config                         pass%   EV($)");
    for (const c of candidates) {
      const r = c.fn();
      console.log(
        `${c.name.padEnd(30)} ${(r * 100).toFixed(2).padStart(5)}%  +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    expect(true).toBe(true);
  });
});
