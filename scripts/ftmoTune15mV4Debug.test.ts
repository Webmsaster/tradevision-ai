/**
 * V4 Debug: force-add ALL long assets and see what they do.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

describe("V4 debug — what do longs actually do?", { timeout: 1800_000 }, () => {
  it("checks long contributions individually", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const bnb = await loadBinanceHistory({
      symbol: "BNBUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const ada = await loadBinanceHistory({
      symbol: "ADAUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const n = Math.min(
      eth.length,
      btc.length,
      sol.length,
      bnb.length,
      ada.length,
    );
    const data = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
      BNBUSDT: bnb.slice(-n),
      ADAUSDT: ada.slice(-n),
    };

    const baseV2: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
      allowedHoursUtc: [0, 2, 5, 12, 13, 14, 19],
      chandelierExit: { period: 14, mult: 4, minMoveR: 0.5 },
      partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.7 },
      timeBoost: { afterDay: 4, equityBelow: 0.07, factor: 3 },
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, baseV2, 0.25);
    console.log(fmt("V2 baseline (shorts)", baseR));

    // Try long ONLY (no shorts) for each asset to see if it has edge alone
    function longAsset(
      sym: string,
      source: string,
      tb: number,
      gate: number,
    ): Daytrade24hAssetCfg {
      return {
        symbol: `${sym}-LONG`,
        sourceSymbol: source,
        costBp: 35,
        slippageBp: 10,
        swapBpPerDay: 5,
        riskFrac: 1.0,
        triggerBars: tb,
        invertDirection: true,
        disableShort: true,
        disableLong: false,
        minEquityGain: gate,
      };
    }

    console.log(`\n--- Long-only configs (no shorts, single asset) ---`);
    for (const a of [
      { sym: "ETH", src: "ETHUSDT" },
      { sym: "BTC", src: "BTCUSDT" },
      { sym: "SOL", src: "SOLUSDT" },
    ]) {
      for (const tb of [1, 2, 3]) {
        const longOnlyCfg: FtmoDaytrade24hConfig = {
          ...baseV2,
          assets: [longAsset(a.sym, a.src, tb, 0)],
          // Disable cross-asset filter for longs (BTC uptrend doesn't apply)
          crossAssetFilter: undefined,
        };
        const r = runWalkForward(data, longOnlyCfg, 0.25);
        console.log(fmt(`  ${a.sym}-LONG tb=${tb}`, r));
      }
    }

    // Try shorts + 1 long combined, no caf for longs
    console.log(
      `\n--- Short + Long combos (with cross-asset filter for shorts only) ---`,
    );
    for (const a of [
      { sym: "ETH", src: "ETHUSDT" },
      { sym: "BTC", src: "BTCUSDT" },
    ]) {
      for (const tb of [1, 2, 3]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...baseV2,
          assets: [...baseV2.assets, longAsset(a.sym, a.src, tb, 0.005)],
        };
        const r = runWalkForward(data, cfg, 0.25);
        console.log(fmt(`  +${a.sym}-LONG tb=${tb} gate=0.005`, r));
      }
    }

    // Also try invertDirection=false (= 2 reds → long, MR-LONG)
    console.log(
      `\n--- MR-LONG variant (invertDirection=false, 2 reds → long) ---`,
    );
    for (const a of [
      { sym: "ETH", src: "ETHUSDT" },
      { sym: "BTC", src: "BTCUSDT" },
    ]) {
      for (const tb of [1, 2, 3]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...baseV2,
          assets: [
            ...baseV2.assets,
            {
              ...longAsset(a.sym, a.src, tb, 0.005),
              invertDirection: false,
            },
          ],
        };
        const r = runWalkForward(data, cfg, 0.25);
        console.log(fmt(`  +${a.sym}-MR-LONG tb=${tb}`, r));
      }
    }

    expect(baseR.passRate).toBeGreaterThan(0);
  });
});
