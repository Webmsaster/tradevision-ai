/**
 * Iter 197 — time-adaptive sizing to reduce timeout fails.
 *
 * User wants 60% pass rate. iter196 filters failed.
 *
 * Hypothesis: many failed challenges are TIME-OUT fails (day 30 but equity < +10%).
 * If we boost risk when time is running out AND equity is behind target,
 * we catch more would-be-timeouts.
 *
 * Logic:
 *   - Days 1-18: normal compound sizing (30→45→15)
 *   - Days 19-25: if equity < +7%, boost risk (catch-up)
 *   - Days 26-30: maximum urgency if still < +9%
 *
 * Test multiple curves.
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

type SizingFn = (equity: number, day: number) => number;

function simFtmo(trades: Trade[], leverage: number, sizing: SizingFn) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  let passDay = -1;
  let failReason: "total" | "daily" | "" = "";
  for (const t of trades.sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  )) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    const risk = sizing(eq, t.day);
    if (risk <= 0) continue;
    const pnlF = Math.max(t.rawPnl * leverage * risk, -risk);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq <= 0.9) {
      failReason = "total";
      return { passed: false, daysToPass: -1, reason: "total" as const };
    }
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) {
      failReason = "daily";
      return { passed: false, daysToPass: -1, reason: "daily" as const };
    }
    if (eq >= 1.1 && td.size >= 4) {
      passDay = t.day + 1;
      break;
    }
  }
  const late = eq >= 1.1 && td.size >= 4;
  return {
    passed: passDay > 0 || late,
    daysToPass: passDay > 0 ? passDay : late ? 30 : -1,
    reason: passDay > 0 || late ? ("pass" as const) : ("timeout" as const),
  };
}

describe("iter 197 — time-adaptive sizing", () => {
  it(
    "catch timeout fails with urgency scaling",
    { timeout: 1_200_000 },
    async () => {
      console.log("\n=== ITER 197: TIME-ADAPTIVE ===");
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

      function batch(sizing: SizingFn) {
        let passed = 0;
        const reasonCount = { pass: 0, timeout: 0, total: 0, daily: 0 };
        const days: number[] = [];
        for (const w of wNO) {
          const all: Trade[] = [];
          for (const s of symbols) {
            all.push(
              ...run(c4h[s], 0.08, 0.005, 3, w.start, w.end, cost[s], 2),
            );
          }
          const r = simFtmo(all, 2, sizing);
          reasonCount[r.reason]++;
          if (r.passed) {
            passed++;
            days.push(r.daysToPass);
          }
        }
        days.sort((a, b) => a - b);
        const med = days.length > 0 ? days[Math.floor(days.length / 2)] : 0;
        return {
          passRate: passed / wNO.length,
          medDays: med,
          reasons: reasonCount,
        };
      }

      console.log(`${wNO.length} non-overlap windows\n`);
      console.log(
        "config                                      pass%   med   fail-timeout  EV($)",
      );

      // Baseline compound
      const baseCompound: SizingFn = (eq) => {
        if (eq >= 1.08) return 0.15;
        if (eq >= 1.03) return 0.45;
        return 0.3;
      };
      const b1 = batch(baseCompound);
      console.log(
        `baseline compound (iter195)                 ${(b1.passRate * 100).toFixed(2).padStart(5)}%   ${b1.medDays}   timeout:${b1.reasons.timeout}  total:${b1.reasons.total}  EV +$${(b1.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
      );

      // Time-adaptive: boost if late + behind
      const timeBoost1: SizingFn = (eq, day) => {
        if (eq >= 1.08) return 0.15;
        // Late-challenge urgency: day 22+, behind target
        if (day >= 22 && eq < 1.08) return 0.55; // urgency boost
        if (day >= 18 && eq < 1.06) return 0.5;
        if (eq >= 1.03) return 0.45;
        return 0.3;
      };
      const b2 = batch(timeBoost1);
      console.log(
        `time-boost A (day22+ if eq<8%)              ${(b2.passRate * 100).toFixed(2).padStart(5)}%   ${b2.medDays}   timeout:${b2.reasons.timeout}  total:${b2.reasons.total}  EV +$${(b2.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
      );

      // More aggressive late boost
      const timeBoost2: SizingFn = (eq, day) => {
        if (eq >= 1.08) return 0.15;
        if (day >= 25 && eq < 1.08) return 0.7; // very aggressive
        if (day >= 22 && eq < 1.07) return 0.55;
        if (day >= 18 && eq < 1.05) return 0.5;
        if (eq >= 1.03) return 0.45;
        return 0.3;
      };
      const b3 = batch(timeBoost2);
      console.log(
        `time-boost B (aggressive late)              ${(b3.passRate * 100).toFixed(2).padStart(5)}%   ${b3.medDays}   timeout:${b3.reasons.timeout}  total:${b3.reasons.total}  EV +$${(b3.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
      );

      // Start slow, ramp up exponentially
      const timeBoost3: SizingFn = (eq, day) => {
        if (eq >= 1.08) return 0.15;
        // Linear ramp: more urgency as day grows
        const timePressure = day / 30; // 0 to 1
        const behindness = Math.max(0, (1.08 - eq) / 0.08); // 0 to 1
        const urgency = timePressure * behindness;
        const baseBoost = 0.3 + urgency * 0.4; // 30% to 70%
        return Math.min(0.65, baseBoost);
      };
      const b4 = batch(timeBoost3);
      console.log(
        `time-boost C (continuous urgency)           ${(b4.passRate * 100).toFixed(2).padStart(5)}%   ${b4.medDays}   timeout:${b4.reasons.timeout}  total:${b4.reasons.total}  EV +$${(b4.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
      );

      // Keep compound but boost only late
      const timeBoost4: SizingFn = (eq, day) => {
        if (eq >= 1.08) return 0.15;
        if (day >= 20 && eq < 1.07) return 0.55; // day 20+, <+7% → push harder
        if (eq >= 1.03) return 0.45;
        return 0.3;
      };
      const b5 = batch(timeBoost4);
      console.log(
        `time-boost D (day20+ behind)                ${(b5.passRate * 100).toFixed(2).padStart(5)}%   ${b5.medDays}   timeout:${b5.reasons.timeout}  total:${b5.reasons.total}  EV +$${(b5.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
      );

      // Day 15+ boost
      const timeBoost5: SizingFn = (eq, day) => {
        if (eq >= 1.08) return 0.15;
        if (day >= 15 && eq < 1.05) return 0.55;
        if (eq >= 1.03) return 0.45;
        return 0.3;
      };
      const b6 = batch(timeBoost5);
      console.log(
        `time-boost E (day15+ if <+5%)               ${(b6.passRate * 100).toFixed(2).padStart(5)}%   ${b6.medDays}   timeout:${b6.reasons.timeout}  total:${b6.reasons.total}  EV +$${(b6.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
      );

      // Boost after 10 days if no progress
      const timeBoost6: SizingFn = (eq, day) => {
        if (eq >= 1.08) return 0.15;
        if (day >= 10 && eq < 1.03) return 0.5; // early boost if zero progress
        if (eq >= 1.03) return 0.45;
        return 0.3;
      };
      const b7 = batch(timeBoost6);
      console.log(
        `time-boost F (day10+ if <+3%)               ${(b7.passRate * 100).toFixed(2).padStart(5)}%   ${b7.medDays}   timeout:${b7.reasons.timeout}  total:${b7.reasons.total}  EV +$${(b7.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
      );

      expect(true).toBe(true);
    },
  );
});
