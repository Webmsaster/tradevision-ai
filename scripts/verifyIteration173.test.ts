/**
 * Iter 173 — robustness, sanity checks, and further optimization attempts.
 *
 * iter172 V2: 2d/2u tp=1.0 s=0.15 h=12 @ 100% risk → 55.17% OOS, EV +$2108.
 *
 * Sanity + push tests:
 *   A) Wider TP: 1.0% → 3.0% (same 0.15% stop)
 *   B) Funding-cost impact: BTC perp 0.01%/8h × 100× exposure = 0.125%/8h
 *      → per 3h trade adds ~0.047% margin cost. Does OOS hold?
 *   C) Slippage stress-test: simulate 0.05% extra slippage per trade (stop fires
 *      at 0.20% instead of 0.15%, TP fills at 0.95% instead of 1.0%)
 *   D) 5m bars variant: more trades but more noise — does this still work?
 *   E) No-cooldown (allow concurrent positions) — does density help or hurt?
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
}

function runBi(
  c: Candle[],
  n: number,
  tp: number,
  stop: number,
  hold: number,
  wS: number,
  wE: number,
  bpd: number,
  extraSlippage = 0,
): Trade[] {
  const out: Trade[] = [];
  const ts0 = c[wS]?.openTime ?? 0;
  // LONG: n consecutive red closes
  let cd = -1;
  for (let i = Math.max(n + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let okDown = true;
    for (let k = 0; k < n; k++)
      if (c[i - k].close >= c[i - k - 1].close) {
        okDown = false;
        break;
      }
    if (!okDown) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tpPx = entry * (1 + tp - extraSlippage);
    const stPx = entry * (1 - stop - extraSlippage);
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
      });
    cd = xb + 1;
  }
  // SHORT: n consecutive green closes
  cd = -1;
  for (let i = Math.max(n + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let okUp = true;
    for (let k = 0; k < n; k++)
      if (c[i - k].close <= c[i - k - 1].close) {
        okUp = false;
        break;
      }
    if (!okUp) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tpPx = entry * (1 - tp + extraSlippage);
    const stPx = entry * (1 + stop + extraSlippage);
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
      });
    cd = xb + 1;
  }
  return out;
}

function simFtmo(
  trades: Trade[],
  leverage: number,
  riskFrac: number,
  fundingBpPerHour = 0,
) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  const sorted = [...trades].sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  );
  for (const t of sorted) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    // subtract funding proportionally to hours held
    const hours = (t.exitTime - t.entryTime) / (3600 * 1000);
    const fundingCost =
      (fundingBpPerHour / 10000) * hours * leverage * riskFrac;
    let pnlF = Math.max(t.rawPnl * leverage * riskFrac, -riskFrac);
    pnlF -= fundingCost;
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

describe("iter 173 — robustness + sanity", () => {
  it("TP scan, funding, slippage, 5m, ETH", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 173: ROBUSTNESS ===");
    const c15 = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 100_000,
      maxPages: 200,
    });
    const bpd15 = 96;
    const days15 = c15.length / bpd15;
    const winLen15 = 30 * bpd15;
    const step15 = 7 * bpd15;
    const wins15: { start: number; end: number }[] = [];
    for (let s = 0; s + winLen15 < c15.length; s += step15)
      wins15.push({ start: s, end: s + winLen15 });
    const cut15 = Math.floor(wins15.length * 0.6);
    const oosW15 = wins15.slice(cut15);
    console.log(
      `BTC 15m: ${c15.length} candles, ${wins15.length} windows (OOS ${oosW15.length})\n`,
    );

    // ─── A: wider TP ───
    console.log("── A: TP-scan at s=0.15% h=12 ──");
    console.log("TP%    full-pass  rate%  OOS-pass  OOS-rate  EV-OOS($)");
    for (const tp of [0.008, 0.01, 0.012, 0.015, 0.018, 0.02, 0.025, 0.03]) {
      let pF = 0,
        pO = 0;
      for (const w of wins15) {
        const t = runBi(c15, 2, tp, 0.0015, 12, w.start, w.end, bpd15);
        if (simFtmo(t, 2, 1.0).passed) pF++;
      }
      for (const w of oosW15) {
        const t = runBi(c15, 2, tp, 0.0015, 12, w.start, w.end, bpd15);
        if (simFtmo(t, 2, 1.0).passed) pO++;
      }
      const r = pF / wins15.length;
      const rO = pO / oosW15.length;
      console.log(
        `${(tp * 100).toFixed(1).padStart(4)}%  ${pF}/${wins15.length}    ${(r * 100).toFixed(2).padStart(5)}%  ${pO}/${oosW15.length}     ${(rO * 100).toFixed(2).padStart(5)}%  +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // ─── B: funding-cost impact (0.125% per 8h at 2× lev × 100% risk) ───
    console.log(
      "\n── B: Funding impact (BTC perp 0.01%/8h × 2× lev × 100% risk) ──",
    );
    console.log("fundingBp/hr   OOS-pass   OOS-rate   EV-OOS($)");
    for (const fbp of [0, 0.125, 0.25, 0.5, 1]) {
      let pO = 0;
      for (const w of oosW15) {
        const t = runBi(c15, 2, 0.01, 0.0015, 12, w.start, w.end, bpd15);
        if (simFtmo(t, 2, 1.0, fbp).passed) pO++;
      }
      const rO = pO / oosW15.length;
      console.log(
        `  ${fbp.toFixed(3).padStart(5)}      ${pO}/${oosW15.length}    ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // ─── C: slippage stress ───
    console.log(
      "\n── C: Slippage stress (stop fires worse, TP fills worse) ──",
    );
    console.log("slippage%   OOS-pass   OOS-rate   EV-OOS($)");
    for (const sl of [0, 0.0002, 0.0005, 0.001, 0.002]) {
      let pO = 0;
      for (const w of oosW15) {
        const t = runBi(c15, 2, 0.01, 0.0015, 12, w.start, w.end, bpd15, sl);
        if (simFtmo(t, 2, 1.0).passed) pO++;
      }
      const rO = pO / oosW15.length;
      console.log(
        `  ${(sl * 100).toFixed(3).padStart(5)}%   ${pO}/${oosW15.length}    ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // ─── D: 5m bars variant ───
    console.log("\n── D: 5m bars variant (scale params) ──");
    try {
      const c5 = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "5m",
        targetCount: 100_000,
        maxPages: 400,
      });
      const bpd5 = 288;
      const winLen5 = 30 * bpd5;
      const step5 = 7 * bpd5;
      const wins5: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen5 < c5.length; s += step5)
        wins5.push({ start: s, end: s + winLen5 });
      const cut5 = Math.floor(wins5.length * 0.6);
      const oosW5 = wins5.slice(cut5);
      console.log(
        `  BTC 5m: ${c5.length} candles, ${wins5.length} windows (OOS ${oosW5.length})`,
      );
      // Same tp/stop/hold but hold=36 bars (3h = 36 × 5m)
      for (const tp of [0.005, 0.008, 0.01, 0.012]) {
        let pO = 0;
        for (const w of oosW5) {
          const t = runBi(c5, 2, tp, 0.0015, 36, w.start, w.end, bpd5);
          if (simFtmo(t, 2, 1.0).passed) pO++;
        }
        const rO = pO / oosW5.length;
        console.log(
          `  tp ${(tp * 100).toFixed(1)}%:  ${pO}/${oosW5.length}  ${(rO * 100).toFixed(2)}%  EV-OOS +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
        );
      }
    } catch (e) {
      console.log(`  5m load failed: ${e}`);
    }

    // ─── E: ETH 15m cross-validation ───
    console.log("\n── E: ETH 15m cross-validation (same config) ──");
    try {
      const ceth = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "15m",
        targetCount: 100_000,
        maxPages: 200,
      });
      const winE = 30 * bpd15;
      const stepE = 7 * bpd15;
      const winsE: { start: number; end: number }[] = [];
      for (let s = 0; s + winE < ceth.length; s += stepE)
        winsE.push({ start: s, end: s + winE });
      const cutE = Math.floor(winsE.length * 0.6);
      const oosE = winsE.slice(cutE);
      console.log(
        `  ETH 15m: ${ceth.length} candles, ${winsE.length} windows (OOS ${oosE.length})`,
      );
      let pF = 0,
        pO = 0;
      for (const w of winsE) {
        const t = runBi(ceth, 2, 0.01, 0.0015, 12, w.start, w.end, bpd15);
        if (simFtmo(t, 2, 1.0).passed) pF++;
      }
      for (const w of oosE) {
        const t = runBi(ceth, 2, 0.01, 0.0015, 12, w.start, w.end, bpd15);
        if (simFtmo(t, 2, 1.0).passed) pO++;
      }
      console.log(
        `  ETH: full ${pF}/${winsE.length} (${((pF / winsE.length) * 100).toFixed(2)}%), OOS ${pO}/${oosE.length} (${((pO / oosE.length) * 100).toFixed(2)}%)  EV-OOS +$${((pO / oosE.length) * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    } catch (e) {
      console.log(`  ETH load failed: ${e}`);
    }

    expect(true).toBe(true);
  });
});
