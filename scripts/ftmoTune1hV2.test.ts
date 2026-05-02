import { describe, it, expect } from "vitest";
import { FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1 } from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { aggressiveSweep } from "./_aggressiveSweepHelper";

describe("V2 aggressive sweep — 1h", { timeout: 1800_000 }, () => {
  it("refines LIVE_1H_V1 to V2", async () => {
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
      `\n=== 1h V2 Aggressive Sweep — ${(n / 24 / 365).toFixed(2)}y / ${n} bars ===`,
    );
    const { finalCfg, finalResult } = aggressiveSweep(
      FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
      data,
      1,
    );
    console.log(
      `\nLIVE_1H_V2 final: ${(finalResult.passRate * 100).toFixed(2)}% / med ${finalResult.medianDays}d / p90 ${finalResult.p90Days}d / EV $${finalResult.ev.toFixed(0)}`,
    );
    console.log(
      `Config: ${JSON.stringify({ allowedHoursUtc: finalCfg.allowedHoursUtc, atrStop: finalCfg.atrStop, lossStreakCooldown: finalCfg.lossStreakCooldown, htfTrendFilter: finalCfg.htfTrendFilter, chandelierExit: finalCfg.chandelierExit, partialTakeProfit: finalCfg.partialTakeProfit, timeBoost: finalCfg.timeBoost })}`,
    );
    expect(finalResult.passRate).toBeGreaterThan(0);
  });
});
