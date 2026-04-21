/**
 * Iter 189 — Validate iter188 24h-hold winner + Monte-Carlo + ship.
 *
 * Winner: 4h bars, 4-asset, tp 10%, stop 0.5%, hold 4 bars (16h), 3-bar trigger
 *   NOV 46.27%, OOS 44.44%, EV +$1,679
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

describe("iter 189 — validate 4h 24h-hold winner", () => {
  it("MC + ship", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 189: VALIDATE 24H DAYTRADE ===");
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT"];
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
      AVAXUSDT: 45,
    };

    // Monte-Carlo 300 random starts
    console.log("── Monte-Carlo 300 random starts ──");
    const winBars = 30 * 6; // 30 days × 6 bars/day
    let seed = 13579;
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
        name: "tp10 s0.5 h4 trig3 r25%",
        tp: 0.1,
        stop: 0.005,
        hold: 4,
        trig: 3,
        risk: 0.25,
      },
      {
        name: "tp10 s0.5 h6 trig3 r25%",
        tp: 0.1,
        stop: 0.005,
        hold: 6,
        trig: 3,
        risk: 0.25,
      },
      {
        name: "tp8 s0.5 h6 trig3 r25%",
        tp: 0.08,
        stop: 0.005,
        hold: 6,
        trig: 3,
        risk: 0.25,
      },
      {
        name: "tp5 s0.5 h6 trig2 r25%",
        tp: 0.05,
        stop: 0.005,
        hold: 6,
        trig: 2,
        risk: 0.25,
      },
      {
        name: "tp10 s0.5 h4 trig3 r33%",
        tp: 0.1,
        stop: 0.005,
        hold: 4,
        trig: 3,
        risk: 0.33,
      },
      {
        name: "tp10 s0.5 h4 trig3 r50%",
        tp: 0.1,
        stop: 0.005,
        hold: 4,
        trig: 3,
        risk: 0.5,
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

    // IS/OOS split
    console.log("\n── IS/OOS split on top candidate ──");
    const wNO: { start: number; end: number }[] = [];
    for (let s = 0; s + winBars < aligned; s += winBars)
      wNO.push({ start: s, end: s + winBars });
    const cut = Math.floor(wNO.length * 0.6);
    const wIS = wNO.slice(0, cut);
    const wOOS = wNO.slice(cut);

    for (const cfg of cands) {
      let pI = 0,
        pO = 0;
      for (const w of wIS) {
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(
            ...run(
              c4h[s],
              cfg.tp,
              cfg.stop,
              cfg.hold,
              w.start,
              w.end,
              cost[s],
              cfg.trig,
            ),
          );
        }
        if (simFtmo(all, 2, cfg.risk).passed) pI++;
      }
      for (const w of wOOS) {
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(
            ...run(
              c4h[s],
              cfg.tp,
              cfg.stop,
              cfg.hold,
              w.start,
              w.end,
              cost[s],
              cfg.trig,
            ),
          );
        }
        if (simFtmo(all, 2, cfg.risk).passed) pO++;
      }
      console.log(
        `  ${cfg.name.padEnd(28)}  IS ${((pI / wIS.length) * 100).toFixed(2)}%  OOS ${((pO / wOOS.length) * 100).toFixed(2)}%`,
      );
    }

    expect(true).toBe(true);
  });
});
