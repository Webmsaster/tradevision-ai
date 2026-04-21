/**
 * Iter 198 — Reduce total-loss fails (the real lever to 60%).
 *
 * iter197 status: 50.72% pass, with 30/69 fails by TOTAL-LOSS (not timeout).
 * If we halve total-losses, pass rate jumps to ~72%.
 *
 * Three mechanisms tested modularly so we see which ones actually move the
 * needle:
 *   A) Circuit breaker: after 3 consecutive losses OR equity < 1-X → pause N days
 *   B) Volatility-regime filter: skip trades when ATR outside sweet-spot
 *   C) Correlation filter: if all 3 assets fire same direction, only take 1
 *   D) Equity-adaptive: halve risk after drawdown
 *   E) Combined best-of
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

interface Trade {
  symbol: string;
  direction: "long" | "short";
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
  barIdx: number; // index into candle array for entry
  atrAtEntry: number;
}

function atrSeries(c: Candle[], len: number): number[] {
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    const h = c[i].high,
      l = c[i].low,
      pc = c[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const out = new Array(c.length).fill(NaN);
  let s = 0;
  for (let i = 1; i < c.length; i++) {
    s += tr[i];
    if (i > len) s -= tr[i - len];
    if (i >= len) out[i] = s / len / c[i].close; // normalized ATR
  }
  return out;
}

function run(
  c: Candle[],
  symbol: string,
  tp: number,
  stop: number,
  hold: number,
  wS: number,
  wE: number,
  costBp: number,
  triggerBars: number,
  atr: number[],
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
          symbol,
          direction: dir,
          rawPnl: pnl,
          day,
          entryTime: eb.openTime,
          exitTime: c[xb].closeTime,
          barIdx: i,
          atrAtEntry: atr[i] ?? 0,
        });
      cd = xb + 1;
    }
  }
  return out;
}

interface SimOpts {
  circuitBreaker?: {
    lossStreak: number;
    ddThreshold: number;
    pauseDays: number;
  };
  volRegime?: { minAtr: number; maxAtr: number };
  correlationLimit?: number; // if >N trades same direction same day, cap to N
  ddRiskHalve?: number; // halve risk if equity-peak drawdown > X
  timeBoost?: { afterDay: number; equityBelow: number; riskPct: number };
}

function sim(
  trades: Trade[],
  leverage: number,
  baseCompound: boolean,
  opts: SimOpts,
) {
  let eq = 1;
  let peak = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  let passDay = -1;
  let streak = 0;
  let pauseUntilDay = -1;

  const sorted = trades
    .slice()
    .sort((a, b) => a.day - b.day || a.entryTime - b.entryTime);

  // Correlation filter: pre-compute which trades to drop
  const dayDirCount = new Map<string, number>();
  const dropSet = new Set<number>();
  if (opts.correlationLimit !== undefined) {
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const key = `${t.day}-${t.direction}`;
      const n = (dayDirCount.get(key) ?? 0) + 1;
      dayDirCount.set(key, n);
      if (n > opts.correlationLimit) dropSet.add(i);
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (t.day >= 30) break;
    if (dropSet.has(i)) continue;
    if (pauseUntilDay > t.day) continue;

    // Vola regime filter
    if (
      opts.volRegime &&
      (t.atrAtEntry < opts.volRegime.minAtr ||
        t.atrAtEntry > opts.volRegime.maxAtr)
    ) {
      continue;
    }

    if (!ds.has(t.day)) ds.set(t.day, eq);

    // Sizing
    let risk = 0.3;
    if (baseCompound) {
      if (eq >= 1.08) risk = 0.15;
      else if (eq >= 1.03) risk = 0.45;
      else risk = 0.3;
    }
    // time boost
    if (
      opts.timeBoost &&
      t.day >= opts.timeBoost.afterDay &&
      eq < 1 + opts.timeBoost.equityBelow &&
      eq < 1.08
    ) {
      risk = opts.timeBoost.riskPct;
    }
    // Drawdown-adaptive risk halving
    if (opts.ddRiskHalve !== undefined) {
      const dd = (eq - peak) / peak;
      if (dd < -opts.ddRiskHalve) risk *= 0.5;
    }
    if (risk <= 0) continue;

    const pnlF = Math.max(t.rawPnl * leverage * risk, -risk);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq > peak) peak = eq;

    if (pnlF < 0) streak++;
    else streak = 0;

    // Circuit breaker
    if (opts.circuitBreaker) {
      const dd = (eq - peak) / peak;
      if (
        streak >= opts.circuitBreaker.lossStreak ||
        dd < -opts.circuitBreaker.ddThreshold
      ) {
        pauseUntilDay = t.day + opts.circuitBreaker.pauseDays;
        streak = 0;
      }
    }

    if (eq <= 0.9)
      return { passed: false, reason: "total" as const, daysToPass: -1 };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05)
      return { passed: false, reason: "daily" as const, daysToPass: -1 };
    if (eq >= 1.1 && td.size >= 4) {
      passDay = t.day + 1;
      break;
    }
  }
  const late = eq >= 1.1 && td.size >= 4;
  return {
    passed: passDay > 0 || late,
    reason: passDay > 0 || late ? ("pass" as const) : ("timeout" as const),
    daysToPass: passDay > 0 ? passDay : late ? 30 : -1,
  };
}

describe("iter 198 — reduce total-loss fails toward 60%", () => {
  it(
    "circuit breaker + vola + correlation",
    { timeout: 1_200_000 },
    async () => {
      console.log("\n=== ITER 198: REDUCE TOTAL-LOSS FAILS ===");
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
      const c4h: Record<string, Candle[]> = {};
      const atr: Record<string, number[]> = {};
      for (const s of symbols) {
        c4h[s] = await loadBinanceHistory({
          symbol: s as "BTCUSDT",
          timeframe: "4h",
          targetCount: 20_000,
          maxPages: 100,
        });
        atr[s] = atrSeries(c4h[s], 14);
      }
      const aligned = Math.min(...symbols.map((s) => c4h[s].length));
      for (const s of symbols) {
        c4h[s] = c4h[s].slice(c4h[s].length - aligned);
        atr[s] = atr[s].slice(atr[s].length - aligned);
      }
      const cost: Record<string, number> = {
        BTCUSDT: 40,
        ETHUSDT: 30,
        SOLUSDT: 40,
      };
      const winBars = 30 * 6;
      const wNO: { start: number; end: number }[] = [];
      for (let s = 0; s + winBars < aligned; s += winBars)
        wNO.push({ start: s, end: s + winBars });
      console.log(`${wNO.length} non-overlap windows\n`);

      function batch(opts: SimOpts, label: string) {
        let passed = 0;
        const rc = { pass: 0, timeout: 0, total: 0, daily: 0 };
        for (const w of wNO) {
          const all: Trade[] = [];
          for (const s of symbols) {
            all.push(
              ...run(
                c4h[s],
                s,
                0.08,
                0.005,
                3,
                w.start,
                w.end,
                cost[s],
                2,
                atr[s],
              ),
            );
          }
          const r = sim(all, 2, true, opts);
          rc[r.reason]++;
          if (r.passed) passed++;
        }
        const rate = passed / wNO.length;
        console.log(
          `${label.padEnd(50)} ${(rate * 100).toFixed(2).padStart(5)}%  timeout:${rc.timeout}  total:${rc.total}  daily:${rc.daily}  EV +$${(rate * 0.5 * 8000 - 99).toFixed(0)}`,
        );
        return { rate, rc };
      }

      console.log(
        "variant                                              pass%  fails(t/d)                 EV",
      );
      batch(
        { timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 } },
        "iter197 baseline (timeBoost only)",
      );

      // A) Circuit breakers
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          circuitBreaker: { lossStreak: 3, ddThreshold: 0.99, pauseDays: 2 },
        },
        "CB: 3-loss-streak → 2d pause",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          circuitBreaker: { lossStreak: 3, ddThreshold: 0.99, pauseDays: 3 },
        },
        "CB: 3-loss-streak → 3d pause",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          circuitBreaker: { lossStreak: 2, ddThreshold: 0.99, pauseDays: 2 },
        },
        "CB: 2-loss-streak → 2d pause",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          circuitBreaker: { lossStreak: 99, ddThreshold: 0.03, pauseDays: 3 },
        },
        "CB: dd-3% → 3d pause",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          circuitBreaker: { lossStreak: 99, ddThreshold: 0.05, pauseDays: 3 },
        },
        "CB: dd-5% → 3d pause",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          circuitBreaker: { lossStreak: 3, ddThreshold: 0.04, pauseDays: 2 },
        },
        "CB: combined 3-streak OR dd-4%",
      );

      // B) Vola regime
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          volRegime: { minAtr: 0.005, maxAtr: 0.05 },
        },
        "Vola 0.5% < ATR14 < 5%",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          volRegime: { minAtr: 0.008, maxAtr: 0.04 },
        },
        "Vola 0.8% < ATR14 < 4%",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          volRegime: { minAtr: 0.01, maxAtr: 0.035 },
        },
        "Vola 1% < ATR14 < 3.5%",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          volRegime: { minAtr: 0.012, maxAtr: 0.03 },
        },
        "Vola 1.2% < ATR14 < 3%",
      );

      // C) Correlation limit
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          correlationLimit: 2,
        },
        "Corr: max 2 same-day-same-dir",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          correlationLimit: 1,
        },
        "Corr: max 1 same-day-same-dir",
      );

      // D) Drawdown risk halving
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          ddRiskHalve: 0.03,
        },
        "DD-halve at -3%",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          ddRiskHalve: 0.05,
        },
        "DD-halve at -5%",
      );

      // E) Combined
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          circuitBreaker: { lossStreak: 3, ddThreshold: 0.04, pauseDays: 2 },
          ddRiskHalve: 0.03,
        },
        "COMBO 1: CB + DD-halve",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          circuitBreaker: { lossStreak: 3, ddThreshold: 0.04, pauseDays: 2 },
          correlationLimit: 2,
        },
        "COMBO 2: CB + Corr2",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          circuitBreaker: { lossStreak: 3, ddThreshold: 0.04, pauseDays: 2 },
          volRegime: { minAtr: 0.008, maxAtr: 0.04 },
          correlationLimit: 2,
        },
        "COMBO 3: CB + Vola + Corr2",
      );
      batch(
        {
          timeBoost: { afterDay: 15, equityBelow: 0.05, riskPct: 0.55 },
          circuitBreaker: { lossStreak: 3, ddThreshold: 0.04, pauseDays: 2 },
          ddRiskHalve: 0.03,
          correlationLimit: 2,
        },
        "COMBO 4: ALL + Corr2",
      );

      expect(true).toBe(true);
    },
  );
});
