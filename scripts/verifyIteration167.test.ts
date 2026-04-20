/**
 * Iter 167 — TRUE DAYTRADE for FTMO (2-5 trades/day, not flash-crash waits).
 *
 * User: "ich will daytrade" — the Hybrid strategy waits for rare flash-crashes
 * (~5/year). User wants real daily activity with multiple trades per day.
 *
 * Math check for FTMO $100k @ 1:2 lev, 10% target / 30 days:
 *   • Need +0.33% equity/day average
 *   • With 3 trades/day: +0.11%/trade effective
 *   • At 2× lev × 30% risk: need raw mean +0.18% per trade
 *   • At 2× lev × 50% risk: need raw mean +0.11% per trade
 *
 * Historical iter135 raw mean was 0.035% — 3-5× too low. Need better entries.
 *
 * This iter scans 15m BTC bars for:
 *   - Higher-mean triggers (breakouts, pullbacks, MACD signals)
 *   - Asymmetric TP > Stop (to push mean up)
 *   - Freq ≥ 2/day
 *   - Raw mean ≥ 0.10% (achievable threshold at 50% risk × 2× lev)
 *
 * Then simulates FTMO challenge over 294 rolling 30-day windows at various
 * risk levels to find the best REAL daytrade config.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";

function rsiSeries(closes: number[], len: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= len) return out;
  let g = 0,
    l = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l += -d;
  }
  g /= len;
  l /= len;
  out[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gi = d > 0 ? d : 0;
    const li = d < 0 ? -d : 0;
    g = (g * (len - 1) + gi) / len;
    l = (l * (len - 1) + li) / len;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function emaSeries(closes: number[], len: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < len) return out;
  const k = 2 / (len + 1);
  let ema = closes.slice(0, len).reduce((a, b) => a + b, 0) / len;
  out[len - 1] = ema;
  for (let i = len; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

type TriggerKind =
  | "rsi_os" // RSI oversold bounce
  | "rsi_ob_short" // RSI overbought → short
  | "brk_hi" // breakout above N-bar high
  | "brk_lo_short" // breakdown below N-bar low → short
  | "pullback" // trend + RSI pullback
  | "nDown" // N down bars
  | "nUp_short"; // N up bars → short

interface Cfg {
  kind: TriggerKind;
  param1: number; // RSI len / lookback
  param2: number; // threshold / extra param
  tp: number;
  stop: number;
  hold: number; // bars
  direction: "long" | "short";
}

function fires(
  c: Candle[],
  closes: number[],
  rsi: number[],
  ema50: number[],
  i: number,
  cfg: Cfg,
): boolean {
  switch (cfg.kind) {
    case "rsi_os":
      return rsi[i] <= cfg.param2;
    case "rsi_ob_short":
      return rsi[i] >= cfg.param2;
    case "brk_hi": {
      if (i < cfg.param1) return false;
      let hi = -Infinity;
      for (let k = i - cfg.param1; k < i; k++)
        if (c[k].high > hi) hi = c[k].high;
      return c[i].close > hi;
    }
    case "brk_lo_short": {
      if (i < cfg.param1) return false;
      let lo = Infinity;
      for (let k = i - cfg.param1; k < i; k++) if (c[k].low < lo) lo = c[k].low;
      return c[i].close < lo;
    }
    case "pullback": {
      // Trend long: ema50 rising, RSI dipped below threshold then back up
      if (isNaN(ema50[i]) || isNaN(ema50[i - 5])) return false;
      if (ema50[i] <= ema50[i - 5]) return false; // trend up
      return rsi[i - 1] < cfg.param2 && rsi[i] >= cfg.param2;
    }
    case "nDown": {
      if (i < cfg.param1 + 1) return false;
      for (let k = 0; k < cfg.param1; k++) {
        if (closes[i - k] >= closes[i - k - 1]) return false;
      }
      return true;
    }
    case "nUp_short": {
      if (i < cfg.param1 + 1) return false;
      for (let k = 0; k < cfg.param1; k++) {
        if (closes[i - k] <= closes[i - k - 1]) return false;
      }
      return true;
    }
  }
}

interface Trade {
  day: number;
  rawPnl: number;
  entryTime: number;
  exitTime: number;
}

function runStrategy(
  c: Candle[],
  cfg: Cfg,
  windowStart: number,
  windowEnd: number,
  ctx: { closes: number[]; rsi: number[]; ema50: number[] },
  barsPerDay: number,
): Trade[] {
  const trades: Trade[] = [];
  let cooldown = -1;
  const startTs = c[windowStart].openTime;
  for (let i = Math.max(50, windowStart); i < windowEnd - 1; i++) {
    if (i < cooldown) continue;
    if (!fires(c, ctx.closes, ctx.rsi, ctx.ema50, i, cfg)) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp =
      cfg.direction === "long" ? entry * (1 + cfg.tp) : entry * (1 - cfg.tp);
    const stop =
      cfg.direction === "long"
        ? entry * (1 - cfg.stop)
        : entry * (1 + cfg.stop);
    const mx = Math.min(i + 1 + cfg.hold, windowEnd - 1);
    let exitBar = mx;
    let exitPrice = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = c[j];
      if (cfg.direction === "long") {
        if (bar.low <= stop) {
          exitBar = j;
          exitPrice = stop;
          break;
        }
        if (bar.high >= tp) {
          exitBar = j;
          exitPrice = tp;
          break;
        }
      } else {
        if (bar.high >= stop) {
          exitBar = j;
          exitPrice = stop;
          break;
        }
        if (bar.low <= tp) {
          exitBar = j;
          exitPrice = tp;
          break;
        }
      }
    }
    const pnl = applyCosts({
      entry,
      exit: exitPrice,
      direction: cfg.direction,
      holdingHours: (exitBar - (i + 1)) / (barsPerDay / 24),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - startTs) / (24 * 3600 * 1000));
    if (day >= 0) {
      trades.push({
        day,
        rawPnl: pnl,
        entryTime: eb.openTime,
        exitTime: c[exitBar].closeTime,
      });
    }
    cooldown = exitBar + 1;
  }
  return trades;
}

interface FtmoCfg {
  leverage: number;
  riskFrac: number;
  maxDays: number;
  profitTarget: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  minTradingDays: number;
}

function simulateFtmo(trades: Trade[], cfg: FtmoCfg) {
  let equity = 1;
  const dayStart = new Map<number, number>();
  const td = new Set<number>();
  const sorted = [...trades].sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  );
  for (const t of sorted) {
    if (t.day >= cfg.maxDays) break;
    if (!dayStart.has(t.day)) dayStart.set(t.day, equity);
    const pnlF = Math.max(
      t.rawPnl * cfg.leverage * cfg.riskFrac,
      -cfg.riskFrac,
    );
    equity *= 1 + pnlF;
    td.add(t.day);
    if (equity <= 1 - cfg.maxTotalLoss)
      return { passed: false, reason: "total_loss", finalEq: equity - 1 };
    const sod = dayStart.get(t.day)!;
    if (equity / sod - 1 <= -cfg.maxDailyLoss)
      return { passed: false, reason: "daily_loss", finalEq: equity - 1 };
    if (equity >= 1 + cfg.profitTarget && td.size >= cfg.minTradingDays)
      return { passed: true, reason: "profit_target", finalEq: equity - 1 };
  }
  const late = equity >= 1 + cfg.profitTarget && td.size >= cfg.minTradingDays;
  return {
    passed: late,
    reason: late
      ? "profit_target"
      : td.size < cfg.minTradingDays
        ? "insufficient_days"
        : "time",
    finalEq: equity - 1,
  };
}

describe("iter 167 — TRUE daytrade FTMO strategy", () => {
  it(
    "find 2-5/day strategy passing FTMO at 2× leverage",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 167: TRUE DAYTRADE FTMO ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount: 100_000,
        maxPages: 200,
      });
      const barsPerDay = 96;
      const days = c.length / barsPerDay;
      console.log(`loaded ${c.length} 15m candles (${days.toFixed(0)} days)`);

      // FULL-history stats first — which trigger has positive raw mean at 2/day+
      const closes = c.map((x) => x.close);
      const rsi14 = rsiSeries(closes, 14);
      const rsi7 = rsiSeries(closes, 7);
      const ema50 = emaSeries(closes, 50);

      const allRsi = { closes, rsi: rsi14, ema50 };
      const allRsi7 = { closes, rsi: rsi7, ema50 };

      const triggers: { name: string; cfg: Cfg; ctx: typeof allRsi }[] = [];
      // breakouts
      for (const lb of [10, 20, 40, 80]) {
        for (const tp of [0.005, 0.01, 0.015, 0.02]) {
          for (const stop of [0.003, 0.005, 0.007]) {
            for (const hold of [4, 8, 16, 32]) {
              triggers.push({
                name: `brk${lb}_tp${tp}_s${stop}_h${hold}`,
                cfg: {
                  kind: "brk_hi",
                  param1: lb,
                  param2: 0,
                  tp,
                  stop,
                  hold,
                  direction: "long",
                },
                ctx: allRsi,
              });
              triggers.push({
                name: `brkShort${lb}_tp${tp}_s${stop}_h${hold}`,
                cfg: {
                  kind: "brk_lo_short",
                  param1: lb,
                  param2: 0,
                  tp,
                  stop,
                  hold,
                  direction: "short",
                },
                ctx: allRsi,
              });
            }
          }
        }
      }
      // pullback (trend + rsi re-cross)
      for (const th of [30, 35, 40, 45]) {
        for (const tp of [0.005, 0.01, 0.015, 0.02]) {
          for (const stop of [0.003, 0.005, 0.007]) {
            for (const hold of [8, 16, 32]) {
              triggers.push({
                name: `pullback${th}_tp${tp}_s${stop}_h${hold}`,
                cfg: {
                  kind: "pullback",
                  param1: 0,
                  param2: th,
                  tp,
                  stop,
                  hold,
                  direction: "long",
                },
                ctx: allRsi,
              });
            }
          }
        }
      }
      // n-down / n-up short
      for (const n of [3, 4, 5, 6]) {
        for (const tp of [0.005, 0.01, 0.015]) {
          for (const stop of [0.003, 0.005]) {
            for (const hold of [4, 8, 16]) {
              triggers.push({
                name: `${n}down_tp${tp}_s${stop}_h${hold}`,
                cfg: {
                  kind: "nDown",
                  param1: n,
                  param2: 0,
                  tp,
                  stop,
                  hold,
                  direction: "long",
                },
                ctx: allRsi,
              });
              triggers.push({
                name: `${n}up_S_tp${tp}_s${stop}_h${hold}`,
                cfg: {
                  kind: "nUp_short",
                  param1: n,
                  param2: 0,
                  tp,
                  stop,
                  hold,
                  direction: "short",
                },
                ctx: allRsi,
              });
            }
          }
        }
      }

      console.log(`scanning ${triggers.length} triggers on full history...`);

      // Filter triggers: freq ≥ 2/day full history AND raw mean > 0.08%
      interface GoodTrig {
        name: string;
        cfg: Cfg;
        ctx: typeof allRsi;
        n: number;
        perDay: number;
        wr: number;
        rawMean: number;
      }
      const good: GoodTrig[] = [];
      for (const { name, cfg, ctx } of triggers) {
        const t = runStrategy(c, cfg, 50, c.length, ctx, barsPerDay);
        if (t.length < 500) continue;
        const pnls = t.map((x) => x.rawPnl);
        const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        const wr = pnls.filter((p) => p > 0).length / pnls.length;
        const perDay = t.length / days;
        if (perDay < 2) continue;
        if (m < 0.0008) continue; // need at least 0.08% raw mean
        good.push({ name, cfg, ctx, n: t.length, perDay, wr, rawMean: m });
      }
      good.sort((a, b) => b.rawMean - a.rawMean);
      console.log(
        `Found ${good.length} triggers with freq ≥ 2/day AND raw mean ≥ 0.08%`,
      );
      console.log("\nTop 15:");
      console.log(
        "trigger                              n      /day   WR    rawMean%",
      );
      for (const g of good.slice(0, 15)) {
        console.log(
          `${g.name.padEnd(35)} ${g.n.toString().padStart(6)}  ${g.perDay.toFixed(2).padStart(4)}  ${(g.wr * 100).toFixed(0).padStart(2)}%  ${(g.rawMean * 100).toFixed(3).padStart(6)}%`,
        );
      }

      if (good.length === 0) {
        console.log(
          "\nNo trigger meets both freq ≥ 2/day AND raw mean ≥ 0.08%.",
        );
        console.log("Daytrade-only FTMO pass is structurally very hard.");
        expect(true).toBe(true);
        return;
      }

      // FTMO simulation on top 10
      console.log("\n── FTMO 294-window simulation on top 10 triggers ──");
      const winLen = 30 * barsPerDay;
      const step = 7 * barsPerDay;
      const windows: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < c.length; s += step) {
        windows.push({ start: s, end: s + winLen });
      }
      console.log(`windows: ${windows.length}`);

      const base: FtmoCfg = {
        leverage: 2,
        riskFrac: 0.1,
        maxDays: 30,
        profitTarget: 0.1,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 4,
      };

      console.log("\n                                  risk%");
      console.log(
        "trigger                            10%    20%    30%    50%    BEST EV($)",
      );
      interface Best {
        name: string;
        risk: number;
        pass: number;
        rate: number;
        ev: number;
      }
      const bests: Best[] = [];
      for (const g of good.slice(0, 10)) {
        const perWin = windows.map((w) =>
          runStrategy(c, g.cfg, w.start, w.end, g.ctx, barsPerDay),
        );
        const results: Record<string, number> = {};
        let bestEv = -Infinity;
        let bestDesc: Best = {
          name: g.name,
          risk: 0,
          pass: 0,
          rate: 0,
          ev: -99,
        };
        for (const r of [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0]) {
          const cfg = { ...base, riskFrac: r };
          let pass = 0;
          for (const trades of perWin) {
            const res = simulateFtmo(trades, cfg);
            if (res.passed) pass++;
          }
          const rate = pass / perWin.length;
          const ev = rate * 0.5 * 8000 - 99;
          results[`r${r}`] = rate;
          if (ev > bestEv) {
            bestEv = ev;
            bestDesc = { name: g.name, risk: r, pass, rate, ev };
          }
        }
        bests.push(bestDesc);
        console.log(
          `${g.name.padEnd(35)} ${((results["r0.1"] ?? 0) * 100).toFixed(1).padStart(4)}%  ${((results["r0.2"] ?? 0) * 100).toFixed(1).padStart(4)}%  ${((results["r0.3"] ?? 0) * 100).toFixed(1).padStart(4)}%  ${((results["r0.5"] ?? 0) * 100).toFixed(1).padStart(4)}%  r${bestDesc.risk} → ${(bestDesc.rate * 100).toFixed(1)}% EV $${bestDesc.ev.toFixed(0)}`,
        );
      }

      bests.sort((a, b) => b.ev - a.ev);
      console.log("\n★ Top 5 FTMO-viable daytrade strategies (by EV) ★");
      for (const b of bests.slice(0, 5)) {
        console.log(
          `  ${b.name} @ risk ${(b.risk * 100).toFixed(0)}% → pass ${b.pass}/${windows.length} (${(b.rate * 100).toFixed(2)}%) EV $${b.ev.toFixed(0)}`,
        );
      }

      expect(true).toBe(true);
    },
  );
});
