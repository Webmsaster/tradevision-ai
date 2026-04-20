/**
 * Iter 182 — crypto-only max push with TRUE realistic costs (40 bp BTC / 30 bp ETH).
 *
 * Web research confirmed: FTMO BTC spread is ~400 pips = 40 bp, not 15 bp.
 * iter180/181 used too-optimistic cost. This iter re-tests with:
 *   • BTC 40 bp round-trip cost (matches forum reports)
 *   • ETH 30 bp round-trip cost
 *   • Large TPs (5-20%) to dwarf the 40 bp cost
 *   • Volatility-regime filter (ATR-based)
 *   • Trailing stop after partial profit
 *   • Multi-timeframe confluence (1d trend + 4h entry)
 *
 * Goal: find Crypto-only config with ≥ 40% NOV pass rate at REALISTIC costs.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

interface Trade {
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
  dir: "long" | "short";
}

function atrSeries(c: Candle[], len: number): number[] {
  const out = new Array(c.length).fill(NaN);
  if (c.length < len + 1) return out;
  let sum = 0;
  for (let i = 1; i <= len; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    sum += tr;
  }
  out[len] = sum / len;
  for (let i = len + 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    out[i] = (out[i - 1] * (len - 1) + tr) / len;
  }
  return out;
}

interface RunParams {
  tp: number;
  stop: number;
  hold: number;
  triggerBars: number;
  costBp: number;
  useTrail?: boolean; // trail stop to breakeven after +TP/2 reached
  atrMinRel?: number; // skip trade if ATR/price below this
  atrMaxRel?: number; // skip trade if ATR/price above this
}

function run(
  c: Candle[],
  p: RunParams,
  wS: number,
  wE: number,
  bpd: number,
  atr?: number[],
): Trade[] {
  const out: Trade[] = [];
  if (!c[wS]) return out;
  const ts0 = c[wS].openTime;
  const costFrac = p.costBp / 10000;

  for (const dir of ["long", "short"] as const) {
    let cd = -1;
    for (let i = Math.max(p.triggerBars + 1, wS); i < wE - 1; i++) {
      if (i < cd) continue;

      // Trigger check
      let ok = true;
      for (let k = 0; k < p.triggerBars; k++) {
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

      // ATR filter
      if (atr && !isNaN(atr[i])) {
        const rel = atr[i] / c[i].close;
        if (p.atrMinRel !== undefined && rel < p.atrMinRel) continue;
        if (p.atrMaxRel !== undefined && rel > p.atrMaxRel) continue;
      }

      const eb = c[i + 1];
      if (!eb) break;
      const entry = eb.open;
      const entryEff =
        dir === "long"
          ? entry * (1 + costFrac / 2)
          : entry * (1 - costFrac / 2);
      const tpPx = dir === "long" ? entry * (1 + p.tp) : entry * (1 - p.tp);
      const stPx = dir === "long" ? entry * (1 - p.stop) : entry * (1 + p.stop);
      const halfwayPx =
        dir === "long" ? entry * (1 + p.tp / 2) : entry * (1 - p.tp / 2);

      const mx = Math.min(i + 1 + p.hold, wE - 1);
      let xb = mx;
      let xp = c[mx].close;
      let trailStop = stPx;
      let halfwayHit = false;

      for (let j = i + 2; j <= mx; j++) {
        const bar = c[j];
        if (dir === "long") {
          // Check halfway hit → move stop to breakeven (entry) if trailing
          if (p.useTrail && !halfwayHit && bar.high >= halfwayPx) {
            halfwayHit = true;
            trailStop = Math.max(trailStop, entry); // move to BE
          }
          if (bar.low <= trailStop) {
            xb = j;
            xp = trailStop;
            break;
          }
          if (bar.high >= tpPx) {
            xb = j;
            xp = tpPx;
            break;
          }
        } else {
          if (p.useTrail && !halfwayHit && bar.low <= halfwayPx) {
            halfwayHit = true;
            trailStop = Math.min(trailStop, entry);
          }
          if (bar.high >= trailStop) {
            xb = j;
            xp = trailStop;
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
        dir === "long" ? xp * (1 - costFrac / 2) : xp * (1 + costFrac / 2);
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
          dir,
        });
      cd = xb + 1;
    }
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
    if (eq <= 0.9) return { passed: false };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) return { passed: false };
    if (eq >= 1.1 && td.size >= 4) return { passed: true };
  }
  return { passed: eq >= 1.1 && td.size >= 4 };
}

describe("iter 182 — crypto-only max with 40bp cost", () => {
  it("find best config at realistic 40bp", { timeout: 1_200_000 }, async () => {
    console.log("\n=== ITER 182: CRYPTO-ONLY 40bp ===");
    const cbtc1d = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1d",
      targetCount: 3000,
      maxPages: 50,
    });
    const ceth1d = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "1d",
      targetCount: 3000,
      maxPages: 50,
    });
    const cbtc4h = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: 20_000,
      maxPages: 100,
    });
    const ceth4h = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 20_000,
      maxPages: 100,
    });
    console.log(`BTC 1d: ${cbtc1d.length}, ETH 1d: ${ceth1d.length}`);
    console.log(`BTC 4h: ${cbtc4h.length}, ETH 4h: ${ceth4h.length}`);

    function mkWinsNO(len: number, winBars: number) {
      const ws: { start: number; end: number }[] = [];
      for (let s = 0; s + winBars < len; s += winBars)
        ws.push({ start: s, end: s + winBars });
      return ws;
    }

    const winsBtcDay = mkWinsNO(cbtc1d.length, 30);
    const winsEthDay = mkWinsNO(ceth1d.length, 30);
    const winsBtc4h = mkWinsNO(cbtc4h.length, 30 * 6); // 30 days × 6 bars/day
    const winsEth4h = mkWinsNO(ceth4h.length, 30 * 6);

    const atrBtc1d = atrSeries(cbtc1d, 14);
    const atrEth1d = atrSeries(ceth1d, 14);
    const atrBtc4h = atrSeries(cbtc4h, 14);
    const atrEth4h = atrSeries(ceth4h, 14);

    // ─── A: ETH 1d big TP sweep at 40bp (should survive) ───
    console.log("\n── A: ETH 1d big TP (30 bp ETH realistic cost) ──");
    console.log("tp%   stop%   hold   trail  atr   NOV pass  rate%   EV($)");
    for (const tp of [0.05, 0.08, 0.12, 0.15, 0.2]) {
      for (const stop of [0.02, 0.03, 0.05]) {
        for (const hold of [5, 10, 20, 30]) {
          for (const trail of [false, true]) {
            let p = 0;
            for (const w of winsEthDay) {
              const t = run(
                ceth1d,
                {
                  tp,
                  stop,
                  hold,
                  triggerBars: 2,
                  costBp: 30,
                  useTrail: trail,
                },
                w.start,
                w.end,
                1,
              );
              if (simFtmo(t, 2, 1.0).passed) p++;
            }
            const r = p / winsEthDay.length;
            if (r >= 0.35) {
              console.log(
                `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(1).padStart(3)}%   ${hold.toString().padStart(2)}    ${trail ? "Y" : "N"}     —    ${p}/${winsEthDay.length}   ${(r * 100).toFixed(2).padStart(5)}%   +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
              );
            }
          }
        }
      }
    }

    // ─── B: ETH 1d with ATR volatility regime filter ───
    console.log("\n── B: ETH 1d with ATR filter ──");
    console.log("tp%   stop%   atrMin%  atrMax%  NOV%   EV($)");
    for (const tp of [0.08, 0.12, 0.15]) {
      for (const stop of [0.02, 0.03]) {
        for (const atrMin of [0, 0.02, 0.03, 0.04]) {
          for (const atrMax of [0.05, 0.08, 0.15, 1.0]) {
            if (atrMax <= atrMin) continue;
            let p = 0;
            for (const w of winsEthDay) {
              const t = run(
                ceth1d,
                {
                  tp,
                  stop,
                  hold: 10,
                  triggerBars: 2,
                  costBp: 30,
                  atrMinRel: atrMin,
                  atrMaxRel: atrMax,
                },
                w.start,
                w.end,
                1,
                atrEth1d,
              );
              if (simFtmo(t, 2, 1.0).passed) p++;
            }
            const r = p / winsEthDay.length;
            if (r >= 0.45) {
              console.log(
                `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(1).padStart(3)}%   ${(atrMin * 100).toFixed(1).padStart(4)}%    ${(atrMax * 100).toFixed(1).padStart(4)}%    ${(r * 100).toFixed(2).padStart(5)}%  +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
              );
            }
          }
        }
      }
    }

    // ─── C: BTC + ETH 1d combined @ 50% risk each ───
    console.log("\n── C: BTC+ETH 1d combined (40bp BTC, 30bp ETH) ──");
    console.log("tpBTC%   tpETH%   stop%   hold   NOV%   EV($)");
    const alignedDays = Math.min(cbtc1d.length, ceth1d.length);
    const winsPair = mkWinsNO(alignedDays, 30);
    for (const tpB of [0.08, 0.12, 0.15]) {
      for (const tpE of [0.05, 0.08, 0.12]) {
        for (const stop of [0.02, 0.03]) {
          for (const hold of [10, 20]) {
            let p = 0;
            for (const w of winsPair) {
              const tB = run(
                cbtc1d,
                {
                  tp: tpB,
                  stop,
                  hold,
                  triggerBars: 2,
                  costBp: 40,
                },
                w.start,
                w.end,
                1,
              );
              const tE = run(
                ceth1d,
                {
                  tp: tpE,
                  stop,
                  hold,
                  triggerBars: 2,
                  costBp: 30,
                },
                w.start,
                w.end,
                1,
              );
              // each at 50% risk; combined list
              const combined = [...tB, ...tE].map((t) => ({
                ...t,
                rawPnl: t.rawPnl,
              }));
              if (simFtmo(combined, 2, 0.5).passed) p++;
            }
            const r = p / winsPair.length;
            if (r >= 0.45) {
              console.log(
                `${(tpB * 100).toFixed(1).padStart(4)}%   ${(tpE * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(1).padStart(3)}%   ${hold.toString().padStart(2)}    ${(r * 100).toFixed(2).padStart(5)}%   +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
              );
            }
          }
        }
      }
    }

    // ─── D: ETH 4h (middle ground) with big TPs ───
    console.log("\n── D: ETH 4h with 30 bp realistic cost ──");
    console.log("tp%   stop%   hold(4h)   NOV%   EV($)");
    for (const tp of [0.02, 0.03, 0.05, 0.08]) {
      for (const stop of [0.005, 0.01, 0.015]) {
        for (const hold of [6, 12, 24, 48]) {
          let p = 0;
          for (const w of winsEth4h) {
            const t = run(
              ceth4h,
              {
                tp,
                stop,
                hold,
                triggerBars: 2,
                costBp: 30,
              },
              w.start,
              w.end,
              6,
            );
            if (simFtmo(t, 2, 1.0).passed) p++;
          }
          const r = p / winsEth4h.length;
          if (r >= 0.4) {
            console.log(
              `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(1).padStart(3)}%   ${hold.toString().padStart(3)}        ${(r * 100).toFixed(2).padStart(5)}%   +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
            );
          }
        }
      }
    }

    expect(true).toBe(true);
  });
});
