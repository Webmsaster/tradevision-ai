/**
 * Iter 191 — push daily returns with aggressive variants.
 *
 * User: "kann man pro tag noch mehr rausholen vl mehr risiko oder irgendwas?"
 *
 * Test systematically:
 *   A) Risk sweep 30-80% per asset on 3-asset 24h-hold
 *   B) 2-bar trigger (more frequent) vs 3-bar
 *   C) Progressive sizing (double risk after +3% equity gained)
 *   D) Concurrent positions (allow 2 positions per asset at once)
 *   E) Smaller TPs (5%, 8%) for more frequent hits
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

function simFtmo(
  trades: Trade[],
  leverage: number,
  baseRisk: number,
  progressive?: { threshold: number; factor: number },
): { passed: boolean; finalEq: number; avgDaily: number; tradingDays: number } {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  let passed = false;
  for (const t of trades.sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  )) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    let risk = baseRisk;
    if (progressive && eq - 1 >= progressive.threshold)
      risk *= progressive.factor;
    risk = Math.min(risk, 1);
    const pnlF = Math.max(t.rawPnl * leverage * risk, -risk);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq <= 0.9)
      return {
        passed: false,
        finalEq: eq - 1,
        avgDaily: 0,
        tradingDays: td.size,
      };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05)
      return {
        passed: false,
        finalEq: eq - 1,
        avgDaily: 0,
        tradingDays: td.size,
      };
    if (eq >= 1.1 && td.size >= 4) {
      passed = true;
      break;
    }
  }
  if (!passed && eq >= 1.1 && td.size >= 4) passed = true;
  return {
    passed,
    finalEq: eq - 1,
    avgDaily: td.size > 0 ? (eq - 1) / td.size : 0,
    tradingDays: td.size,
  };
}

describe("iter 191 — push daily returns", () => {
  it("test aggressive variants", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 191: PUSH DAILY ===");
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

    function runBatch(
      tp: number,
      stop: number,
      hold: number,
      trig: number,
      risk: number,
      prog?: { threshold: number; factor: number },
    ) {
      let passed = 0;
      let sumFinalEq = 0;
      let sumAvgDaily = 0;
      for (const w of wNO) {
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(
            ...run(c4h[s], tp, stop, hold, w.start, w.end, cost[s], trig),
          );
        }
        const r = simFtmo(all, 2, risk, prog);
        if (r.passed) passed++;
        sumFinalEq += r.finalEq;
        sumAvgDaily += r.avgDaily;
      }
      return {
        passRate: passed / wNO.length,
        avgFinalEq: sumFinalEq / wNO.length,
        avgDailyReturn: sumAvgDaily / wNO.length,
      };
    }

    // ─── A: Risk sweep (base iter190 tp=10% stop=0.5% h=4 trig=3) ───
    console.log("── A: Risk sweep (3-bar, tp=10%, stop=0.5%, h=4) ──");
    console.log("risk%  pass%   avgEq%   avgDaily%");
    for (const rf of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
      const r = runBatch(0.1, 0.005, 4, 3, rf);
      console.log(
        `${(rf * 100).toFixed(0).padStart(3)}%   ${(r.passRate * 100).toFixed(2).padStart(5)}%  ${(r.avgFinalEq * 100).toFixed(2).padStart(5)}%  ${(r.avgDailyReturn * 100).toFixed(3).padStart(5)}%`,
      );
    }

    // ─── B: 2-bar trigger (more signals) ───
    console.log("\n── B: 2-bar trigger (more signals) ──");
    console.log("tp%   stop%  hold  risk%  pass%   avgEq%   avgDaily%");
    for (const tp of [0.05, 0.08, 0.1]) {
      for (const stop of [0.005, 0.01]) {
        for (const hold of [4, 6]) {
          for (const rf of [0.3, 0.4, 0.5]) {
            const r = runBatch(tp, stop, hold, 2, rf);
            if (r.passRate >= 0.4) {
              console.log(
                `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${hold.toString().padStart(2)}   ${(rf * 100).toFixed(0).padStart(3)}%   ${(r.passRate * 100).toFixed(2).padStart(5)}%  ${(r.avgFinalEq * 100).toFixed(2).padStart(5)}%  ${(r.avgDailyReturn * 100).toFixed(3).padStart(5)}%`,
              );
            }
          }
        }
      }
    }

    // ─── C: Progressive sizing (double risk after +3% equity) ───
    console.log("\n── C: Progressive sizing (2× after +3% gain) ──");
    console.log("baseRisk%  threshold  factor  pass%   avgEq%   avgDaily%");
    for (const base of [0.2, 0.3, 0.4]) {
      for (const thr of [0.02, 0.03, 0.05]) {
        for (const fac of [1.5, 2.0, 3.0]) {
          const r = runBatch(0.1, 0.005, 4, 3, base, {
            threshold: thr,
            factor: fac,
          });
          if (r.passRate >= 0.4) {
            console.log(
              `  ${(base * 100).toFixed(0).padStart(2)}%      +${(thr * 100).toFixed(1)}%      ${fac.toFixed(1)}×    ${(r.passRate * 100).toFixed(2).padStart(5)}%  ${(r.avgFinalEq * 100).toFixed(2).padStart(5)}%  ${(r.avgDailyReturn * 100).toFixed(3).padStart(5)}%`,
            );
          }
        }
      }
    }

    // ─── D: Summary of best daily return ───
    console.log("\n── D: Best DAILY RETURN candidates ──");
    const candidates: Array<{
      name: string;
      fn: () => ReturnType<typeof runBatch>;
    }> = [
      {
        name: "iter190 baseline (r40% 3bar)",
        fn: () => runBatch(0.1, 0.005, 4, 3, 0.4),
      },
      { name: "r50% 3bar", fn: () => runBatch(0.1, 0.005, 4, 3, 0.5) },
      { name: "r60% 3bar", fn: () => runBatch(0.1, 0.005, 4, 3, 0.6) },
      { name: "r70% 3bar", fn: () => runBatch(0.1, 0.005, 4, 3, 0.7) },
      {
        name: "r40% 2bar tp5 s0.5",
        fn: () => runBatch(0.05, 0.005, 4, 2, 0.4),
      },
      {
        name: "r40% 2bar tp8 s0.5",
        fn: () => runBatch(0.08, 0.005, 4, 2, 0.4),
      },
      {
        name: "r30% prog+3%/2×",
        fn: () =>
          runBatch(0.1, 0.005, 4, 3, 0.3, { threshold: 0.03, factor: 2 }),
      },
      {
        name: "r40% prog+3%/2×",
        fn: () =>
          runBatch(0.1, 0.005, 4, 3, 0.4, { threshold: 0.03, factor: 2 }),
      },
    ];
    console.log(
      "config                          pass%   avgEq%   avgDaily%   EV($)",
    );
    for (const c of candidates) {
      const r = c.fn();
      console.log(
        `${c.name.padEnd(33)} ${(r.passRate * 100).toFixed(2).padStart(5)}%  ${(r.avgFinalEq * 100).toFixed(2).padStart(5)}%  ${(r.avgDailyReturn * 100).toFixed(3).padStart(5)}%   +$${(r.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    expect(true).toBe(true);
  });
});
