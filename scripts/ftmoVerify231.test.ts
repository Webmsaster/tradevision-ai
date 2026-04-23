/**
 * Final verify iter231 — full frontier + walk-forward + year-by-year.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG,
  FTMO_DAYTRADE_24H_CONFIG_V228,
  FTMO_DAYTRADE_24H_CONFIG_V229,
  FTMO_DAYTRADE_24H_CONFIG_V230,
  FTMO_DAYTRADE_24H_CONFIG_V231,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

function runBatch(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  step = 3,
) {
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
  for (const r of out)
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  passDays.sort((a, b) => a - b);
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
    medianDays: passDays[Math.floor(passDays.length * 0.5)] ?? 0,
    p25Days: passDays[Math.floor(passDays.length * 0.25)] ?? 0,
  };
}

function withRealCosts(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    assets: cfg.assets.map(
      (a): Daytrade24hAssetCfg => ({
        ...a,
        costBp: 35,
        slippageBp: 10,
        swapBpPerDay: 5,
      }),
    ),
  };
}

function fmt(label: string, r: ReturnType<typeof runBatch>) {
  return `${label.padEnd(42)} ${r.passes.toString().padStart(3)}/${r.windows}=${(r.passRate * 100).toFixed(1).padStart(5)}%  med=${r.medianDays.toString().padStart(2)}d  p25=${r.p25Days.toString().padStart(2)}  EV=$${r.ev.toFixed(0).padStart(5)}`;
}

describe("Final iter231 verification", { timeout: 900_000 }, () => {
  it("full comparison", async () => {
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
    console.log(`\n${(n / 6 / 365).toFixed(1)}y 4h — REALISTIC FTMO COSTS\n`);

    console.log("=== FINAL JOURNEY ===");
    const results: Array<[string, ReturnType<typeof runBatch>]> = [
      [
        "iter212 (start)",
        runBatch(data, withRealCosts(FTMO_DAYTRADE_24H_CONFIG)),
      ],
      ["iter228 cost-opt", runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V228)],
      ["iter229 earlyPyr", runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V229)],
      ["iter230 timeBoost", runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V230)],
      ["iter231 Kelly (FINAL)", runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V231)],
    ];
    for (const [label, r] of results) console.log(fmt(label, r));

    const r212 = results[0][1],
      r231 = results[4][1];
    console.log(`\nTotal iter212 → iter231:`);
    console.log(
      `  Pass: ${(r212.passRate * 100).toFixed(1)}% → ${(r231.passRate * 100).toFixed(1)}% (+${((r231.passRate - r212.passRate) * 100).toFixed(1)}pp)`,
    );
    console.log(
      `  Median: ${r212.medianDays}d → ${r231.medianDays}d (${r231.medianDays - r212.medianDays}d)`,
    );
    console.log(
      `  EV: $${r212.ev.toFixed(0)} → $${r231.ev.toFixed(0)} (+$${(r231.ev - r212.ev).toFixed(0)})`,
    );

    // Walk-forward on iter231
    const half = Math.floor(n / 2);
    const dataTrain = {
      ETHUSDT: eth.slice(-n).slice(0, half),
      BTCUSDT: btc.slice(-n).slice(0, half),
      SOLUSDT: sol.slice(-n).slice(0, half),
    };
    const dataTest = {
      ETHUSDT: eth.slice(-n).slice(half),
      BTCUSDT: btc.slice(-n).slice(half),
      SOLUSDT: sol.slice(-n).slice(half),
    };
    const rTrain = runBatch(dataTrain, FTMO_DAYTRADE_24H_CONFIG_V231);
    const rTest = runBatch(dataTest, FTMO_DAYTRADE_24H_CONFIG_V231);
    console.log(`\n=== iter231 WALK-FORWARD ===`);
    console.log(fmt("Train (older 2.9y)", rTrain));
    console.log(fmt("Test (newer 2.9y)", rTest));
    console.log(
      `Delta: ${((rTest.passRate - rTrain.passRate) * 100).toFixed(1)}pp`,
    );

    // Year-by-year iter231
    console.log(`\n=== iter231 YEAR-BY-YEAR ===`);
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
      const start = new Date(slice.ETHUSDT[0].openTime)
        .toISOString()
        .slice(0, 10);
      const end = new Date(slice.ETHUSDT[slice.ETHUSDT.length - 1].openTime)
        .toISOString()
        .slice(0, 10);
      console.log(
        `Year ${y + 1} (${start}→${end}): ${(rY.passRate * 100).toFixed(1)}% (${rY.passes}/${rY.windows})  med=${rY.medianDays}d`,
      );
    }

    expect(r231.passRate).toBeGreaterThan(r212.passRate);
  });
});
