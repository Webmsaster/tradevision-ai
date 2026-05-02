/**
 * V6 Phase: multi-asset diversification.
 *
 * Strategy plateau at 76% on ETH+BTC+SOL. Adding more crypto MR assets
 * (AVAX/LINK/ADA/DOGE — all on FTMO list) should diversify failure-modes
 * and lift pass-rate.
 *
 * Each new asset: same mean-reversion short trigger as ETH-MR, conservative
 * minEquityGain gate so they only fire after some profit cushion.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

const NEW_ASSETS = [
  "AVAXUSDT",
  "LINKUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "BNBUSDT",
] as const;

describe("15m V6 — multi-asset diversification", { timeout: 1800_000 }, () => {
  it("adds AVAX/LINK/ADA/DOGE/BNB to ETH/BTC/SOL stack", async () => {
    const targetCount = 250000;
    const maxPages = 250;
    console.log(`Loading 15m history for 8 assets...`);
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "15m",
      targetCount,
      maxPages,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount,
      maxPages,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "15m",
      targetCount,
      maxPages,
    });
    const newCandles: Record<string, Candle[]> = {};
    for (const sym of NEW_ASSETS) {
      newCandles[sym] = await loadBinanceHistory({
        symbol: sym,
        timeframe: "15m",
        targetCount,
        maxPages,
      });
      console.log(
        `  ${sym}: ${newCandles[sym].length} bars (${(newCandles[sym].length / 96 / 365).toFixed(2)}y)`,
      );
    }

    const allLengths = [
      eth.length,
      btc.length,
      sol.length,
      ...NEW_ASSETS.map((s) => newCandles[s].length),
    ];
    const n = Math.min(...allLengths);
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
    };
    for (const sym of NEW_ASSETS) data[sym] = newCandles[sym].slice(-n);
    console.log(`Aligned: ${n} bars (${(n / 96 / 365).toFixed(2)}y)\n`);

    const v2Cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
      crossAssetFilter: {
        ...(FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2.crossAssetFilter as any),
        momSkipShortAbove: 0.005,
        momentumBars: 6,
      },
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, v2Cur, 0.25);
    console.log(fmt("V5 BASELINE (3 assets)", baseR));

    // R1: Try adding each new asset individually (compare incremental gain)
    console.log(`\n--- R1: single-asset additions ---`);
    const ethMr = v2Cur.assets.find((a) => a.symbol === "ETH-MR")!;
    function makeMrAsset(sym: string, source: string) {
      return {
        ...ethMr,
        symbol: `${sym}-MR`,
        sourceSymbol: source,
        minEquityGain: 0.02,
        triggerBars: 1,
        riskFrac: 1.0,
      };
    }
    let r1Best = { cfg: v2Cur, r: baseR };
    for (const sym of NEW_ASSETS) {
      const newAsset = makeMrAsset(sym.replace("USDT", ""), sym);
      const cfg: FtmoDaytrade24hConfig = {
        ...v2Cur,
        assets: [...v2Cur.assets, newAsset],
      };
      const r = runWalkForward(data, cfg, 0.25);
      console.log(fmt(`  +${sym}`, r));
      if (score(r, r1Best.r) < 0) {
        r1Best = { cfg, r };
      }
    }
    console.log(fmt("R1 best (1 asset added)", r1Best.r));

    // R2: All 5 added at once
    console.log(`\n--- R2: all 5 added simultaneously ---`);
    const allAdded: FtmoDaytrade24hConfig = {
      ...v2Cur,
      assets: [
        ...v2Cur.assets,
        ...NEW_ASSETS.map((s) => makeMrAsset(s.replace("USDT", ""), s)),
      ],
    };
    const allR = runWalkForward(data, allAdded, 0.25);
    console.log(fmt("All 5 added", allR));

    // R3: Best subset — try various combos
    console.log(`\n--- R3: subset search (greedy add) ---`);
    let r3Best = { cfg: v2Cur, r: baseR };
    let pickedSyms: string[] = [];
    let candidatePool = [...NEW_ASSETS];
    for (let pass = 0; pass < 5; pass++) {
      let stepBest: { cfg: FtmoDaytrade24hConfig; r: any; sym: string } | null =
        null;
      for (const sym of candidatePool) {
        const trial: FtmoDaytrade24hConfig = {
          ...r3Best.cfg,
          assets: [
            ...r3Best.cfg.assets,
            makeMrAsset(sym.replace("USDT", ""), sym),
          ],
        };
        const r = runWalkForward(data, trial, 0.25);
        if (score(r, r3Best.r) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0) {
            stepBest = { cfg: trial, r, sym };
          }
        }
      }
      if (stepBest === null) break;
      r3Best = { cfg: stepBest.cfg, r: stepBest.r };
      pickedSyms.push(stepBest.sym);
      candidatePool = candidatePool.filter((s) => s !== stepBest!.sym);
      console.log(
        fmt(`  +${stepBest.sym} (now ${pickedSyms.length} new)`, stepBest.r),
      );
    }
    console.log(`R3 winner: ETH+BTC+SOL + ${pickedSyms.join("+")}`);

    console.log(`\n========== V6 FINAL ==========`);
    console.log(fmt("Baseline (3 assets)", baseR));
    console.log(fmt("R3 winner          ", r3Best.r));
    console.log(
      `Δ: +${((r3Best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${r3Best.r.p90Days - baseR.p90Days}d p90`,
    );

    expect(r3Best.r.passRate).toBeGreaterThan(0);
  });
});
