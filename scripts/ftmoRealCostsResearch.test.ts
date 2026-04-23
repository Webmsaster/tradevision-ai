/**
 * Test iter231 with asset-specific REAL FTMO costs (from research on
 * FTMO's official trading conditions + third-party data, 2025-2026).
 *
 * Real FTMO crypto costs (per round-trip, basis points):
 *   Commission: 0.0325% per side = 6.5bp RT on all crypto
 *   BTCUSD spread (weekday): ~$10-12 ≈ 3bp at BTC $77k
 *   ETHUSD spread (weekday): ~$1-1.5 ≈ 12bp at ETH $2300
 *   SOLUSD spread: new pair, no public data (est 20-25bp)
 *   Weekend spread: 3-5× wider than weekday
 *   Swap: dynamic, public data not available (est 3-10bp/day)
 *   Slippage: live-only, est 5-15bp per fill
 *
 * Scenarios tested:
 *   A. FTMO weekday (optimistic realistic): BTC=10/5/3, ETH=20/7/5, SOL=27/8/5
 *   B. FTMO realistic (mid): BTC=15/10/5, ETH=25/10/5, SOL=35/12/7
 *   C. FTMO pessimistic (weekend-heavy): BTC=30/15/8, ETH=45/15/10, SOL=55/15/10
 *   D. Current conservative baseline: all 35/10/5 (my original model)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V231,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

interface PerAssetCost {
  costBp: number; // commission + spread
  slippageBp: number;
  swapBpPerDay: number;
}

interface CostScenario {
  name: string;
  btc: PerAssetCost;
  eth: PerAssetCost;
  sol: PerAssetCost;
}

function applyScenario(
  cfg: FtmoDaytrade24hConfig,
  sc: CostScenario,
): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    assets: cfg.assets.map((a): Daytrade24hAssetCfg => {
      const perAsset =
        a.sourceSymbol === "BTCUSDT"
          ? sc.btc
          : a.sourceSymbol === "SOLUSDT"
            ? sc.sol
            : sc.eth;
      return { ...a, ...perAsset };
    }),
  };
}

interface BatchResult {
  windows: number;
  passes: number;
  passRate: number;
  ev: number;
  medianDays: number;
  p25Days: number;
  dailyLossBreaches: number;
  totalLossBreaches: number;
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
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  let dailyLossBreaches = 0;
  let totalLossBreaches = 0;
  for (const r of out) {
    if (r.reason === "daily_loss") dailyLossBreaches++;
    if (r.reason === "total_loss") totalLossBreaches++;
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  }
  passDays.sort((a, b) => a - b);
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
    medianDays: passDays[Math.floor(passDays.length * 0.5)] ?? 0,
    p25Days: passDays[Math.floor(passDays.length * 0.25)] ?? 0,
    dailyLossBreaches,
    totalLossBreaches,
  };
}

function fmt(label: string, r: BatchResult): string {
  return `${label.padEnd(52)} ${r.passes.toString().padStart(3)}/${r.windows}=${(r.passRate * 100).toFixed(1).padStart(5)}%  med=${r.medianDays.toString().padStart(2)}d  p25=${r.p25Days.toString().padStart(2)}  EV=$${r.ev.toFixed(0).padStart(5)}  DL=${r.dailyLossBreaches} TL=${r.totalLossBreaches}`;
}

describe(
  "iter231 with asset-specific REAL FTMO costs",
  { timeout: 900_000 },
  () => {
    it("compare scenarios based on published FTMO data", async () => {
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
        `\nLoaded ${(n / 6 / 365).toFixed(1)}y 4h ETH+BTC+SOL aligned\n`,
      );

      const scenarios: CostScenario[] = [
        {
          name: "A. FTMO WEEKDAY (research-based)",
          btc: { costBp: 10, slippageBp: 5, swapBpPerDay: 3 }, // commission 6.5 + spread 3 + buffer
          eth: { costBp: 20, slippageBp: 7, swapBpPerDay: 5 }, // commission 6.5 + spread 12
          sol: { costBp: 27, slippageBp: 8, swapBpPerDay: 5 }, // commission 6.5 + estimated 20
        },
        {
          name: "B. FTMO REALISTIC (mid, most likely)",
          btc: { costBp: 15, slippageBp: 10, swapBpPerDay: 5 },
          eth: { costBp: 25, slippageBp: 10, swapBpPerDay: 5 },
          sol: { costBp: 35, slippageBp: 12, swapBpPerDay: 7 },
        },
        {
          name: "C. FTMO PESSIMISTIC (weekend + high-slip)",
          btc: { costBp: 30, slippageBp: 15, swapBpPerDay: 8 },
          eth: { costBp: 45, slippageBp: 15, swapBpPerDay: 10 },
          sol: { costBp: 55, slippageBp: 15, swapBpPerDay: 10 },
        },
        {
          name: "D. MY ORIGINAL MODEL (conservative)",
          btc: { costBp: 35, slippageBp: 10, swapBpPerDay: 5 },
          eth: { costBp: 35, slippageBp: 10, swapBpPerDay: 5 },
          sol: { costBp: 35, slippageBp: 10, swapBpPerDay: 5 },
        },
      ];

      console.log("=== Pass rate per scenario ===");
      console.log(
        "(BTC=cost/slip/swap, ETH=cost/slip/swap, SOL=cost/slip/swap)",
      );
      console.log();
      for (const sc of scenarios) {
        const cfg = applyScenario(FTMO_DAYTRADE_24H_CONFIG_V231, sc);
        const r = runBatch(data, cfg);
        const costStr = `[BTC ${sc.btc.costBp}/${sc.btc.slippageBp}/${sc.btc.swapBpPerDay} · ETH ${sc.eth.costBp}/${sc.eth.slippageBp}/${sc.eth.swapBpPerDay} · SOL ${sc.sol.costBp}/${sc.sol.slippageBp}/${sc.sol.swapBpPerDay}]`;
        console.log(fmt(sc.name, r));
        console.log(`   ${costStr}`);
        console.log();
      }

      // Walk-forward for the most likely scenario (B)
      console.log("\n=== Walk-forward on scenario B (realistic) ===");
      const sB = scenarios[1];
      const cfgB = applyScenario(FTMO_DAYTRADE_24H_CONFIG_V231, sB);
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
      console.log(fmt("Train (older 2.9y)", runBatch(dataTrain, cfgB)));
      console.log(fmt("Test (newer 2.9y)", runBatch(dataTest, cfgB)));

      // Year-by-year on scenario B
      console.log("\n=== Year-by-year on scenario B (realistic) ===");
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
        const rY = runBatch(slice, cfgB);
        const start = new Date(slice.ETHUSDT[0].openTime)
          .toISOString()
          .slice(0, 7);
        const end = new Date(slice.ETHUSDT[slice.ETHUSDT.length - 1].openTime)
          .toISOString()
          .slice(0, 7);
        const btcStart = slice.BTCUSDT[0].close;
        const btcEnd = slice.BTCUSDT[slice.BTCUSDT.length - 1].close;
        const btcReturn = (btcEnd - btcStart) / btcStart;
        const regimeLabel =
          btcReturn > 0.3 ? "BULL" : btcReturn < -0.15 ? "BEAR" : "CHOP";
        console.log(
          `Year ${y + 1} [${regimeLabel} ${(btcReturn * 100).toFixed(0)}%] ${start}→${end}: ${(rY.passRate * 100).toFixed(1)}% (${rY.passes}/${rY.windows}) med=${rY.medianDays}d TL=${rY.totalLossBreaches}`,
        );
      }

      // Verdict
      console.log("\n" + "=".repeat(80));
      console.log("VERDICT — real FTMO expected pass rate");
      console.log("=".repeat(80));
      console.log();
      console.log(
        "Based on FTMO's published commission (0.0325% / side = 6.5bp RT) +",
      );
      console.log(
        "published spread data (BTC ~$10, ETH ~$1) + conservative slippage/swap:",
      );
      console.log();

      const resA = runBatch(
        data,
        applyScenario(FTMO_DAYTRADE_24H_CONFIG_V231, scenarios[0]),
      );
      const resB = runBatch(
        data,
        applyScenario(FTMO_DAYTRADE_24H_CONFIG_V231, scenarios[1]),
      );
      const resC = runBatch(
        data,
        applyScenario(FTMO_DAYTRADE_24H_CONFIG_V231, scenarios[2]),
      );
      const resD = runBatch(
        data,
        applyScenario(FTMO_DAYTRADE_24H_CONFIG_V231, scenarios[3]),
      );

      console.log(
        `  Best case (weekday, low slip):     ${(resA.passRate * 100).toFixed(1)}%`,
      );
      console.log(
        `  Realistic (most likely):           ${(resB.passRate * 100).toFixed(1)}% ← EXPECTED RANGE`,
      );
      console.log(
        `  Pessimistic (weekend + high slip): ${(resC.passRate * 100).toFixed(1)}%`,
      );
      console.log(
        `  Conservative (my original 60bp):   ${(resD.passRate * 100).toFixed(1)}%`,
      );
      console.log();
      console.log(
        `→ Live pass rate likely in ${(resC.passRate * 100).toFixed(0)}-${(resA.passRate * 100).toFixed(0)}% range.`,
      );
      console.log(
        `→ My 62.6% was conservative. Realistic expectation: ${(resB.passRate * 100).toFixed(0)}%.`,
      );
      console.log();
      console.log(
        "MUST verify live: slippage per trade, actual swap rates, SOL-specific spreads.",
      );

      expect(resA.passRate).toBeGreaterThanOrEqual(resB.passRate);
      expect(resB.passRate).toBeGreaterThanOrEqual(resC.passRate);
    });
  },
);
