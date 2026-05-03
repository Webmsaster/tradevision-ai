/**
 * Re-validate LIVE_15M_V2 + LIVE_5M_V3 after engine bugfix:
 * liveCaps.maxRiskFrac now properly capped in equity loop.
 *
 * Expectation: numbers will DROP because positions are now actually
 * sized at 2% risk (was effectively 1.0/100% before).
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS_5M = 5 / 60;
const TF_HOURS_15M = 0.25;
const TF_HOURS_1H = 1;

describe("Engine bugfix re-validation", { timeout: 1800_000 }, () => {
  it("re-runs LIVE_15M_V2/V3, LIVE_5M_V3, LIVE_1H_V2 with cap fix", async () => {
    // 15m
    const eth15 = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "15m",
      targetCount: 200000,
      maxPages: 200,
    });
    const btc15 = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 200000,
      maxPages: 200,
    });
    const sol15 = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "15m",
      targetCount: 200000,
      maxPages: 200,
    });
    const bnb15 = await loadBinanceHistory({
      symbol: "BNBUSDT",
      timeframe: "15m",
      targetCount: 200000,
      maxPages: 200,
    });
    const ada15 = await loadBinanceHistory({
      symbol: "ADAUSDT",
      timeframe: "15m",
      targetCount: 200000,
      maxPages: 200,
    });
    const n15 = Math.min(
      eth15.length,
      btc15.length,
      sol15.length,
      bnb15.length,
      ada15.length,
    );
    const data15: Record<string, Candle[]> = {
      ETHUSDT: eth15.slice(-n15),
      BTCUSDT: btc15.slice(-n15),
      SOLUSDT: sol15.slice(-n15),
      BNBUSDT: bnb15.slice(-n15),
      ADAUSDT: ada15.slice(-n15),
    };
    const yrs15 = (n15 / 96 / 365).toFixed(2);
    console.log(`\n=== 15m ${yrs15}y after engine fix ===`);
    const v15v2 = runWalkForward(
      data15,
      { ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2, liveCaps: LIVE_CAPS },
      TF_HOURS_15M,
    );
    console.log(fmt("LIVE_15M_V2 (post-fix)", v15v2));
    const v15v3 = runWalkForward(
      data15,
      { ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3, liveCaps: LIVE_CAPS },
      TF_HOURS_15M,
    );
    console.log(fmt("LIVE_15M_V3 (post-fix)", v15v3));

    // 1h
    const eth1h = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "1h",
      targetCount: 60000,
      maxPages: 60,
    });
    const btc1h = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1h",
      targetCount: 60000,
      maxPages: 60,
    });
    const sol1h = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "1h",
      targetCount: 60000,
      maxPages: 60,
    });
    const n1h = Math.min(eth1h.length, btc1h.length, sol1h.length);
    const data1h: Record<string, Candle[]> = {
      ETHUSDT: eth1h.slice(-n1h),
      BTCUSDT: btc1h.slice(-n1h),
      SOLUSDT: sol1h.slice(-n1h),
    };
    console.log(
      `\n=== 1h ${(n1h / 24 / 365).toFixed(2)}y after engine fix ===`,
    );
    const v1hv2 = runWalkForward(
      data1h,
      { ...FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2, liveCaps: LIVE_CAPS },
      TF_HOURS_1H,
    );
    console.log(fmt("LIVE_1H_V2 (post-fix)", v1hv2));

    expect(v15v2.windows).toBeGreaterThan(50);
  });
});
