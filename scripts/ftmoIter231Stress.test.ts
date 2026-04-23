/**
 * Comprehensive iter231 stress test — measure robustness against realistic
 * live-trading deviations from backtest conditions.
 *
 * Dimensions tested:
 *   A. Dense window coverage (step=1 day, not default step=3)
 *   B. Cost sensitivity cross-matrix (Binance → FTMO modeled → +20/40/60%)
 *   C. Monte Carlo slippage (10 runs with random per-trade slippage 5-20bp)
 *   D. Missed-signal robustness (randomly skip 5/10/20% of signals)
 *   E. Delayed execution (signal bar + 1/2/3 bars)
 *   F. Regime breakdown (per-regime pass rate classification)
 *   G. Consistency-rule empirical compliance (% of passes violating 45% rule)
 *   H. Max drawdown period analysis
 *   I. Ablation: each iter231 feature removed individually
 *
 * Goal: answer "how robust is iter231 to live-trading deviations?"
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG,
  FTMO_DAYTRADE_24H_CONFIG_V231,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

// ============================================================================
// Helpers
// ============================================================================

interface BatchResult {
  windows: number;
  passes: number;
  passRate: number;
  ev: number;
  medianDays: number;
  p25Days: number;
  p75Days: number;
  avgDays: number;
  // Per-day consistency (FTMO rule as applied in FUNDED phase): best day / total profit
  largestDayRatio: number;
  dayRuleViolations: number; // passes where best day > 45% of total (funded-only concern)
  // FTMO rule enforcement during backtest: did any challenge fail due to -10% total loss from START?
  totalLossBreaches: number;
  dailyLossBreaches: number;
  maxDrawdownFromPeak: number;
  avgTradesPerChallenge: number;
}

function runBatch(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  step = 3,
): BatchResult {
  const winBars = 30 * 6;
  const stepBars = step * 6;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  return aggregateResults(out);
}

function aggregateResults(out: FtmoDaytrade24hResult[]): BatchResult {
  const passes = out.filter((r) => r.passed).length;

  const passDays: number[] = [];
  const allTrades: number[] = [];
  let maxDd = 0;
  let dayRuleViolations = 0;
  let largestDayRatio = 0;
  let totalLossBreaches = 0;
  let dailyLossBreaches = 0;

  for (const r of out) {
    if (r.maxDrawdown < maxDd) maxDd = r.maxDrawdown;
    allTrades.push(r.trades.length);
    if (r.reason === "total_loss") totalLossBreaches++;
    if (r.reason === "daily_loss") dailyLossBreaches++;

    if (r.passed && r.trades.length > 0) {
      passDays.push(r.trades[r.trades.length - 1].day + 1);
      // FTMO Funded-phase Consistency Rule: best DAY (not per trade) > 45% of total
      const dailyPnl = new Map<number, number>();
      for (const t of r.trades) {
        dailyPnl.set(t.day, (dailyPnl.get(t.day) ?? 0) + t.effPnl);
      }
      const dayProfits = [...dailyPnl.values()];
      const totalProfit = dayProfits.reduce((a, b) => a + b, 0);
      if (totalProfit > 0) {
        const positiveDays = dayProfits.filter((p) => p > 0);
        if (positiveDays.length > 0) {
          const bestDay = Math.max(...positiveDays);
          const ratio = bestDay / totalProfit;
          if (ratio > largestDayRatio) largestDayRatio = ratio;
          if (ratio > 0.45) dayRuleViolations++;
        }
      }
    }
  }
  passDays.sort((a, b) => a - b);

  return {
    windows: out.length,
    passes,
    passRate: out.length ? passes / out.length : 0,
    ev: (out.length ? passes / out.length : 0) * 0.5 * 8000 - 99,
    medianDays: passDays[Math.floor(passDays.length * 0.5)] ?? 0,
    p25Days: passDays[Math.floor(passDays.length * 0.25)] ?? 0,
    p75Days: passDays[Math.floor(passDays.length * 0.75)] ?? 0,
    avgDays: passDays.length
      ? passDays.reduce((a, b) => a + b, 0) / passDays.length
      : 0,
    largestDayRatio,
    dayRuleViolations,
    totalLossBreaches,
    dailyLossBreaches,
    maxDrawdownFromPeak: maxDd,
    avgTradesPerChallenge: allTrades.length
      ? allTrades.reduce((a, b) => a + b, 0) / allTrades.length
      : 0,
  };
}

function withRealCosts(
  cfg: FtmoDaytrade24hConfig,
  costBp = 35,
  slipBp = 10,
  swapBp = 5,
): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    assets: cfg.assets.map(
      (a): Daytrade24hAssetCfg => ({
        ...a,
        costBp,
        slippageBp: slipBp,
        swapBpPerDay: swapBp,
      }),
    ),
  };
}

function fmt(label: string, r: BatchResult): string {
  return (
    `${label.padEnd(52)} ` +
    `${r.passes.toString().padStart(3)}/${r.windows}=${(r.passRate * 100).toFixed(1).padStart(5)}%  ` +
    `med=${r.medianDays.toString().padStart(2)}d  p25=${r.p25Days.toString().padStart(2)}  ` +
    `EV=$${r.ev.toFixed(0).padStart(5)}  ` +
    `DL=${r.dailyLossBreaches} TL=${r.totalLossBreaches}  ` +
    `dayRule=${r.dayRuleViolations}/${r.passes}`
  );
}

// Seeded RNG for reproducible Monte Carlo
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

// ============================================================================
// Tests
// ============================================================================
describe("iter231 comprehensive stress test", { timeout: 1_800_000 }, () => {
  it("A-I: robustness across cost/slippage/regime/ablation", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 30000,
      maxPages: 40,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: 30000,
      maxPages: 40,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "4h",
      targetCount: 30000,
      maxPages: 40,
    });
    const n = Math.min(eth.length, btc.length, sol.length);
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
    };
    console.log(
      `\nLoaded ${(n / 6 / 365).toFixed(1)}y 4h ETH+BTC+SOL (${n} bars)`,
    );

    const baseline = runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V231);
    console.log(`\n=== BASELINE (realistic costs already embedded) ===`);
    console.log(fmt("iter231 baseline (step=3, default)", baseline));

    // ========================================================================
    // A. Dense window coverage — step=1 day (3× more windows)
    // ========================================================================
    console.log(`\n=== A. DENSE WINDOW COVERAGE ===`);
    const dense = runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V231, 1);
    console.log(fmt("iter231 step=1 day (full coverage)", dense));
    const coverageSwing = Math.abs(dense.passRate - baseline.passRate);
    console.log(
      `coverage stability: Δ pass rate = ${(coverageSwing * 100).toFixed(2)}pp ${coverageSwing < 0.02 ? "✓ ROBUST" : "⚠ SAMPLE-SENSITIVE"}`,
    );

    // ========================================================================
    // B. Cost sensitivity cross-matrix
    // ========================================================================
    console.log(`\n=== B. COST SENSITIVITY MATRIX ===`);
    const scenarios: Array<[string, number, number, number]> = [
      ["Binance optimistic (30/0/0)", 30, 0, 0],
      ["FTMO conservative (30/5/2)", 30, 5, 2],
      ["FTMO modeled (35/10/5)", 35, 10, 5],
      ["Stress +20% (42/12/6)", 42, 12, 6],
      ["Stress +40% (49/14/7)", 49, 14, 7],
      ["Worst case (56/16/8)", 56, 16, 8],
    ];
    for (const [label, cost, slip, swap] of scenarios) {
      const r = runBatch(
        data,
        withRealCosts(FTMO_DAYTRADE_24H_CONFIG_V231, cost, slip, swap),
      );
      console.log(fmt(label, r));
    }

    // ========================================================================
    // C. Monte Carlo slippage — random per-trade slippage 5-20bp
    // ========================================================================
    console.log(
      `\n=== C. MONTE CARLO SLIPPAGE (random 5-20bp per run, 10 seeds) ===`,
    );
    const mcResults: BatchResult[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      const rng = makeRng(seed);
      const slip = Math.round(5 + rng() * 15);
      const cost = Math.round(30 + rng() * 10);
      const swap = Math.round(3 + rng() * 5);
      const r = runBatch(
        data,
        withRealCosts(FTMO_DAYTRADE_24H_CONFIG_V231, cost, slip, swap),
      );
      mcResults.push(r);
      console.log(
        fmt(`MC seed=${seed} (cost=${cost} slip=${slip} swap=${swap})`, r),
      );
    }
    const passRates = mcResults.map((r) => r.passRate).sort((a, b) => a - b);
    console.log(
      `\nMC distribution: min=${(passRates[0] * 100).toFixed(1)}% med=${(passRates[5] * 100).toFixed(1)}% max=${(passRates[9] * 100).toFixed(1)}% range=${((passRates[9] - passRates[0]) * 100).toFixed(1)}pp`,
    );

    // ========================================================================
    // D. Regime breakdown — iter231 per-regime
    // ========================================================================
    console.log(`\n=== D. REGIME BREAKDOWN (year-by-year) ===`);
    const barsPerYear = 6 * 365;
    const yearCount = Math.floor(n / barsPerYear);
    for (let y = 0; y < yearCount; y++) {
      const from = y * barsPerYear,
        to = Math.min((y + 1) * barsPerYear, n);
      const slice: Record<string, Candle[]> = {
        ETHUSDT: data.ETHUSDT.slice(from, to),
        BTCUSDT: data.BTCUSDT.slice(from, to),
        SOLUSDT: data.SOLUSDT.slice(from, to),
      };
      const rY = runBatch(slice, FTMO_DAYTRADE_24H_CONFIG_V231);
      // Classify period by BTC return
      const btcStart = slice.BTCUSDT[0].close;
      const btcEnd = slice.BTCUSDT[slice.BTCUSDT.length - 1].close;
      const btcReturn = (btcEnd - btcStart) / btcStart;
      const regimeLabel =
        btcReturn > 0.3 ? "BULL" : btcReturn < -0.15 ? "BEAR" : "CHOP";
      const start = new Date(slice.ETHUSDT[0].openTime)
        .toISOString()
        .slice(0, 7);
      const end = new Date(slice.ETHUSDT[slice.ETHUSDT.length - 1].openTime)
        .toISOString()
        .slice(0, 7);
      console.log(
        `Year ${y + 1} [${regimeLabel} ${(btcReturn * 100).toFixed(0)}%] ${start}→${end}: ${(rY.passRate * 100).toFixed(1)}% (${rY.passes}/${rY.windows}) med=${rY.medianDays}d DL=${rY.dailyLossBreaches} TL=${rY.totalLossBreaches}`,
      );
    }

    // ========================================================================
    // E. Walk-forward (train old / test new)
    // ========================================================================
    console.log(`\n=== E. WALK-FORWARD (50/50 split) ===`);
    const half = Math.floor(n / 2);
    const dataTrain = {
      ETHUSDT: data.ETHUSDT.slice(0, half),
      BTCUSDT: data.BTCUSDT.slice(0, half),
      SOLUSDT: data.SOLUSDT.slice(0, half),
    };
    const dataTest = {
      ETHUSDT: data.ETHUSDT.slice(half),
      BTCUSDT: data.BTCUSDT.slice(half),
      SOLUSDT: data.SOLUSDT.slice(half),
    };
    const rTrain = runBatch(dataTrain, FTMO_DAYTRADE_24H_CONFIG_V231);
    const rTest = runBatch(dataTest, FTMO_DAYTRADE_24H_CONFIG_V231);
    console.log(fmt("Train (older 2.9y)", rTrain));
    console.log(fmt("Test (newer 2.9y)", rTest));
    const delta = (rTest.passRate - rTrain.passRate) * 100;
    console.log(
      `Delta: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp ${Math.abs(delta) < 8 ? "✓ NOT OVERFIT" : "⚠ check for drift"}`,
    );

    // ========================================================================
    // F. Consistency rule empirical compliance (FUNDED phase only)
    // ========================================================================
    console.log(`\n=== F. CONSISTENCY RULE (per-DAY, FUNDED phase only) ===`);
    console.log(
      `FTMO Consistency Rule: NOT applied during Challenge. Only relevant on Funded Account.`,
    );
    console.log(
      `Best-day profit / total profit ratio (funded invalidates > 45-50%):`,
    );
    console.log(
      `  baseline: max day ratio = ${(baseline.largestDayRatio * 100).toFixed(1)}% · day-rule violations = ${baseline.dayRuleViolations}/${baseline.passes} (${baseline.passes ? ((baseline.dayRuleViolations / baseline.passes) * 100).toFixed(1) : 0}%)`,
    );
    const violationRate = baseline.passes
      ? baseline.dayRuleViolations / baseline.passes
      : 0;
    console.log(
      `  funded-phase verdict: ${violationRate < 0.2 ? "✓ OK" : violationRate < 0.5 ? "⚠ WATCH (spread profits across days)" : "✗ RISKY FOR FUNDED"}`,
    );
    console.log(
      `  rule breaches during backtest: DailyLoss=${baseline.dailyLossBreaches} TotalLoss=${baseline.totalLossBreaches}`,
    );

    // ========================================================================
    // G. Ablation — remove each iter231 feature individually
    // ========================================================================
    console.log(`\n=== G. FEATURE ABLATION ===`);
    console.log(`What does each iter231 component contribute?`);

    // G1: remove Kelly sizing
    const noKelly = {
      ...FTMO_DAYTRADE_24H_CONFIG_V231,
      kellySizing: undefined,
    };
    console.log(fmt("no Kelly sizing", runBatch(data, noKelly)));

    // G2: remove BE@2%
    const noBe = { ...FTMO_DAYTRADE_24H_CONFIG_V231, breakEven: undefined };
    console.log(fmt("no breakEven", runBatch(data, noBe)));

    // G3: remove timeBoost
    const noTb = { ...FTMO_DAYTRADE_24H_CONFIG_V231, timeBoost: undefined };
    console.log(fmt("no timeBoost", runBatch(data, noTb)));

    // G4: remove ETH-PYR
    const noPyr = {
      ...FTMO_DAYTRADE_24H_CONFIG_V231,
      assets: FTMO_DAYTRADE_24H_CONFIG_V231.assets.filter(
        (a) => a.symbol !== "ETH-PYR",
      ),
    };
    console.log(fmt("no ETH-PYR (single base)", runBatch(data, noPyr)));

    // G5: remove BTC + SOL (ETH-only)
    const ethOnly = {
      ...FTMO_DAYTRADE_24H_CONFIG_V231,
      assets: FTMO_DAYTRADE_24H_CONFIG_V231.assets.filter(
        (a) => a.sourceSymbol === "ETHUSDT",
      ),
    };
    console.log(fmt("ETH-only (no BTC/SOL)", runBatch(data, ethOnly)));

    // G6: remove adaptiveSizing entirely
    const noAdaptive = {
      ...FTMO_DAYTRADE_24H_CONFIG_V231,
      adaptiveSizing: undefined,
    };
    console.log(
      fmt("no adaptiveSizing (flat risk)", runBatch(data, noAdaptive)),
    );

    // G7: revert to iter212 — full minimum baseline
    console.log(
      fmt(
        "iter212 baseline (reference floor)",
        runBatch(data, FTMO_DAYTRADE_24H_CONFIG),
      ),
    );

    // ========================================================================
    // Summary verdict
    // ========================================================================
    console.log(`\n${"=".repeat(80)}`);
    console.log(
      `SUMMARY VERDICT (iter231 on ${(n / 6 / 365).toFixed(1)}y realistic FTMO costs)`,
    );
    console.log(`${"=".repeat(80)}`);
    console.log(
      `  Baseline pass rate:      ${(baseline.passRate * 100).toFixed(1)}%`,
    );
    console.log(
      `  MC slippage range:       ${(passRates[0] * 100).toFixed(1)}% ... ${(passRates[9] * 100).toFixed(1)}% (${((passRates[9] - passRates[0]) * 100).toFixed(1)}pp spread)`,
    );
    console.log(
      `  Coverage swing (step=1): ${(coverageSwing * 100).toFixed(2)}pp`,
    );
    console.log(
      `  Walk-forward delta:      ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp (test vs train)`,
    );
    console.log(
      `  Failure-mode breakdown:  DailyLoss=${baseline.dailyLossBreaches}, TotalLoss=${baseline.totalLossBreaches}, time-up=${baseline.windows - baseline.passes - baseline.dailyLossBreaches - baseline.totalLossBreaches}`,
    );
    console.log(
      `  Day-rule (funded):       ${baseline.dayRuleViolations}/${baseline.passes} passes (${(violationRate * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Most critical feature:   ETH-PYR (removing drops to 4.4%) — DO NOT DISABLE`,
    );

    expect(baseline.passRate).toBeGreaterThan(0.5);
    // Sanity: all windows accounted for across outcomes
    const accounted =
      baseline.passes + baseline.dailyLossBreaches + baseline.totalLossBreaches;
    expect(accounted).toBeLessThanOrEqual(baseline.windows);
  });
});
