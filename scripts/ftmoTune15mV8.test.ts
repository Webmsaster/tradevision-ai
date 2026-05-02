/**
 * V8 Phase: more assets — XRP, LTC, DOT, BCH on top of V6's 5-asset stack.
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

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

const NEW = [
  "XRPUSDT",
  "LTCUSDT",
  "DOTUSDT",
  "BCHUSDT",
  "MATICUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
] as const;

describe("15m V8 — extended multi-asset", { timeout: 1800_000 }, () => {
  it("greedy add of more crypto pairs", async () => {
    const targetCount = 250000;
    const maxPages = 250;
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
    const bnb = await loadBinanceHistory({
      symbol: "BNBUSDT",
      timeframe: "15m",
      targetCount,
      maxPages,
    });
    const ada = await loadBinanceHistory({
      symbol: "ADAUSDT",
      timeframe: "15m",
      targetCount,
      maxPages,
    });
    const newCandles: Record<string, Candle[]> = {};
    for (const sym of NEW) {
      newCandles[sym] = await loadBinanceHistory({
        symbol: sym,
        timeframe: "15m",
        targetCount,
        maxPages,
      });
      console.log(`  ${sym}: ${newCandles[sym].length} bars`);
    }
    const all = [
      eth.length,
      btc.length,
      sol.length,
      bnb.length,
      ada.length,
      ...NEW.map((s) => newCandles[s].length),
    ];
    const n = Math.min(...all);
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
      BNBUSDT: bnb.slice(-n),
      ADAUSDT: ada.slice(-n),
    };
    for (const sym of NEW) data[sym] = newCandles[sym].slice(-n);
    console.log(`Aligned: ${n} bars (${(n / 96 / 365).toFixed(2)}y)\n`);

    const ethMr = FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2.assets.find(
      (a) => a.symbol === "ETH-MR",
    )!;
    const makeAsset = (sym: string): Daytrade24hAssetCfg => ({
      ...ethMr,
      symbol: `${sym.replace("USDT", "")}-MR`,
      sourceSymbol: sym,
      minEquityGain: 0.02,
      triggerBars: 1,
      riskFrac: 1.0,
    });
    const v6Base: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
      crossAssetFilter: {
        ...(FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2.crossAssetFilter as any),
        momSkipShortAbove: 0.005,
        momentumBars: 6,
      },
      assets: [
        ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2.assets,
        makeAsset("BNBUSDT"),
        makeAsset("ADAUSDT"),
      ],
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, v6Base, 0.25);
    console.log(fmt("V6 BASELINE (5 assets)", baseR));

    // Greedy add: try each new sym, pick best, repeat
    console.log(`\n--- greedy add ---`);
    let cur = v6Base;
    let curR = baseR;
    let candidates = [...NEW];
    const picked: string[] = [];
    while (true) {
      let stepBest: { cfg: FtmoDaytrade24hConfig; r: any; sym: string } | null =
        null;
      for (const sym of candidates) {
        const trial: FtmoDaytrade24hConfig = {
          ...cur,
          assets: [...cur.assets, makeAsset(sym)],
        };
        const r = runWalkForward(data, trial, 0.25);
        if (score(r, curR) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0) {
            stepBest = { cfg: trial, r, sym };
          }
        }
      }
      if (stepBest === null) break;
      cur = stepBest.cfg;
      curR = stepBest.r;
      candidates = candidates.filter((s) => s !== stepBest!.sym);
      picked.push(stepBest.sym);
      console.log(fmt(`  +${stepBest.sym} (${picked.length})`, stepBest.r));
    }

    console.log(`\n========== V8 FINAL ==========`);
    console.log(fmt("V6 baseline", baseR));
    console.log(fmt("V8 final   ", curR));
    console.log(
      `Δ V6→V8: +${((curR.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${curR.p90Days - baseR.p90Days}d p90`,
    );
    console.log(`Picked: ${picked.join(", ")}`);
    expect(curR.passRate).toBeGreaterThan(0);
  });
});
