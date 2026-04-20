/**
 * Iter 177 — sanity-check + ship BTC V3 daytrade (stop 0.1%).
 *
 * iter176 breakthrough: reducing stop from 0.15% to 0.1% transforms BTC
 * OOS pass rate from 55% to 77-79%. Lets validate:
 *   A) Monte-Carlo 200 random starts
 *   B) Walk-forward with locked params
 *   C) Slippage stress (0.1% stop is more slippage-sensitive)
 *   D) Funding cost impact
 *   E) Compare tp=1.5/hold=8 vs tp=1.5/hold=20 heads-up
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
  slippage = 0,
): Trade[] {
  const out: Trade[] = [];
  const ts0 = c[wS]?.openTime ?? 0;
  let cd = -1;
  // LONG
  for (let i = Math.max(n + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let okDn = true;
    for (let k = 0; k < n; k++)
      if (c[i - k].close >= c[i - k - 1].close) {
        okDn = false;
        break;
      }
    if (!okDn) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tpPx = entry * (1 + tp - slippage);
    const stPx = entry * (1 - stop - slippage);
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
  // SHORT
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
    const tpPx = entry * (1 - tp + slippage);
    const stPx = entry * (1 + stop + slippage);
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

function simFtmo(trades: Trade[], leverage: number, riskFrac: number) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  const sorted = [...trades].sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  );
  for (const t of sorted) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    const pnlF = Math.max(t.rawPnl * leverage * riskFrac, -riskFrac);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq <= 0.9) return { passed: false };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) return { passed: false };
    if (eq >= 1.1 && td.size >= 4) return { passed: true };
  }
  return { passed: eq >= 1.1 && td.size >= 4 };
}

describe("iter 177 — BTC V3 sanity + ship", () => {
  it("validate stop=0.1% config", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 177: BTC V3 SANITY ===");
    const c = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 100_000,
      maxPages: 200,
    });
    const bpd = 96;
    const winLen = 30 * bpd;
    const winsNo: { start: number; end: number }[] = [];
    for (let s = 0; s + winLen < c.length; s += winLen)
      winsNo.push({ start: s, end: s + winLen });
    console.log(`${c.length} candles, ${winsNo.length} non-overlap windows\n`);

    // candidates
    interface Cfg {
      name: string;
      tp: number;
      stop: number;
      hold: number;
    }
    const cands: Cfg[] = [
      { name: "tp1.5 s0.1 h8", tp: 0.015, stop: 0.001, hold: 8 },
      { name: "tp1.5 s0.1 h20", tp: 0.015, stop: 0.001, hold: 20 },
      { name: "tp1.5 s0.1 h12", tp: 0.015, stop: 0.001, hold: 12 },
      { name: "tp1.2 s0.1 h12", tp: 0.012, stop: 0.001, hold: 12 },
      { name: "tp1.8 s0.1 h12", tp: 0.018, stop: 0.001, hold: 12 },
    ];

    // ─── A: non-overlap + walk-forward ───
    console.log("── A: Non-overlap + walk-forward ──");
    const cutPart = Math.floor(c.length * 0.6);
    const winsIS: { start: number; end: number }[] = [];
    for (let s = 0; s + winLen < cutPart; s += winLen)
      winsIS.push({ start: s, end: s + winLen });
    const winsOOS: { start: number; end: number }[] = [];
    for (let s = cutPart; s + winLen < c.length; s += winLen)
      winsOOS.push({ start: s, end: s + winLen });
    console.log(
      `  IS non-overlap: ${winsIS.length}, OOS non-overlap: ${winsOOS.length}\n`,
    );
    console.log("config              NOV%   IS%   OOS%  EV-OOS($)");
    for (const cfg of cands) {
      let pN = 0,
        pI = 0,
        pO = 0;
      for (const w of winsNo) {
        const t = runBi(c, 2, cfg.tp, cfg.stop, cfg.hold, w.start, w.end, bpd);
        if (simFtmo(t, 2, 1.0).passed) pN++;
      }
      for (const w of winsIS) {
        const t = runBi(c, 2, cfg.tp, cfg.stop, cfg.hold, w.start, w.end, bpd);
        if (simFtmo(t, 2, 1.0).passed) pI++;
      }
      for (const w of winsOOS) {
        const t = runBi(c, 2, cfg.tp, cfg.stop, cfg.hold, w.start, w.end, bpd);
        if (simFtmo(t, 2, 1.0).passed) pO++;
      }
      const rN = pN / winsNo.length;
      const rI = pI / winsIS.length;
      const rO = pO / winsOOS.length;
      console.log(
        `${cfg.name.padEnd(18)}  ${(rN * 100).toFixed(2).padStart(5)}%  ${(rI * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%  +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // ─── B: Monte-Carlo 200 random starts on winner ───
    console.log("\n── B: Monte-Carlo 200 random starts (tp1.5 s0.1 h20) ──");
    let seed = 12345;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const rf of [0.5, 0.7, 1.0]) {
      let p = 0;
      for (let i = 0; i < 200; i++) {
        const start = Math.floor(rng() * (c.length - winLen));
        const t = runBi(c, 2, 0.015, 0.001, 20, start, start + winLen, bpd);
        if (simFtmo(t, 2, rf).passed) p++;
      }
      const r = p / 200;
      console.log(
        `  risk ${(rf * 100).toFixed(0)}%:  ${p}/200 (${(r * 100).toFixed(2)}%)  EV +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // ─── C: Slippage stress on the winner (0.1% stop is slippage-sensitive) ───
    console.log("\n── C: Slippage stress on winner (tp1.5 s0.1 h20 @ 100%) ──");
    console.log("slip%   NOV%    EV($)");
    for (const sl of [0, 0.0001, 0.0002, 0.0005, 0.001]) {
      let p = 0;
      for (const w of winsNo) {
        const t = runBi(c, 2, 0.015, 0.001, 20, w.start, w.end, bpd, sl);
        if (simFtmo(t, 2, 1.0).passed) p++;
      }
      const r = p / winsNo.length;
      console.log(
        `${(sl * 100).toFixed(3).padStart(5)}%  ${(r * 100).toFixed(2).padStart(5)}%   +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // ─── D: Risk sensitivity on winner ───
    console.log("\n── D: Risk sensitivity on winner (non-overlap) ──");
    console.log("risk%   NOV-pass   NOV%    EV($)");
    for (const rf of [0.3, 0.5, 0.7, 0.8, 0.9, 1.0]) {
      let p = 0;
      for (const w of winsNo) {
        const t = runBi(c, 2, 0.015, 0.001, 20, w.start, w.end, bpd);
        if (simFtmo(t, 2, rf).passed) p++;
      }
      const r = p / winsNo.length;
      console.log(
        `${(rf * 100).toFixed(0).padStart(3)}%   ${p}/${winsNo.length}    ${(r * 100).toFixed(2).padStart(5)}%   +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    expect(true).toBe(true);
  });
});
