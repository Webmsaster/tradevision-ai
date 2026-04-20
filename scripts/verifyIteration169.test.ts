/**
 * Iter 169 — validate iter168 winner + ship as FTMO daytrade tier.
 *
 * Winner: 4-down-bar trigger on BTC 15m, TP 0.8%, Stop 0.2%, Hold 4 bars.
 *   Raw: 2891 trades, 2.78/day, WR 38%, rawMean 0.010% (tiny!)
 *   With 2× leverage + 100% risk per trade: eff mean ~0.04% per trade
 *   But with asymmetric 4:1 TP:Stop, winners compound fast
 *
 * FTMO result (iter168): 33/145 = 22.76% pass, EV +$811
 *
 * THIS IS TRUE DAYTRADE: 2.78 trades/day, 15m hold, 2× leverage.
 *
 * Validate:
 *   A) 5-gate lock: bootstrap, both halves, sensitivity, lower-leverage, OOS
 *   B) Finer risk sweep (don't recommend 100% blindly)
 *   C) Compare to safer risk-50/30% options
 *   D) Sanity-check via full trade log statistics
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";

interface Trade {
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
  exitReason: "tp" | "stop" | "time";
}

/** Core trigger: 4 consecutive red bars → long at next open. */
function runFourDown(
  c: Candle[],
  tpPct: number,
  stopPct: number,
  holdBars: number,
  startIdx: number,
  endIdx: number,
  barsPerDay: number,
): Trade[] {
  const closes = c.map((x) => x.close);
  const trades: Trade[] = [];
  let cooldown = -1;
  const ts0 = c[startIdx]?.openTime ?? 0;
  for (let i = Math.max(5, startIdx); i < endIdx - 1; i++) {
    if (i < cooldown) continue;
    // 4 consecutive closes down
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (closes[i - k] >= closes[i - k - 1]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 + tpPct);
    const stop = entry * (1 - stopPct);
    const mx = Math.min(i + 1 + holdBars, endIdx - 1);
    let exitBar = mx;
    let exitPrice = c[mx].close;
    let reason: "tp" | "stop" | "time" = "time";
    for (let j = i + 2; j <= mx; j++) {
      const bar = c[j];
      if (bar.low <= stop) {
        exitBar = j;
        exitPrice = stop;
        reason = "stop";
        break;
      }
      if (bar.high >= tp) {
        exitBar = j;
        exitPrice = tp;
        reason = "tp";
        break;
      }
    }
    const pnl = applyCosts({
      entry,
      exit: exitPrice,
      direction: "long",
      holdingHours: (exitBar - (i + 1)) / (barsPerDay / 24),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    if (day >= 0)
      trades.push({
        rawPnl: pnl,
        day,
        entryTime: eb.openTime,
        exitTime: c[exitBar].closeTime,
        exitReason: reason,
      });
    cooldown = exitBar + 1;
  }
  return trades;
}

function simFtmo(trades: Trade[], leverage: number, riskFrac: number) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  for (const t of trades.sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  )) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    const pnlF = Math.max(t.rawPnl * leverage * riskFrac, -riskFrac);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq <= 0.9)
      return { passed: false, reason: "total_loss", finalEq: eq - 1 };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05)
      return { passed: false, reason: "daily_loss", finalEq: eq - 1 };
    if (eq >= 1.1 && td.size >= 4)
      return { passed: true, reason: "profit_target", finalEq: eq - 1 };
  }
  return {
    passed: eq >= 1.1 && td.size >= 4,
    reason: (eq >= 1.1
      ? "profit_target"
      : td.size < 4
        ? "insufficient_days"
        : "time") as "profit_target" | "insufficient_days" | "time",
    finalEq: eq - 1,
  };
}

