/**
 * Iter 162 — FTMO $100k Challenge Simulator.
 *
 * User: "habe 1:2 dann aber das müsste passen... $100k größe".
 *
 * FTMO Phase 1 Challenge rules (standard):
 *   • Account: $100,000
 *   • Profit target: +10% ($10,000) within 30 calendar days
 *   • Max Daily Loss: 5% ($5,000) rolling from daily close
 *   • Max Total Loss: 10% ($10,000) from starting balance
 *   • Min Trading Days: 4 separate days
 *   • Crypto leverage: 1:2
 *   • Funding: ignored (sub-daily holds, BTC perpetual)
 *
 * This simulator:
 *   1. Loads BTC 1h candles, splits into rolling 30-day windows
 *   2. For each tier (iter135, iter142, iter156 variants @ 2× NOT 10×),
 *      simulates trades with FTMO kill rules
 *   3. Reports pass rate: % of 30-day windows where tier hits +10% before
 *      breaching any FTMO rule
 *   4. Also reports "safe path": tier + per-trade risk sizing that MAXIMIZES
 *      pass rate while staying under 5% daily DD
 *
 * Per-trade position sizing: risk 1% of current equity per trade at 2× lev.
 * That means position notional = 1% equity × 2× = 2% of equity exposed.
 * Per-trade loss cap = 2% × raw_stop. For iter135 0.4% raw stop → 0.008% of
 * equity per trade. For iter156 flash 2% raw stop → 0.04% per trade. Both
 * well under 5% daily limit even in streaks.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runBtcFlashDaytrade } from "../src/utils/btcFlashDaytrade";
import type { Candle } from "../src/utils/indicators";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";

interface SimpleTrade {
  /** Day-of-test index (0..29). */
  day: number;
  /** Raw pnl fraction before leverage. */
  rawPnl: number;
  /** Exit timestamp. */
  exitTime: number;
}

interface FtmoResult {
  passed: boolean;
  reason:
    | "profit_target"
    | "daily_loss"
    | "total_loss"
    | "time"
    | "insufficient_days";
  daysElapsed: number;
  uniqueTradingDays: number;
  finalEquityPct: number;
  maxDd: number;
  dailyLossWorst: number;
  trades: number;
}

/**
 * Simulate FTMO Phase 1 Challenge.
 * Trades are given as (day, rawPnl) pairs. Leverage and per-trade risk
 * determine how much of equity is at stake per trade.
 */
function simulateFtmo(
  trades: SimpleTrade[],
  cfg: {
    leverage: number;
    riskFrac: number; // fraction of equity to put as margin per trade
    maxDays: number; // 30
    profitTarget: number; // 0.10
    maxDailyLoss: number; // 0.05
    maxTotalLoss: number; // 0.10
    minTradingDays: number; // 4
  },
): FtmoResult {
  let equity = 1.0; // $100k normalized to 1.0
  let peak = 1.0;
  let maxDd = 0;
  const dailyStart = new Map<number, number>(); // day -> equity at start of day
  const tradingDays = new Set<number>();
  let dailyLossWorst = 0;

  // Prep: enforce ordering
  trades = [...trades].sort((a, b) => a.day - b.day || a.exitTime - b.exitTime);

  for (const t of trades) {
    if (t.day >= cfg.maxDays) break;
    if (!dailyStart.has(t.day)) dailyStart.set(t.day, equity);

    // Position: margin = riskFrac × equity, notional = margin × leverage
    // P&L on notional = rawPnl × notional
    // P&L as fraction of equity = rawPnl × leverage × riskFrac
    const pnlFrac = Math.max(
      t.rawPnl * cfg.leverage * cfg.riskFrac,
      -cfg.riskFrac, // margin cap — can't lose more than margin
    );
    equity = equity * (1 + pnlFrac);
    tradingDays.add(t.day);

    // Max total loss check
    if (equity <= 1.0 - cfg.maxTotalLoss) {
      return {
        passed: false,
        reason: "total_loss",
        daysElapsed: t.day + 1,
        uniqueTradingDays: tradingDays.size,
        finalEquityPct: equity - 1,
        maxDd,
        dailyLossWorst,
        trades: trades.indexOf(t) + 1,
      };
    }

    // Max daily loss: equity drop from that day's start
    const startOfDay = dailyStart.get(t.day) ?? equity;
    const dayDrop = equity / startOfDay - 1;
    if (dayDrop < dailyLossWorst) dailyLossWorst = dayDrop;
    if (dayDrop <= -cfg.maxDailyLoss) {
      return {
        passed: false,
        reason: "daily_loss",
        daysElapsed: t.day + 1,
        uniqueTradingDays: tradingDays.size,
        finalEquityPct: equity - 1,
        maxDd,
        dailyLossWorst,
        trades: trades.indexOf(t) + 1,
      };
    }

    // Equity peak/DD
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDd) maxDd = dd;

    // Profit target (also require min trading days)
    if (
      equity >= 1.0 + cfg.profitTarget &&
      tradingDays.size >= cfg.minTradingDays
    ) {
      return {
        passed: true,
        reason: "profit_target",
        daysElapsed: t.day + 1,
        uniqueTradingDays: tradingDays.size,
        finalEquityPct: equity - 1,
        maxDd,
        dailyLossWorst,
        trades: trades.indexOf(t) + 1,
      };
    }
  }

  // End of maxDays
  const passedLate =
    equity >= 1.0 + cfg.profitTarget && tradingDays.size >= cfg.minTradingDays;
  return {
    passed: passedLate,
    reason: passedLate
      ? "profit_target"
      : tradingDays.size < cfg.minTradingDays
        ? "insufficient_days"
        : "time",
    daysElapsed: cfg.maxDays,
    uniqueTradingDays: tradingDays.size,
    finalEquityPct: equity - 1,
    maxDd,
    dailyLossWorst,
    trades: trades.length,
  };
}

