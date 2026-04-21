/**
 * Iter 190 — 3-Asset (BTC+ETH+SOL) 24h-hold daytrade.
 *
 * User: "btc und eth und sol mehr trade ich nicht"
 *
 * Drop AVAX from iter189 config, re-optimize risk allocation for 3 assets.
 * Keep 4h bars, 3-bar trigger, TP 10% / Stop 0.5% / Hold 4 bars.
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

function simFtmo(trades: Trade[], leverage: number, risk: number) {
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
    if (eq <= 0.9) return { passed: false };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) return { passed: false };
    if (eq >= 1.1 && td.size >= 4) return { passed: true };
  }
  return { passed: eq >= 1.1 && td.size >= 4 };
}

describe("iter 190 — BTC+ETH+SOL 24h daytrade", () => {
  it("3-asset optimization", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 190: 3-ASSET 24H ===");
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
    console.log(
      `4h aligned ${aligned} bars (~${(aligned / 6).toFixed(0)} days)\n`,
    );

    const cost: Record<string, number> = {
      BTCUSDT: 40,
      ETHUSDT: 30,
      SOLUSDT: 40,
    };
    const winBars = 30 * 6;

    // NOV windows
    const wNO: { start: number; end: number }[] = [];
    for (let s = 0; s + winBars < aligned; s += winBars)
      wNO.push({ start: s, end: s + winBars });
    const cut = Math.floor(wNO.length * 0.6);
    const wIS = wNO.slice(0, cut);
    const wOOS = wNO.slice(cut);
    console.log(`${wNO.length} NOV (IS ${wIS.length}, OOS ${wOOS.length})\n`);

    // ─── A: Risk sweep, tp 10%, stop 0.5%, hold 4, trig 3 ───
    console.log("── A: Risk sweep (tp 10% s 0.5% h 4 trig 3) ──");
    console.log("risk%   NOV%    IS%    OOS%   EV-OOS($)");
    for (const rf of [0.25, 0.33, 0.4, 0.45, 0.5, 0.6]) {
      let pN = 0,
        pI = 0,
        pO = 0;
      const runW = (w: { start: number; end: number }) => {
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(...run(c4h[s], 0.1, 0.005, 4, w.start, w.end, cost[s], 3));
        }
        return all;
      };
      for (const w of wNO) if (simFtmo(runW(w), 2, rf).passed) pN++;
      for (const w of wIS) if (simFtmo(runW(w), 2, rf).passed) pI++;
      for (const w of wOOS) if (simFtmo(runW(w), 2, rf).passed) pO++;
      const rO = pO / wOOS.length;
      console.log(
        `${(rf * 100).toFixed(0).padStart(3)}%   ${((pN / wNO.length) * 100).toFixed(2).padStart(5)}%  ${((pI / wIS.length) * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    // ─── B: TP/hold variations at best risk ───
    console.log("\n── B: TP/hold/trigger sweep @ best risk 40% ──");
    console.log("tp%    stop%   hold   trig   NOV%    OOS%   EV($)");
    for (const tp of [0.05, 0.08, 0.1, 0.12]) {
      for (const stop of [0.005, 0.01]) {
        for (const hold of [3, 4, 5, 6]) {
          for (const trig of [2, 3]) {
            let pN = 0,
              pO = 0;
            const runW = (w: { start: number; end: number }) => {
              const all: Trade[] = [];
              for (const s of symbols) {
                all.push(
                  ...run(c4h[s], tp, stop, hold, w.start, w.end, cost[s], trig),
                );
              }
              return all;
            };
            for (const w of wNO) if (simFtmo(runW(w), 2, 0.4).passed) pN++;
            for (const w of wOOS) if (simFtmo(runW(w), 2, 0.4).passed) pO++;
            const rN = pN / wNO.length;
            if (rN >= 0.4) {
              console.log(
                `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${hold.toString().padStart(2)}    ${trig}     ${(rN * 100).toFixed(2).padStart(5)}%  ${((pO / wOOS.length) * 100).toFixed(2).padStart(5)}%   +$${((pO / wOOS.length) * 0.5 * 8000 - 99).toFixed(0)}`,
              );
            }
          }
        }
      }
    }

    // ─── C: Monte-Carlo 300 starts on top candidates ───
    console.log("\n── C: Monte-Carlo 300 starts ──");
    let seed = 24680;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    interface Cand {
      name: string;
      tp: number;
      stop: number;
      hold: number;
      trig: number;
      risk: number;
    }
    const cands: Cand[] = [
      {
        name: "tp10 s0.5 h4 trig3 r33%",
        tp: 0.1,
        stop: 0.005,
        hold: 4,
        trig: 3,
        risk: 0.33,
      },
      {
        name: "tp10 s0.5 h4 trig3 r40%",
        tp: 0.1,
        stop: 0.005,
        hold: 4,
        trig: 3,
        risk: 0.4,
      },
      {
        name: "tp10 s0.5 h4 trig3 r45%",
        tp: 0.1,
        stop: 0.005,
        hold: 4,
        trig: 3,
        risk: 0.45,
      },
      {
        name: "tp10 s0.5 h6 trig3 r40%",
        tp: 0.1,
        stop: 0.005,
        hold: 6,
        trig: 3,
        risk: 0.4,
      },
      {
        name: "tp8 s0.5 h6 trig3 r40%",
        tp: 0.08,
        stop: 0.005,
        hold: 6,
        trig: 3,
        risk: 0.4,
      },
    ];
    for (const cfg of cands) {
      let p = 0;
      for (let i = 0; i < 300; i++) {
        const start = Math.floor(rng() * (aligned - winBars));
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(
            ...run(
              c4h[s],
              cfg.tp,
              cfg.stop,
              cfg.hold,
              start,
              start + winBars,
              cost[s],
              cfg.trig,
            ),
          );
        }
        if (simFtmo(all, 2, cfg.risk).passed) p++;
      }
      const r = p / 300;
      console.log(
        `  ${cfg.name.padEnd(28)}  ${p}/300 (${(r * 100).toFixed(2)}%)  EV +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
      );
    }

    expect(true).toBe(true);
  });
});