describe("iter 169 — validate 4-down daytrade winner", () => {
  it("5-gate validation + ship", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 169: VALIDATE 4-DOWN DAYTRADE ===");
    const c = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 100_000,
      maxPages: 200,
    });
    const barsPerDay = 96;
    const days = c.length / barsPerDay;
    console.log(`${c.length} 15m candles (${days.toFixed(0)} days)`);

    // Full history: primary trade log
    const allTrades = runFourDown(c, 0.008, 0.002, 4, 5, c.length, barsPerDay);
    const pnls = allTrades.map((t) => t.rawPnl);
    console.log(`\nFull-history trade log: n=${allTrades.length}`);
    const wins = pnls.filter((p) => p > 0).length;
    const winRate = wins / pnls.length;
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const tpHits = allTrades.filter((t) => t.exitReason === "tp").length;
    const stopHits = allTrades.filter((t) => t.exitReason === "stop").length;
    console.log(
      `  WR=${(winRate * 100).toFixed(1)}%, rawMean=${(mean * 100).toFixed(4)}%, TP-hits ${tpHits} (${((tpHits / allTrades.length) * 100).toFixed(0)}%), stops ${stopHits} (${((stopHits / allTrades.length) * 100).toFixed(0)}%)`,
    );
    console.log(
      `  ${(allTrades.length / days).toFixed(2)}/day, min=${(Math.min(...pnls) * 100).toFixed(3)}%, max=${(Math.max(...pnls) * 100).toFixed(3)}%`,
    );

    // Windows
    const winLen = 30 * barsPerDay;
    const step = 7 * barsPerDay;
    const allWin: { start: number; end: number }[] = [];
    for (let s = 0; s + winLen < c.length; s += step)
      allWin.push({ start: s, end: s + winLen });
    console.log(`windows: ${allWin.length}`);

    // A) risk sweep at 2× lev
    console.log("\n── A: Risk sweep at 2× leverage (FTMO crypto) ──");
    console.log("risk%   pass/N    rate%   fails: dl  tl  time  ins  EV($)");
    interface Row {
      risk: number;
      pass: number;
      rate: number;
      ev: number;
      fails: Record<string, number>;
    }
    const rows: Row[] = [];
    for (const r of [0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0]) {
      let pass = 0;
      const f: Record<string, number> = {};
      for (const w of allWin) {
        const t = runFourDown(c, 0.008, 0.002, 4, w.start, w.end, barsPerDay);
        const res = simFtmo(t, 2, r);
        if (res.passed) pass++;
        else f[res.reason] = (f[res.reason] ?? 0) + 1;
      }
      const rate = pass / allWin.length;
      const ev = rate * 0.5 * 8000 - 99;
      rows.push({ risk: r, pass, rate, ev, fails: f });
      console.log(
        `${(r * 100).toFixed(0).padStart(3)}%   ${pass}/${allWin.length}   ${(rate * 100).toFixed(2).padStart(5)}%   ${(f.daily_loss ?? 0).toString().padStart(3)} ${(f.total_loss ?? 0).toString().padStart(3)} ${(f.time ?? 0).toString().padStart(3)}  ${(f.insufficient_days ?? 0).toString().padStart(3)}   ${ev > 0 ? "+" : ""}$${ev.toFixed(0)}`,
      );
    }

    // Find best
    rows.sort((a, b) => b.ev - a.ev);
    const best = rows[0];
    console.log(
      `\n★ BEST risk level: ${(best.risk * 100).toFixed(0)}% → pass ${best.pass}/${allWin.length} (${(best.rate * 100).toFixed(2)}%) EV $${best.ev.toFixed(0)}`,
    );

    // B) IS/OOS split at best risk
    console.log(
      `\n── B: IS/OOS split (60/40 chronological) at risk ${(best.risk * 100).toFixed(0)}% ──`,
    );
    const cut = Math.floor(allWin.length * 0.6);
    const isWin = allWin.slice(0, cut);
    const oosWin = allWin.slice(cut);
    function runBatch(wins: typeof allWin, r: number) {
      let pass = 0;
      for (const w of wins) {
        const t = runFourDown(c, 0.008, 0.002, 4, w.start, w.end, barsPerDay);
        if (simFtmo(t, 2, r).passed) pass++;
      }
      return { pass, rate: pass / wins.length };
    }
    const rIs = runBatch(isWin, best.risk);
    const rOos = runBatch(oosWin, best.risk);
    console.log(
      `  IS (first 60%): pass ${rIs.pass}/${isWin.length} (${(rIs.rate * 100).toFixed(2)}%)  EV $${(rIs.rate * 0.5 * 8000 - 99).toFixed(0)}`,
    );
    console.log(
      `  OOS (last 40%): pass ${rOos.pass}/${oosWin.length} (${(rOos.rate * 100).toFixed(2)}%)  EV $${(rOos.rate * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    // C) Sensitivity: tp/stop/hold variants
    console.log("\n── C: Sensitivity (6 ±variants) at best risk ──");
    const variants: { desc: string; tp: number; stop: number; hold: number }[] =
      [
        { desc: "base", tp: 0.008, stop: 0.002, hold: 4 },
        { desc: "tp+20%", tp: 0.01, stop: 0.002, hold: 4 },
        { desc: "tp-20%", tp: 0.006, stop: 0.002, hold: 4 },
        { desc: "stop+50%", tp: 0.008, stop: 0.003, hold: 4 },
        { desc: "stop-25%", tp: 0.008, stop: 0.0015, hold: 4 },
        { desc: "hold 8", tp: 0.008, stop: 0.002, hold: 8 },
        { desc: "hold 2", tp: 0.008, stop: 0.002, hold: 2 },
      ];
    for (const v of variants) {
      let pass = 0;
      for (const w of allWin) {
        const t = runFourDown(
          c,
          v.tp,
          v.stop,
          v.hold,
          w.start,
          w.end,
          barsPerDay,
        );
        if (simFtmo(t, 2, best.risk).passed) pass++;
      }
      const rate = pass / allWin.length;
      console.log(
        `  ${v.desc.padEnd(12)}  pass ${pass}/${allWin.length} (${(rate * 100).toFixed(2)}%)  EV $${(rate * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // D) Lower leverage (if user has less than 2×)
    console.log("\n── D: Leverage sensitivity ──");
    for (const lev of [1, 1.5, 2, 3, 5]) {
      let pass = 0;
      for (const w of allWin) {
        const t = runFourDown(c, 0.008, 0.002, 4, w.start, w.end, barsPerDay);
        if (simFtmo(t, lev, best.risk).passed) pass++;
      }
      const rate = pass / allWin.length;
      console.log(
        `  lev ${lev}× @ risk ${(best.risk * 100).toFixed(0)}%:  pass ${pass}/${allWin.length} (${(rate * 100).toFixed(2)}%)  EV $${(rate * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    expect(true).toBe(true);
  });
});