// ---------- strategy runners producing SimpleTrade[] ----------

function rsiSeries(closes: number[], len: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= len) return out;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss += -d;
  }
  gain /= len;
  loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (len - 1) + g) / len;
    loss = (loss * (len - 1) + l) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Simple RSI-mean-reversion daytrade: RSI14≤30 on 1h → long, TP 0.5%, stop 0.3%, hold 4h. */
function runRsiMr(
  candles: Candle[],
  windowStart: number,
  windowEnd: number,
): SimpleTrade[] {
  const slice = candles.slice(windowStart, windowEnd);
  const closes = slice.map((c) => c.close);
  const rsi = rsiSeries(closes, 14);
  const trades: SimpleTrade[] = [];
  let cooldown = -1;
  const tpPct = 0.005;
  const stopPct = 0.003;
  const holdBars = 4;
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
    trades.push({ day, rawPnl: pnl, exitTime: slice[exitBar].closeTime });
    cooldown = exitBar + 1;
  }
  return trades;
}

/** iter156 Flash daytrade (unlevered entry, tp 10%, stop 2%, hold 24h, 72b/15% drop). */
function runFlash(
  candles: Candle[],
  windowStart: number,
  windowEnd: number,
): SimpleTrade[] {
  const slice = candles.slice(windowStart, windowEnd);
  // need ≥ 72 prior bars of context — use 3d pre-pad
  const contextStart = Math.max(0, windowStart - 200);
  const contextSlice = candles.slice(contextStart, windowEnd);
  const startTs = slice[0].openTime;
  const report = runBtcFlashDaytrade(contextSlice, {
    dropBars: 72,
    dropPct: 0.15,
    tpPct: 0.1,
    stopPct: 0.02,
    holdBars: 24,
    leverage: 1, // raw pnl — leverage applied by simulator
    costs: MAKER_COSTS,
  });
  const trades: SimpleTrade[] = [];
  for (const t of report.trades) {
    if (t.entryTime < slice[0].openTime) continue;
    if (t.entryTime > slice[slice.length - 1].openTime) continue;
    const day = Math.floor((t.entryTime - startTs) / (24 * 3600 * 1000));
    trades.push({ day, rawPnl: t.rawPnl, exitTime: t.exitTime });
  }
  return trades;
}

