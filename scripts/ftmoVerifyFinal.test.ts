/**
 * Final verification of the entire FTMO config frontier.
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
  FTMO_DAYTRADE_24H_CONFIG_V225,
  FTMO_DAYTRADE_24H_CONFIG_V226,
  FTMO_DAYTRADE_24H_CONFIG_V227,
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
  return `${label.padEnd(40)} ${r.passes.toString().padStart(3)}/${r.windows}=${(r.passRate * 100).toFixed(1).padStart(5)}%  med=${r.medianDays.toString().padStart(2)}d  p25=${r.p25Days.toString().padStart(2)}  EV=$${r.ev.toFixed(0).padStart(5)}`;
}

describe("Verify full FTMO frontier", { timeout: 900_000 }, () => {
  it("all 9 configs", async () => {
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
    console.log(`\n${(n / 6 / 365).toFixed(1)}y 4h ETH+BTC+SOL aligned\n`);

    const results: Array<[string, ReturnType<typeof runBatch>]> = [
      [
        "iter212 baseline (4h ETH mr)",
        runBatch(data, FTMO_DAYTRADE_24H_CONFIG),
      ],
      [
        "iter216 pareto (timeBoost)",
        runBatch(data, FTMO_DAYTRADE_24H_CONFIG_PARETO),
      ],
      ["iter218 BE (+breakEven)", runBatch(data, FTMO_DAYTRADE_24H_CONFIG_BE)],
      [
        "iter219 BE+curve (ETH-only king)",
        runBatch(data, FTMO_DAYTRADE_24H_CONFIG_BE_CURVE),
      ],
      [
        "iter220 MULTI (ETH+BTC+SOL)",
        runBatch(data, FTMO_DAYTRADE_24H_CONFIG_MULTI),
      ],
      ["iter224 5tier+trigBars", runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V224)],
      ["iter225 +24h hold", runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V225)],
      [
        "iter226 +40h hold (MAX EV)",
        runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V226),
      ],
      [
        "iter227 +40h tight (FASTEST)",
        runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V227),
      ],
    ];

    for (const [label, r] of results) console.log(fmt(label, r));

    const r212 = results[0][1],
      r226 = results[7][1];
    console.log(`\nTotal journey iter212 → iter226:`);
    console.log(
      `  Pass: ${(r212.passRate * 100).toFixed(1)}% → ${(r226.passRate * 100).toFixed(1)}% (+${((r226.passRate - r212.passRate) * 100).toFixed(1)}pp)`,
    );
    console.log(
      `  Median: ${r212.medianDays}d → ${r226.medianDays}d (${r226.medianDays - r212.medianDays}d)`,
    );
    console.log(
      `  EV: $${r212.ev.toFixed(0)} → $${r226.ev.toFixed(0)} (+$${(r226.ev - r212.ev).toFixed(0)})`,
    );

    expect(r226.passRate).toBeGreaterThan(r212.passRate);
  });
});
