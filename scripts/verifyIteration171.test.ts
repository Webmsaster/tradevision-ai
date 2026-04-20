/**
 * Iter 171 — push even further: 2-down/2-up + stacked flash signals.
 *
 * iter170 winner: combined 3-down long + 3-up short @ TP 1.2% / stop 0.15-0.20%
 * gave 47.59% pass full-sample and **43.10% OOS** (EV-OOS +$1625).
 *
 * Probe:
 *   A) 2-down/2-up (more signals, noisier?)
 *   B) Triple stack: 3-down long + 3-up short + iter166 flash-crash trigger
 *   C) Asymmetric TP tighter/wider variants
 *   D) Fixed-risk reduction (70-80%) to see if safer-aggressive is better OOS
 *   E) Full 5-gate validation on final winner + IS/OOS
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
  dir: "long" | "short";
  kind: string;
}

function runNDown(
  c: Candle[],
  n: number,
  tp: number,
  stop: number,
  hold: number,
  wS: number,
  wE: number,
  bpd: number,
): Trade[] {
  const out: Trade[] = [];
  const ts0 = c[wS]?.openTime ?? 0;
  let cd = -1;
  for (let i = Math.max(n + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (c[i - k].close >= c[i - k - 1].close) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tpPx = entry * (1 + tp);
    const stPx = entry * (1 - stop);
    const mx = Math.min(i + 1 + hold, wE - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = c[j];
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
    }
    const pnl = applyCosts({
      entry,
      exit: xp,
      direction: "long",
      holdingHours: (xb - (i + 1)) / (bpd / 24),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    if (day >= 0)
      out.push({
        rawPnl: pnl,
        day,
        entryTime: eb.openTime,
        exitTime: c[xb].closeTime,
        dir: "long",
        kind: `${n}dn`,
      });
    cd = xb + 1;
  }
  return out;
}

function runNUpShort(
  c: Candle[],
  n: number,
  tp: number,
  stop: number,
  hold: number,
  wS: number,
  wE: number,
  bpd: number,
): Trade[] {
  const out: Trade[] = [];
  const ts0 = c[wS]?.openTime ?? 0;
  let cd = -1;
  for (let i = Math.max(n + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (c[i - k].close <= c[i - k - 1].close) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tpPx = entry * (1 - tp);
    const stPx = entry * (1 + stop);
    const mx = Math.min(i + 1 + hold, wE - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = c[j];
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
    const pnl = applyCosts({
      entry,
      exit: xp,
      direction: "short",
      holdingHours: (xb - (i + 1)) / (bpd / 24),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    if (day >= 0)
      out.push({
        rawPnl: pnl,
        day,
        entryTime: eb.openTime,
        exitTime: c[xb].closeTime,
        dir: "short",
        kind: `${n}up_S`,
      });
    cd = xb + 1;
  }
  return out;
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
    if (eq <= 0.9) return { passed: false, reason: "total_loss" };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) return { passed: false, reason: "daily_loss" };
    if (eq >= 1.1 && td.size >= 4)
      return { passed: true, reason: "profit_target" };
  }
  return {
    passed: eq >= 1.1 && td.size >= 4,
    reason:
      eq >= 1.1 ? "profit_target" : td.size < 4 ? "insufficient_days" : "time",
  };
}

describe("iter 171 — push daytrade FTMO further", () => {
  it("try 2-bars + triple stack + finalize", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 171: FURTHER FTMO OPT ===");
    const c = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 100_000,
      maxPages: 200,
    });
    const bpd = 96;
    const days = c.length / bpd;
    console.log(`${c.length} 15m (${days.toFixed(0)} days)`);
    const winLen = 30 * bpd;
    const step = 7 * bpd;
    const wins: { start: number; end: number }[] = [];
    for (let s = 0; s + winLen < c.length; s += step)
      wins.push({ start: s, end: s + winLen });
    console.log(`${wins.length} windows\n`);

    // ─── A: 2-down and 2-up ───
    console.log("── A: 2-down / 2-up variants ──");
    console.log("kind    tp%   stop%  hold  pass/N  rate%   EV($)");
    for (const n of [2, 3])
      for (const tp of [0.008, 0.01, 0.012])
        for (const stop of [0.0015, 0.002, 0.003])
          for (const hold of [4, 8, 12]) {
            let pL = 0;
            let pS = 0;
            let pC = 0;
            for (const w of wins) {
              const lT = runNDown(c, n, tp, stop, hold, w.start, w.end, bpd);
              const sT = runNUpShort(c, n, tp, stop, hold, w.start, w.end, bpd);
              if (simFtmo(lT, 2, 1.0).passed) pL++;
              if (simFtmo(sT, 2, 1.0).passed) pS++;
              if (simFtmo([...lT, ...sT], 2, 1.0).passed) pC++;
            }
            const rC = pC / wins.length;
            if (rC >= 0.4) {
              console.log(
                `  ${n}d/u  ${(tp * 100).toFixed(2).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${hold.toString().padStart(2)}   L:${pL} S:${pS} C:${pC}/${wins.length}  ${(rC * 100).toFixed(2)}%  +$${(rC * 0.5 * 8000 - 99).toFixed(0)}`,
              );
            }
          }

    // ─── B: FINAL WINNER (use iter170 config) + IS/OOS ───
    console.log("\n── B: FINAL — iter170 winner @ various risks ──");
    console.log("risk%   pass/N   rate%  IS-rate  OOS-rate  EV-OOS($)");
    const cut = Math.floor(wins.length * 0.6);
    const isW = wins.slice(0, cut);
    const oosW = wins.slice(cut);
    for (const rf of [0.5, 0.7, 0.8, 0.9, 1.0]) {
      let p = 0,
        pI = 0,
        pO = 0;
      for (const w of wins) {
        const lT = runNDown(c, 3, 0.012, 0.0015, 8, w.start, w.end, bpd);
        const sT = runNUpShort(c, 3, 0.012, 0.002, 8, w.start, w.end, bpd);
        if (simFtmo([...lT, ...sT], 2, rf).passed) p++;
      }
      for (const w of isW) {
        const lT = runNDown(c, 3, 0.012, 0.0015, 8, w.start, w.end, bpd);
        const sT = runNUpShort(c, 3, 0.012, 0.002, 8, w.start, w.end, bpd);
        if (simFtmo([...lT, ...sT], 2, rf).passed) pI++;
      }
      for (const w of oosW) {
        const lT = runNDown(c, 3, 0.012, 0.0015, 8, w.start, w.end, bpd);
        const sT = runNUpShort(c, 3, 0.012, 0.002, 8, w.start, w.end, bpd);
        if (simFtmo([...lT, ...sT], 2, rf).passed) pO++;
      }
      const rO = pO / oosW.length;
      console.log(
        `${(rf * 100).toFixed(0).padStart(3)}%   ${p}/${wins.length}   ${((p / wins.length) * 100).toFixed(2).padStart(5)}%  ${((pI / isW.length) * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%  +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // ─── C: Triple stack variants (3dn + 3up_S + 2dn as bonus) ───
    console.log(
      "\n── C: Triple stack: 3dn + 3up_S + 2dn (more signal density) ──",
    );
    for (const rf of [0.5, 0.6, 0.7, 0.8, 1.0]) {
      let p = 0,
        pO = 0;
      for (const w of wins) {
        const l3 = runNDown(c, 3, 0.012, 0.0015, 8, w.start, w.end, bpd);
        const s3 = runNUpShort(c, 3, 0.012, 0.002, 8, w.start, w.end, bpd);
        const l2 = runNDown(c, 2, 0.008, 0.0015, 4, w.start, w.end, bpd);
        if (simFtmo([...l3, ...s3, ...l2], 2, rf).passed) p++;
      }
      for (const w of oosW) {
        const l3 = runNDown(c, 3, 0.012, 0.0015, 8, w.start, w.end, bpd);
        const s3 = runNUpShort(c, 3, 0.012, 0.002, 8, w.start, w.end, bpd);
        const l2 = runNDown(c, 2, 0.008, 0.0015, 4, w.start, w.end, bpd);
        if (simFtmo([...l3, ...s3, ...l2], 2, rf).passed) pO++;
      }
      console.log(
        `  risk ${(rf * 100).toFixed(0)}%:  full ${p}/${wins.length} (${((p / wins.length) * 100).toFixed(2)}%)  OOS ${pO}/${oosW.length} (${((pO / oosW.length) * 100).toFixed(2)}%)  EV-OOS +$${((pO / oosW.length) * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // ─── D: HYBRID with iter166 flash-crash trigger added ───
    console.log(
      "\n── D: Add iter166 flash-crash (rare but big winner) at 50% risk ──",
    );
    // Use 4h lookback-equivalent in 15m bars = 16 bars for a 15% drop
    // Actually flash-crash uses 72h = 288 bars on 15m, too rare. Use 48h = 192 bars for 10% drop
    // But this is close to iter160's flash10 equivalent on 15m
    // Simpler: use SYNC flash-crash on hourly data — skip for now, test alone
    console.log("  (flash-crash too rare on 15m; sticking with 3dn+3up_S)");

    expect(true).toBe(true);
  });
});
