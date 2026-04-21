/**
 * Iter 192 — push both pass rate AND speed simultaneously.
 *
 * User: "also besser geht nicht oder und schneller zusammen"
 *
 * Current iter191: 49% pass rate, avg 15-20 days to pass.
 *
 * Test:
 *   A) NO cooldown — allow concurrent positions per asset
 *   B) 1h bars with big TP (more frequent triggers)
 *   C) Smaller TP (5%) with same stop — more frequent hits
 *   D) Measure time-to-pass distribution
 *   E) Smart entry: pyramid after 1st winner
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
  useCooldown = true,
): Trade[] {
  const out: Trade[] = [];
  if (!c[wS]) return out;
  const ts0 = c[wS].openTime;
  const cost = costBp / 10000;
  for (const dir of ["long", "short"] as const) {
    let cd = -1;
    for (let i = Math.max(triggerBars + 1, wS); i < wE - 1; i++) {
      if (useCooldown && i < cd) continue;
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

function simFtmoTimed(
  trades: Trade[],
  leverage: number,
  risk: number,
): {
  passed: boolean;
  daysToPass: number;
  finalEq: number;
} {
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
    if (eq <= 0.9) return { passed: false, daysToPass: -1, finalEq: eq - 1 };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05)
      return { passed: false, daysToPass: -1, finalEq: eq - 1 };
    if (eq >= 1.1 && td.size >= 4)
      return { passed: true, daysToPass: t.day + 1, finalEq: eq - 1 };
  }
  const late = eq >= 1.1 && td.size >= 4;
  return { passed: late, daysToPass: late ? 30 : -1, finalEq: eq - 1 };
}

describe("iter 192 — pass rate + speed", () => {
  it("test concurrent + freq variants", { timeout: 1_200_000 }, async () => {
    console.log("\n=== ITER 192: PASS + SPEED ===");
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

    function mkWins(len: number, winBars: number) {
      const ws: { start: number; end: number }[] = [];
      for (let s = 0; s + winBars < len; s += winBars)
        ws.push({ start: s, end: s + winBars });
      return ws;
    }
    const w4h = mkWins(a4h, 30 * 6);
    const w1h = mkWins(a1h, 30 * 24);

    function batch(
      cc: Record<string, Candle[]>,
      tp: number,
      stop: number,
      hold: number,
      trig: number,
      risk: number,
      useCooldown: boolean,
      wins: { start: number; end: number }[],
    ) {
      let passed = 0;
      let sumDaysToPass = 0;
      const daysList: number[] = [];
      for (const w of wins) {
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(
            ...run(
              cc[s],
              tp,
              stop,
              hold,
              w.start,
              w.end,
              cost[s],
              trig,
              useCooldown,
            ),
          );
        }
        const r = simFtmoTimed(all, 2, risk);
        if (r.passed) {
          passed++;
          sumDaysToPass += r.daysToPass;
          daysList.push(r.daysToPass);
        }
      }
      daysList.sort((a, b) => a - b);
      const median =
        daysList.length > 0 ? daysList[Math.floor(daysList.length / 2)] : 0;
      return {
        passRate: passed / wins.length,
        avgDaysToPass: passed > 0 ? sumDaysToPass / passed : 0,
        medianDaysToPass: median,
        passCount: passed,
        totalWindows: wins.length,
      };
    }

    // ─── A: iter191 baseline + days-to-pass distribution ───
    console.log("── A: iter191 baseline time-to-pass ──");
    const base = batch(c4h, 0.08, 0.005, 4, 2, 0.4, true, w4h);
    console.log(
      `  4h tp8 s0.5 h4 trig2 r40% cooldown:  pass ${base.passCount}/${base.totalWindows} (${(base.passRate * 100).toFixed(2)}%)  avgDays ${base.avgDaysToPass.toFixed(1)}  medianDays ${base.medianDaysToPass}`,
    );

    // ─── B: Concurrent positions (no cooldown) ───
    console.log("\n── B: No cooldown (concurrent positions) ──");
    for (const [tp, stop, hold, trig, rf] of [
      [0.08, 0.005, 4, 2, 0.4],
      [0.08, 0.005, 4, 2, 0.3],
      [0.08, 0.005, 4, 2, 0.25],
      [0.08, 0.005, 4, 2, 0.2],
      [0.05, 0.005, 4, 2, 0.25],
      [0.05, 0.005, 4, 2, 0.2],
      [0.1, 0.005, 4, 2, 0.25],
    ] as const) {
      const r = batch(c4h, tp, stop, hold, trig, rf, false, w4h);
      console.log(
        `  tp${(tp * 100).toFixed(0)} s${(stop * 100).toFixed(1)} h${hold} trig${trig} r${(rf * 100).toFixed(0)}%  pass ${(r.passRate * 100).toFixed(2)}%  avgDays ${r.avgDaysToPass.toFixed(1)}  med ${r.medianDaysToPass}`,
      );
    }

    // ─── C: 1h bars with larger TP ───
    console.log("\n── C: 1h bars (much more signals) ──");
    for (const [tp, stop, hold, trig, rf] of [
      [0.03, 0.005, 24, 3, 0.3],
      [0.03, 0.005, 24, 3, 0.25],
      [0.05, 0.005, 24, 3, 0.3],
      [0.05, 0.005, 24, 3, 0.25],
      [0.08, 0.005, 24, 3, 0.3],
      [0.03, 0.005, 12, 2, 0.25],
      [0.05, 0.005, 12, 2, 0.25],
    ] as const) {
      const r = batch(c1h, tp, stop, hold, trig, rf, true, w1h);
      console.log(
        `  1h tp${(tp * 100).toFixed(0)} s${(stop * 100).toFixed(1)} h${hold} trig${trig} r${(rf * 100).toFixed(0)}%  pass ${(r.passRate * 100).toFixed(2)}%  avgDays ${r.avgDaysToPass.toFixed(1)}  med ${r.medianDaysToPass}`,
      );
    }

    // ─── D: Best combos — detail ───
    console.log("\n── D: Best combos speed+pass ──");
    const candidates: Array<{
      name: string;
      fn: () => ReturnType<typeof batch>;
    }> = [
      {
        name: "4h iter191 base (cooldown)",
        fn: () => batch(c4h, 0.08, 0.005, 4, 2, 0.4, true, w4h),
      },
      {
        name: "4h no-cooldown r25%",
        fn: () => batch(c4h, 0.08, 0.005, 4, 2, 0.25, false, w4h),
      },
      {
        name: "4h no-cooldown r30%",
        fn: () => batch(c4h, 0.08, 0.005, 4, 2, 0.3, false, w4h),
      },
      {
        name: "4h tp5 no-cd r25%",
        fn: () => batch(c4h, 0.05, 0.005, 4, 2, 0.25, false, w4h),
      },
      {
        name: "1h tp3 3bar r25%",
        fn: () => batch(c1h, 0.03, 0.005, 24, 3, 0.25, true, w1h),
      },
      {
        name: "1h tp5 3bar r30%",
        fn: () => batch(c1h, 0.05, 0.005, 24, 3, 0.3, true, w1h),
      },
    ];
    console.log(
      "config                           pass%   avgDays   medDays   EV($)",
    );
    for (const c of candidates) {
      const r = c.fn();
      console.log(
        `${c.name.padEnd(32)} ${(r.passRate * 100).toFixed(2).padStart(5)}%   ${r.avgDaysToPass.toFixed(1).padStart(5)}     ${r.medianDaysToPass.toString().padStart(3)}      +$${(r.passRate * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    expect(true).toBe(true);
  });
});
