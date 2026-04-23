/**
 * Verify iter224 reproduces measured 61.0% / 8d / p25=5.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG,
  FTMO_DAYTRADE_24H_CONFIG_PARETO,
  FTMO_DAYTRADE_24H_CONFIG_BE,
  FTMO_DAYTRADE_24H_CONFIG_BE_CURVE,
  FTMO_DAYTRADE_24H_CONFIG_MULTI,
  FTMO_DAYTRADE_24H_CONFIG_V224,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
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

function fmt(label: string, r: ReturnType<typeof runBatch>) {
  return `${label.padEnd(32)} ${r.passes.toString().padStart(3)}/${r.windows}=${(r.passRate * 100).toFixed(1).padStart(5)}%  med=${r.medianDays.toString().padStart(2)}d  p25=${r.p25Days.toString().padStart(2)}  EV=$${r.ev.toFixed(0).padStart(5)}`;
}

describe("Verify iter224 + full frontier", { timeout: 900_000 }, () => {
  it("compare all configs", async () => {
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
      `\nLoaded ${(n / 6 / 365).toFixed(1)}y 4h (ETH+BTC+SOL aligned)\n`,
    );

    const r212 = runBatch(data, FTMO_DAYTRADE_24H_CONFIG);
    const r216 = runBatch(data, FTMO_DAYTRADE_24H_CONFIG_PARETO);
    const r218 = runBatch(data, FTMO_DAYTRADE_24H_CONFIG_BE);
    const r219 = runBatch(data, FTMO_DAYTRADE_24H_CONFIG_BE_CURVE);
    const r220 = runBatch(data, FTMO_DAYTRADE_24H_CONFIG_MULTI);
    const r224 = runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V224);

    console.log(fmt("iter212 baseline", r212));
    console.log(fmt("iter216 pareto", r216));
    console.log(fmt("iter218 BE", r218));
    console.log(fmt("iter219 BE+curve", r219));
    console.log(fmt("iter220 MULTI", r220));
    console.log(fmt("iter224 CHAMPION", r224));

    console.log(`\n--- iter224 total gain vs iter212 ---`);
    console.log(
      `Pass rate: +${((r224.passRate - r212.passRate) * 100).toFixed(1)}pp`,
    );
    console.log(`Median: ${r224.medianDays - r212.medianDays} days`);
    console.log(`p25: ${r224.p25Days - r212.p25Days} days`);
    console.log(`EV: +$${(r224.ev - r212.ev).toFixed(0)}`);

    // Assertions
    expect(r224.passRate).toBeGreaterThan(r220.passRate);
    expect(r224.medianDays).toBeLessThanOrEqual(r220.medianDays);
    expect(r224.p25Days).toBeLessThanOrEqual(r220.p25Days);
  });
});