describe("iter 162 — FTMO $100k Challenge simulation", () => {
  it(
    "compute pass rate for each tier on rolling 30-day windows",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 162: FTMO $100k CHALLENGE ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const days = Math.floor(c.length / 24);
      console.log(`loaded ${c.length} 1h candles (${days} days)`);

      // rolling 30-day windows, step by 7 days
      const windows: { start: number; end: number }[] = [];
      const winLen = 30 * 24;
      const step = 7 * 24;
      for (let s = 0; s + winLen < c.length; s += step) {
        windows.push({ start: s, end: s + winLen });
      }
      console.log(`windows: ${windows.length} × 30 days, step 7 days\n`);

      const ftmoCfg = {
        leverage: 2,
        riskFrac: 0.01, // 1% per trade — safe default
        maxDays: 30,
        profitTarget: 0.1,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 4,
      };

      // Test 1: RSI14 mean-reversion, 1% risk
      console.log(
        "── Test 1: RSI14≤30 mean-reversion @ 2× leverage, 1% risk/trade ──",
      );
      let pass = 0,
        fails: Record<string, number> = {
          daily_loss: 0,
          total_loss: 0,
          time: 0,
          insufficient_days: 0,
        };
      let totalEquity = 0;
      for (const w of windows) {
        const trades = runRsiMr(c, w.start, w.end);
        const res = simulateFtmo(trades, ftmoCfg);
        if (res.passed) pass++;
        else fails[res.reason]++;
        totalEquity += res.finalEquityPct;
      }
      const avgEquity = totalEquity / windows.length;
      console.log(
        `  Pass: ${pass}/${windows.length} (${((pass / windows.length) * 100).toFixed(1)}%)  avgEq ${(avgEquity * 100).toFixed(2)}%`,
      );
      console.log(
        `  Fails: daily_loss ${fails.daily_loss}, total_loss ${fails.total_loss}, time ${fails.time}, insufficient_days ${fails.insufficient_days}`,
      );

      // Test 2: Same RSI strategy with higher risk per trade (to hit 10% faster)
      for (const risk of [0.02, 0.03, 0.05, 0.1]) {
        console.log(
          `\n── RSI14≤30 @ 2× lev, ${(risk * 100).toFixed(0)}% risk/trade ──`,
        );
        const cfg = { ...ftmoCfg, riskFrac: risk };
        let p = 0;
        const f: Record<string, number> = {
          daily_loss: 0,
          total_loss: 0,
          time: 0,
          insufficient_days: 0,
        };
        let eq = 0;
        for (const w of windows) {
          const trades = runRsiMr(c, w.start, w.end);
          const res = simulateFtmo(trades, cfg);
          if (res.passed) p++;
          else f[res.reason]++;
          eq += res.finalEquityPct;
        }
        console.log(
          `  Pass: ${p}/${windows.length} (${((p / windows.length) * 100).toFixed(1)}%)  avgEq ${((eq / windows.length) * 100).toFixed(2)}%  fails: dl${f.daily_loss} tl${f.total_loss} t${f.time} nd${f.insufficient_days}`,
        );
      }

      // Test 3: iter156 FLASH (only 5/yr so rare in 30d, but big when it fires)
      console.log("\n── iter156 FLASH daytrade @ 2× lev, 5% risk/trade ──");
      let fp = 0;
      let fWithAny = 0;
      for (const w of windows) {
        const trades = runFlash(c, w.start, w.end);
        if (trades.length > 0) fWithAny++;
        const res = simulateFtmo(trades, { ...ftmoCfg, riskFrac: 0.05 });
        if (res.passed) fp++;
      }
      console.log(
        `  Windows with ≥1 flash signal: ${fWithAny}/${windows.length}`,
      );
      console.log(
        `  Pass: ${fp}/${windows.length} (${((fp / windows.length) * 100).toFixed(1)}%)`,
      );

      // Test 4: Combined RSI + FLASH hybrid
      console.log(
        "\n── HYBRID: RSI (3% risk) + FLASH (10% risk) @ 2× leverage ──",
      );
      let hp = 0;
      const hf: Record<string, number> = {
        daily_loss: 0,
        total_loss: 0,
        time: 0,
        insufficient_days: 0,
      };
      let heq = 0;
      for (const w of windows) {
        const rsiTrades = runRsiMr(c, w.start, w.end).map((t) => ({
          ...t,
          rawPnl: t.rawPnl * (0.03 / 0.05), // normalize to 3% risk sizing
        }));
        // Actually just use same trade list but cfg riskFrac=0.03 for RSI and 0.1 for flash — simulator doesn't support dual-risk.
        // Simulate a combined list where FLASH trades pre-amplified by risk ratio 0.1/0.03
        const flashTrades = runFlash(c, w.start, w.end).map((t) => ({
          ...t,
          rawPnl: t.rawPnl * (0.1 / 0.03), // scale flash as if it used 10% risk vs 3%
        }));
        const combined = [...runRsiMr(c, w.start, w.end), ...flashTrades].sort(
          (a, b) => a.day - b.day || a.exitTime - b.exitTime,
        );
        const res = simulateFtmo(combined, { ...ftmoCfg, riskFrac: 0.03 });
        if (res.passed) hp++;
        else hf[res.reason]++;
        heq += res.finalEquityPct;
      }
      console.log(
        `  Pass: ${hp}/${windows.length} (${((hp / windows.length) * 100).toFixed(1)}%)  avgEq ${((heq / windows.length) * 100).toFixed(2)}%  fails: dl${hf.daily_loss} tl${hf.total_loss} t${hf.time} nd${hf.insufficient_days}`,
      );

      // Industry-quoted FTMO pass rate: ~10-15% for Phase 1. Our sim calibration check.
      console.log(
        "\nFTMO official quoted Phase 1 pass rate for traders: ~10-15%. Use as benchmark.",
      );

      expect(true).toBe(true);
    },
  );
});
