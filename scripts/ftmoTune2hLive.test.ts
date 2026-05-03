import { describe, it, expect } from "vitest";
import { FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT } from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { findBestLiveSafe } from "./_liveSafeSweepHelper";

describe("Live-safe 2h tuning (V6/V261_2H base)", { timeout: 1500_000 }, () => {
  it("finds best 2h config under live caps", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "2h",
      targetCount: 30000,
      maxPages: 40,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "2h",
      targetCount: 30000,
      maxPages: 40,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "2h",
      targetCount: 30000,
      maxPages: 40,
    });
    const n = Math.min(eth.length, btc.length, sol.length);
    const data = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
    };
    console.log(
      `\n=== 2h Live-Safe Sweep — ${(n / 12 / 365).toFixed(2)}y / ${n} bars ===`,
    );
    const { finalResult, label } = findBestLiveSafe(
      FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
      data,
      2,
    );
    console.log(`\nLIVE_2H_V1 = ${label}`);
    console.log(
      `  pass=${(finalResult.passRate * 100).toFixed(2)}% med=${finalResult.medianDays}d p90=${finalResult.p90Days}d EV=$${finalResult.ev.toFixed(0)}`,
    );
    expect(finalResult.passRate).toBeGreaterThanOrEqual(0);
  });
});
