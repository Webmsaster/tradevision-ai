/**
 * Iter 183 — validate iter182 winners + ship best crypto-only realistic config.
 *
 * iter182 top candidates (40bp BTC / 30bp ETH realistic costs):
 *   A) BTC+ETH 1d combined: tp 15%B / 8%E, stop 2%, hold 10-20d → 52.53% NOV
 *   B) ETH 4h: tp 8%, stop 0.5%, hold 6 → 50.48% NOV
 *
 * IS/OOS split validation + Monte-Carlo.
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
      let xb = mx;
      let xp = c[mx].close;
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

describe("iter 183 — validate crypto realistic winner", () => {
  it("IS/OOS + Monte Carlo on BTC+ETH 1d", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 183: VALIDATE + SHIP ===");
    const cbtc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1d",
      targetCount: 3000,
      maxPages: 50,
    });
    const ceth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "1d",
      targetCount: 3000,
      maxPages: 50,
    });
    const ceth4h = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 20_000,
      maxPages: 100,
    });
    // Align BTC/ETH to same length
    const aligned = Math.min(cbtc.length, ceth.length);
    console.log(
      `BTC 1d ${cbtc.length}, ETH 1d ${ceth.length}, aligned ${aligned}, ETH 4h ${ceth4h.length}`,
    );

    const winBars = 30;
    const winsNO: { start: number; end: number }[] = [];
    for (let s = 0; s + winBars < aligned; s += winBars)
      winsNO.push({ start: s, end: s + winBars });
    const cut = Math.floor(winsNO.length * 0.6);
    const winsIS = winsNO.slice(0, cut);
    const winsOOS = winsNO.slice(cut);
    console.log(
      `${winsNO.length} NOV windows: IS ${winsIS.length}, OOS ${winsOOS.length}\n`,
    );

    // ─── A: Combined BTC+ETH 1d ───
    console.log("── A: BTC+ETH 1d combined (IS/OOS split) ──");
    console.log("tpBTC%   tpETH%   stop%   hold   IS%    OOS%   EV-OOS($)");
    for (const tpB of [0.08, 0.12, 0.15]) {
      for (const tpE of [0.08, 0.12]) {
        for (const stop of [0.02, 0.03]) {
          for (const hold of [10, 20]) {
            let pI = 0,
              pO = 0;
            for (const w of winsIS) {
              const tB = run(cbtc, 2, tpB, stop, hold, w.start, w.end, 1, 40);
              const tE = run(ceth, 2, tpE, stop, hold, w.start, w.end, 1, 30);
              if (simFtmo([...tB, ...tE], 2, 0.5).passed) pI++;
            }
            for (const w of winsOOS) {
              const tB = run(cbtc, 2, tpB, stop, hold, w.start, w.end, 1, 40);
              const tE = run(ceth, 2, tpE, stop, hold, w.start, w.end, 1, 30);
              if (simFtmo([...tB, ...tE], 2, 0.5).passed) pO++;
            }
            const rI = pI / winsIS.length;
            const rO = pO / winsOOS.length;
            console.log(
              `${(tpB * 100).toFixed(1).padStart(4)}%   ${(tpE * 100).toFixed(1).padStart(4)}%   ${(stop * 100).toFixed(0).padStart(2)}%    ${hold.toString().padStart(2)}    ${(rI * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
            );
          }
        }
      }
    }

    // ─── B: Monte Carlo on best config ───
    console.log("\n── B: Monte-Carlo 200 random starts (winner config) ──");
    let seed = 7777;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const winnerTpB = 0.15;
    const winnerTpE = 0.08;
    const winnerStop = 0.02;
    const winnerHold = 20;
    let pMC = 0;
    for (let i = 0; i < 200; i++) {
      const start = Math.floor(rng() * (aligned - winBars));
      const tB = run(
        cbtc,
        2,
        winnerTpB,
        winnerStop,
        winnerHold,
        start,
        start + winBars,
        1,
        40,
      );
      const tE = run(
        ceth,
        2,
        winnerTpE,
        winnerStop,
        winnerHold,
        start,
        start + winBars,
        1,
        30,
      );
      if (simFtmo([...tB, ...tE], 2, 0.5).passed) pMC++;
    }
    const rMC = pMC / 200;
    console.log(
      `  Winner (tp15/8 stop2% h20): ${pMC}/200 (${(rMC * 100).toFixed(2)}%)  EV +$${(rMC * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    // ─── C: ETH 4h separate validation ───
    console.log("\n── C: ETH 4h standalone IS/OOS (tp 8% / s 0.5% / h 6) ──");
    const win4h = 30 * 6;
    const wins4hNO: { start: number; end: number }[] = [];
    for (let s = 0; s + win4h < ceth4h.length; s += win4h)
      wins4hNO.push({ start: s, end: s + win4h });
    const cut4h = Math.floor(wins4hNO.length * 0.6);
    const wIS = wins4hNO.slice(0, cut4h);
    const wOO = wins4hNO.slice(cut4h);
    let pI4 = 0,
      pO4 = 0;
    for (const w of wIS) {
      const t = run(ceth4h, 2, 0.08, 0.005, 6, w.start, w.end, 6, 30);
      if (simFtmo(t, 2, 1.0).passed) pI4++;
    }
    for (const w of wOO) {
      const t = run(ceth4h, 2, 0.08, 0.005, 6, w.start, w.end, 6, 30);
      if (simFtmo(t, 2, 1.0).passed) pO4++;
    }
    console.log(
      `  IS ${pI4}/${wIS.length} (${((pI4 / wIS.length) * 100).toFixed(2)}%)  OOS ${pO4}/${wOO.length} (${((pO4 / wOO.length) * 100).toFixed(2)}%)  EV-OOS +$${((pO4 / wOO.length) * 0.5 * 8000 - 99).toFixed(0)}`,
    );

    expect(true).toBe(true);
  });
});
