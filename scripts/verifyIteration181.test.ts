/**
 * Iter 181 — final honest attempt: wider targets to survive realistic costs.
 *
 * iter180 showed: at 15-35 bp realistic spread+slippage, ALL previous
 * strategies fail (0% pass). Edge gets wiped out by execution costs.
 *
 * Honest fix: move TP/Stop FAR ABOVE the cost floor.
 *   • Cost 15-35 bp means raw mean needs > 15-35 bp per trade to break even
 *   • tp=3%, stop=0.5% → ratio 6:1, but costs are only 0.15% relative
 *   • Longer hold (24-72 bars = 6-18h) amortizes cost over bigger move
 *   • Fewer trades → fewer cost hits
 *
 * Also test:
 *   • Daily timeframe (fewer signals, bigger TP, cost negligible)
 *   • Flash-crash re-validation (iter156) with realistic costs — it used 2%
 *     raw mean, so 15 bp cost is neglibible
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

function runBiRealistic(
  c: Candle[],
  triggerBars: number,
  tp: number,
  stop: number,
  hold: number,
  wS: number,
  wE: number,
  bpd: number,
  costBp: number,
): Trade[] {
  const out: Trade[] = [];
  if (!c[wS]) return out;
  const ts0 = c[wS].openTime;
  const costFrac = costBp / 10000;

  // LONG
  let cd = -1;
  for (let i = Math.max(triggerBars + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let ok = true;
    for (let k = 0; k < triggerBars; k++)
      if (c[i - k].close >= c[i - k - 1].close) {
        ok = false;
        break;
      }
    if (!ok) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const entryEff = entry * (1 + costFrac / 2);
    const tpPx = entry * (1 + tp);
    const stPx = entry * (1 - stop);
    const mx = Math.min(i + 1 + hold, wE - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      if (c[j].low <= stPx) {
        xb = j;
        xp = stPx;
        break;
      }
      if (c[j].high >= tpPx) {
        xb = j;
        xp = tpPx;
        break;
      }
    }
    const exitEff = xp * (1 - costFrac / 2);
    const pnl = (exitEff - entryEff) / entryEff;
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
  // SHORT
  cd = -1;
  for (let i = Math.max(triggerBars + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let ok = true;
    for (let k = 0; k < triggerBars; k++)
      if (c[i - k].close <= c[i - k - 1].close) {
        ok = false;
        break;
      }
    if (!ok) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const entryEff = entry * (1 - costFrac / 2);
    const tpPx = entry * (1 - tp);
    const stPx = entry * (1 + stop);
    const mx = Math.min(i + 1 + hold, wE - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      if (c[j].high >= stPx) {
        xb = j;
        xp = stPx;
        break;
      }
      if (c[j].low <= tpPx) {
        xb = j;
        xp = tpPx;
        break;
      }
    }
    const exitEff = xp * (1 + costFrac / 2);
    const pnl = (entryEff - exitEff) / entryEff;
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

describe("iter 181 — wider targets survive live costs", () => {
  it(
    "find tp/stop/hold that survives 15-30bp realistic cost",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 181: WIDE TARGETS ===");
      const c = await loadBinanceHistory({
        symbol: "ETHUSDT", // ETH was best
        timeframe: "15m",
        targetCount: 100_000,
        maxPages: 200,
      });
      const bpd = 96;
      const winLen = 30 * bpd;
      const winsNO: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < c.length; s += winLen)
        winsNO.push({ start: s, end: s + winLen });
      const winsOV: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < c.length; s += 7 * bpd)
        winsOV.push({ start: s, end: s + winLen });
      const cut = Math.floor(winsOV.length * 0.6);
      const oosOV = winsOV.slice(cut);
      console.log(`ETH 15m: ${winsNO.length} NOV, ${oosOV.length} OOS-OV\n`);

      // Test wide-target variants on ETH 15m
      console.log("── Wide TP + wider stop (survive 18bp ETH cost) ──");
      console.log(
        "tp%    stop%   hold   trigBars  risk%   NOV%   OOS%   EV-OOS($)",
      );
      for (const tp of [0.02, 0.03, 0.05]) {
        for (const stop of [0.005, 0.01, 0.015]) {
          for (const hold of [24, 48, 96]) {
            for (const trig of [2, 3, 4]) {
              for (const rf of [0.3, 0.5, 1.0]) {
                let pN = 0,
                  pO = 0;
                for (const w of winsNO) {
                  const t = runBiRealistic(
                    c,
                    trig,
                    tp,
                    stop,
                    hold,
                    w.start,
                    w.end,
                    bpd,
                    18,
                  );
                  if (simFtmo(t, 2, rf).passed) pN++;
                }
                for (const w of oosOV) {
                  const t = runBiRealistic(
                    c,
                    trig,
                    tp,
                    stop,
                    hold,
                    w.start,
                    w.end,
                    bpd,
                    18,
                  );
                  if (simFtmo(t, 2, rf).passed) pO++;
                }
                const rN = pN / winsNO.length;
                const rO = pO / oosOV.length;
                if (rN >= 0.3 && rO >= 0.3) {
                  console.log(
                    `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${hold.toString().padStart(3)}    ${trig}       ${(rf * 100).toFixed(0).padStart(3)}%   ${(rN * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
                  );
                }
              }
            }
          }
        }
      }

      // Daily timeframe test
      console.log("\n── Daily timeframe (fewer trades, bigger moves) ──");
      const cDaily = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "1d",
        targetCount: 3000,
        maxPages: 50,
      });
      const bpdD = 1;
      const winLenD = 30;
      const winsD: { start: number; end: number }[] = [];
      for (let s = 0; s + winLenD < cDaily.length; s += winLenD)
        winsD.push({ start: s, end: s + winLenD });
      console.log(
        `  ETH 1d: ${cDaily.length} candles, ${winsD.length} 30d windows`,
      );
      for (const tp of [0.05, 0.08, 0.12]) {
        for (const stop of [0.02, 0.03, 0.05]) {
          for (const hold of [5, 10, 20]) {
            let p = 0;
            let trades = 0;
            for (const w of winsD) {
              const t = runBiRealistic(
                cDaily,
                2,
                tp,
                stop,
                hold,
                w.start,
                w.end,
                bpdD,
                18,
              );
              trades += t.length;
              if (simFtmo(t, 2, 1.0).passed) p++;
            }
            const r = p / winsD.length;
            if (r >= 0.2) {
              console.log(
                `  tp ${(tp * 100).toFixed(0)}%  s ${(stop * 100).toFixed(0)}%  h ${hold}d  ${p}/${winsD.length} (${(r * 100).toFixed(2)}%)  avgTrades ${(trades / winsD.length).toFixed(1)}/30d`,
              );
            }
          }
        }
      }

      // Summary
      console.log(
        "\n★ HONEST ASSESSMENT ★\n" +
          "If no config above reaches 50%+ pass rate WITH realistic costs,\n" +
          "then daytrade-based FTMO on crypto is structurally unprofitable\n" +
          "in live conditions. User should either:\n" +
          "  a) Use FTMO Forex plan (1:100 leverage, tighter spreads)\n" +
          "  b) Skip FTMO, use Binance with own capital\n" +
          "  c) Accept low pass rate (20-40%) and treat as lottery",
      );
      expect(true).toBe(true);
    },
  );
});
