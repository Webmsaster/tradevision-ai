import { describe, it, expect } from "vitest";
import { FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT } from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { findBestLiveSafe } from "./_liveSafeSweepHelper";

describe("Live-safe 1h tuning (V7 base)", { timeout: 1500_000 }, () => {
  it("finds best 1h config under live caps", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "1h",
      targetCount: 60000,
      maxPages: 60,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1h",
      targetCount: 60000,
      maxPages: 60,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "1h",
      targetCount: 60000,
      maxPages: 60,
    });
    const n = Math.min(eth.length, btc.length, sol.length);
    const data = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
    };
    console.log(
      `\n=== 1h Live-Safe Sweep — ${(n / 24 / 365).toFixed(2)}y / ${n} bars ===`,
    );
    const { finalResult, label } = findBestLiveSafe(
      FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
      data,
      1,
    );
    console.log(`\nLIVE_1H_V1 = ${label}`);
    console.log(
      `  pass=${(finalResult.passRate * 100).toFixed(2)}% med=${finalResult.medianDays}d p90=${finalResult.p90Days}d EV=$${finalResult.ev.toFixed(0)}`,
    );
    expect(finalResult.passRate).toBeGreaterThanOrEqual(0);
  });
});
