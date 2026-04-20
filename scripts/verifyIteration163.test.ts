/**
 * Iter 163 — AGGRESSIVE FTMO risk sizing + EV analysis.
 *
 * User accepts that safe (1% risk) daytrade @ 2× leverage never passes FTMO
 * $100k Challenge in 30 days. Now asking for high-risk/high-reward sizing.
 *
 * Approach: treat the Challenge as an EV bet:
 *   • Cost: Challenge fee ≈ $99 (FTMO $100k Phase 1)
 *   • Prize if passed (Phase 1 + Phase 2 + Funded): ~$8k first payout
 *   • Break-even pass rate: 99 / 8000 = 1.24%
 *   • Need pass rate ≥ ~2-3% to be positive EV accounting for Phase 2 risk
 *
 * Math: Phase 1 only (Phase 2 requires 5% in 60d, ~50% conditional pass rate).
 * If Phase 1 pass rate = X%, full funded path ≈ X × 0.5 × 0.8 (80% profit split).
 *
 * This iter scans:
 *   • riskFrac ∈ {5%, 10%, 15%, 20%, 25%, 30%, 40%, 50%} per trade
 *   • Both RSI mean-reversion AND flash-crash opportunistic entries
 *   • Hybrid: switch to flash-crash max-risk if signal appears, else RSI
 *
 * Outputs: pass rate + EV decision table.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runBtcFlashDaytrade } from "../src/utils/btcFlashDaytrade";
import type { Candle } from "../src/utils/indicators";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";

interface SimpleTrade {
  day: number;
  rawPnl: number;
  exitTime: number;
  type: "rsi" | "flash";
}

function simulateFtmo(
  trades: SimpleTrade[],
  cfg: {
    leverage: number;
    riskRsi: number;
    riskFlash: number;
    maxDays: number;
    profitTarget: number;
    maxDailyLoss: number;
    maxTotalLoss: number;
    minTradingDays: number;
  },
): {
  passed: boolean;
  reason:
    | "profit_target"
    | "daily_loss"
    | "total_loss"
    | "time"
    | "insufficient_days";
  finalEquityPct: number;
  uniqueDays: number;
} {
  let equity = 1.0;
  const dayStart = new Map<number, number>();
  const tradingDays = new Set<number>();

  const sorted = [...trades].sort(
    (a, b) => a.day - b.day || a.exitTime - b.exitTime,
  );

  for (const t of sorted) {
    if (t.day >= cfg.maxDays) break;
    if (!dayStart.has(t.day)) dayStart.set(t.day, equity);

    const riskFrac = t.type === "flash" ? cfg.riskFlash : cfg.riskRsi;
    const pnlFrac = Math.max(t.rawPnl * cfg.leverage * riskFrac, -riskFrac);
    equity *= 1 + pnlFrac;
    tradingDays.add(t.day);

    if (equity <= 1 - cfg.maxTotalLoss) {
      return {
        passed: false,
        reason: "total_loss",
        finalEquityPct: equity - 1,
        uniqueDays: tradingDays.size,
      };
    }
    const startOfDay = dayStart.get(t.day)!;
    if (equity / startOfDay - 1 <= -cfg.maxDailyLoss) {
      return {
        passed: false,
        reason: "daily_loss",
        finalEquityPct: equity - 1,
        uniqueDays: tradingDays.size,
      };
    }
    if (
      equity >= 1 + cfg.profitTarget &&
      tradingDays.size >= cfg.minTradingDays
    ) {
      return {
        passed: true,
        reason: "profit_target",
        finalEquityPct: equity - 1,
        uniqueDays: tradingDays.size,
      };
    }
  }
  const passedLate =
    equity >= 1 + cfg.profitTarget && tradingDays.size >= cfg.minTradingDays;
  return {
    passed: passedLate,
    reason: passedLate
      ? "profit_target"
      : tradingDays.size < cfg.minTradingDays
        ? "insufficient_days"
        : "time",
    finalEquityPct: equity - 1,
    uniqueDays: tradingDays.size,
  };
}

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

function runRsiMr(
  candles: Candle[],
  windowStart: number,
  windowEnd: number,
  tpPct: number,
  stopPct: number,
  holdBars: number,
): SimpleTrade[] {
  const slice = candles.slice(windowStart, windowEnd);
  const closes = slice.map((c) => c.close);
  const rsi = rsiSeries(closes, 14);
  const trades: SimpleTrade[] = [];
  let cooldown = -1;
  const startTs = slice[0].openTime;
  for (let i = 20; i < slice.length - 1; i++) {
    if (i < cooldown) continue;
    if (rsi[i] > 30) continue;
    const eb = slice[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 + tpPct);
    const stop = entry * (1 - stopPct);
    const mx = Math.min(i + 1 + holdBars, slice.length - 1);
    let exitBar = mx;
    let exitPrice = slice[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = slice[j];
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
    }
    const pnl = applyCosts({
      entry,
      exit: exitPrice,
      direction: "long",
      holdingHours: exitBar - (i + 1),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor(
      (slice[i + 1].openTime - startTs) / (24 * 3600 * 1000),
    );
    trades.push({
      day,
      rawPnl: pnl,
      exitTime: slice[exitBar].closeTime,
      type: "rsi",
    });
    cooldown = exitBar + 1;
  }
  return trades;
}

function runFlash(
  candles: Candle[],
  windowStart: number,
  windowEnd: number,
): SimpleTrade[] {
  const slice = candles.slice(windowStart, windowEnd);
  const contextStart = Math.max(0, windowStart - 200);
  const contextSlice = candles.slice(contextStart, windowEnd);
  const startTs = slice[0].openTime;
  const report = runBtcFlashDaytrade(contextSlice, {
    dropBars: 72,
    dropPct: 0.15,
    tpPct: 0.1,
    stopPct: 0.02,
    holdBars: 24,
    leverage: 1,
    costs: MAKER_COSTS,
  });
  const trades: SimpleTrade[] = [];
  for (const t of report.trades) {
    if (t.entryTime < slice[0].openTime) continue;
    if (t.entryTime > slice[slice.length - 1].openTime) continue;
    const day = Math.floor((t.entryTime - startTs) / (24 * 3600 * 1000));
    trades.push({
      day,
      rawPnl: t.rawPnl,
      exitTime: t.exitTime,
      type: "flash",
    });
  }
  return trades;
}

describe("iter 163 — aggressive FTMO risk sizing + EV", () => {
  it(
    "scan pass rate by risk level + EV analysis",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 163: AGGRESSIVE FTMO RISK SIZING ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });

      const winLen = 30 * 24;
      const step = 7 * 24;
      const windows: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < c.length; s += step) {
        windows.push({ start: s, end: s + winLen });
      }
      console.log(`windows: ${windows.length} × 30 days, step 7 days\n`);

      // Pre-compute trades per window (RSI + flash) once
      const precomputed = windows.map((w) => ({
        rsi: runRsiMr(c, w.start, w.end, 0.005, 0.003, 4),
        flash: runFlash(c, w.start, w.end),
      }));

      const cfgBase = {
        leverage: 2,
        maxDays: 30,
        profitTarget: 0.1,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 4,
      };

      const CHALLENGE_FEE = 99;
      const PAYOUT_IF_FUNDED = 8000; // first funded payout est. ($10k × 80% profit split)
      const PHASE2_PASS_RATE = 0.5; // rough: if you passed P1 aggressively, P2 (5% in 60d) is easier
      console.log(
        `EV context: fee $${CHALLENGE_FEE}, payout if funded $${PAYOUT_IF_FUNDED}, phase2 conditional pass ~${(PHASE2_PASS_RATE * 100).toFixed(0)}%`,
      );
      console.log(
        `Break-even Phase1-pass rate for positive EV: ${((CHALLENGE_FEE / (PAYOUT_IF_FUNDED * PHASE2_PASS_RATE)) * 100).toFixed(2)}%\n`,
      );

      // Sweep risk levels for RSI-only strategy
      console.log("── RSI-only, risk per trade sweep (2× leverage) ──");
      console.log(
        "risk%   pass/N    rate%   fails:  daily_loss  total_loss  time  insufficient_days   EV($)",
      );
      const allRisks = [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
      for (const r of allRisks) {
        let pass = 0;
        const f = {
          daily_loss: 0,
          total_loss: 0,
          time: 0,
          insufficient_days: 0,
        };
        for (const p of precomputed) {
          const res = simulateFtmo(p.rsi, {
            ...cfgBase,
            riskRsi: r,
            riskFlash: 0,
          });
          if (res.passed) pass++;
          else f[res.reason as keyof typeof f]++;
        }
        const rate = pass / precomputed.length;
        const ev = rate * PHASE2_PASS_RATE * PAYOUT_IF_FUNDED - CHALLENGE_FEE;
        console.log(
          `${(r * 100).toFixed(0).padStart(3)}%   ${pass}/${precomputed.length}   ${(rate * 100).toFixed(2).padStart(5)}%         ${f.daily_loss.toString().padStart(3)}         ${f.total_loss.toString().padStart(3)}    ${f.time.toString().padStart(3)}              ${f.insufficient_days.toString().padStart(3)}         ${ev > 0 ? "+" : ""}${ev.toFixed(0).padStart(5)}`,
        );
      }

      console.log("\n── FLASH-only, risk sweep (2× leverage) ──");
      console.log("risk%   pass/N    rate%    EV($)");
      for (const r of allRisks) {
        let pass = 0;
        for (const p of precomputed) {
          const res = simulateFtmo(p.flash, {
            ...cfgBase,
            riskRsi: 0,
            riskFlash: r,
          });
          if (res.passed) pass++;
        }
        const rate = pass / precomputed.length;
        const ev = rate * PHASE2_PASS_RATE * PAYOUT_IF_FUNDED - CHALLENGE_FEE;
        console.log(
          `${(r * 100).toFixed(0).padStart(3)}%   ${pass}/${precomputed.length}   ${(rate * 100).toFixed(2).padStart(5)}%   ${ev > 0 ? "+" : ""}${ev.toFixed(0).padStart(5)}`,
        );
      }

      // Hybrid: RSI small + FLASH large when signal
      console.log(
        "\n── HYBRID: RSI (5% risk) + FLASH (30%/50% risk) — optimal combo ──",
      );
      console.log("rskRsi  rskFls   pass/N   rate%   avgEq%   EV($)");
      for (const rR of [0.02, 0.05, 0.1, 0.15]) {
        for (const rF of [0.15, 0.2, 0.3, 0.4, 0.5]) {
          let pass = 0;
          let totalEq = 0;
          for (const p of precomputed) {
            const combined = [...p.rsi, ...p.flash];
            const res = simulateFtmo(combined, {
              ...cfgBase,
              riskRsi: rR,
              riskFlash: rF,
            });
            if (res.passed) pass++;
            totalEq += res.finalEquityPct;
          }
          const rate = pass / precomputed.length;
          const ev = rate * PHASE2_PASS_RATE * PAYOUT_IF_FUNDED - CHALLENGE_FEE;
          console.log(
            `  ${(rR * 100).toFixed(0).padStart(2)}%    ${(rF * 100).toFixed(0).padStart(2)}%   ${pass}/${precomputed.length}   ${(rate * 100).toFixed(2).padStart(5)}%  ${((totalEq / precomputed.length) * 100).toFixed(2).padStart(6)}%   ${ev > 0 ? "+" : ""}${ev.toFixed(0).padStart(5)}`,
          );
        }
      }

      // Find best EV overall
      console.log("\n── Best EV configurations ──");
      interface Best {
        strategy: string;
        rR: number;
        rF: number;
        pass: number;
        rate: number;
        ev: number;
      }
      const results: Best[] = [];
      for (const rR of [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]) {
        for (const rF of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
          if (rR === 0 && rF === 0) continue;
          let pass = 0;
          for (const p of precomputed) {
            const combined = [...p.rsi, ...p.flash];
            const res = simulateFtmo(combined, {
              ...cfgBase,
              riskRsi: rR,
              riskFlash: rF,
            });
            if (res.passed) pass++;
          }
          const rate = pass / precomputed.length;
          const ev = rate * PHASE2_PASS_RATE * PAYOUT_IF_FUNDED - CHALLENGE_FEE;
          results.push({
            strategy:
              rR === 0 ? "Flash only" : rF === 0 ? "RSI only" : "Hybrid",
            rR,
            rF,
            pass,
            rate,
            ev,
          });
        }
      }
      results.sort((a, b) => b.ev - a.ev);
      console.log("Top 10 EV-ranked configs:");
      console.log("strategy   rskRsi%  rskFls%  pass/N   rate%   EV($)");
      for (const r of results.slice(0, 10)) {
        console.log(
          `${r.strategy.padEnd(10)}  ${(r.rR * 100).toFixed(0).padStart(3)}%     ${(r.rF * 100).toFixed(0).padStart(3)}%   ${r.pass}/${precomputed.length}   ${(r.rate * 100).toFixed(2).padStart(5)}%  ${r.ev > 0 ? "+" : ""}${r.ev.toFixed(0).padStart(5)}`,
        );
      }

      expect(true).toBe(true);
    },
  );
});
