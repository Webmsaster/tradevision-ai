/**
 * V7 Phase: peakDrawdownThrottle + drawdownShield + multi-asset.
 *
 * Multi-asset base from V6 (ETH+BTC+SOL+BNB+ADA) PLUS the two
 * drawdown-protection engine features. Goal: shave the 131 TL-breaches.
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

const EXTRA = ["BNBUSDT", "ADAUSDT"] as const;

describe(
  "15m V7 — drawdown-throttle + multi-asset",
  { timeout: 1800_000 },
  () => {
    it("attacks TL breaches with peak-relative throttle", async () => {
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
      const n = Math.min(
        eth.length,
        btc.length,
        sol.length,
        bnb.length,
        ada.length,
      );
      const data: Record<string, Candle[]> = {
        ETHUSDT: eth.slice(-n),
        BTCUSDT: btc.slice(-n),
        SOLUSDT: sol.slice(-n),
        BNBUSDT: bnb.slice(-n),
        ADAUSDT: ada.slice(-n),
      };
      console.log(
        `\n=== 15m V7 — ${(n / 96 / 365).toFixed(2)}y / ${n} bars / 5 assets ===`,
      );

      const ethMr = FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2.assets.find(
        (a) => a.symbol === "ETH-MR",
      )!;
      const makeAsset = (sym: string, source: string): Daytrade24hAssetCfg => ({
        ...ethMr,
        symbol: `${sym}-MR`,
        sourceSymbol: source,
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
          makeAsset("BNB", "BNBUSDT"),
          makeAsset("ADA", "ADAUSDT"),
        ],
        liveCaps: LIVE_CAPS,
      };
      const baseR = runWalkForward(data, v6Base, 0.25);
      console.log(fmt("V6 BASELINE", baseR));

      // R1: peakDrawdownThrottle sweep
      console.log(`\n--- R1: peakDrawdownThrottle ---`);
      let r1Best = { cfg: v6Base, r: baseR };
      for (const fp of [0.02, 0.025, 0.03, 0.04, 0.05, 0.06]) {
        for (const f of [0, 0.1, 0.25, 0.4, 0.5]) {
          const cfg = {
            ...v6Base,
            peakDrawdownThrottle: { fromPeak: fp, factor: f },
          };
          const r = runWalkForward(data, cfg, 0.25);
          if (score(r, r1Best.r) < 0) {
            r1Best = { cfg, r };
            console.log(fmt(`  pdt fp=${fp} f=${f}`, r));
          }
        }
      }
      console.log(fmt("R1 winner", r1Best.r));

      // R2: drawdownShield (absolute)
      console.log(`\n--- R2: drawdownShield ---`);
      let r2Best = { cfg: r1Best.cfg, r: r1Best.r };
      for (const be of [-0.04, -0.03, -0.02, -0.01]) {
        for (const f of [0, 0.1, 0.25, 0.4]) {
          const cfg = {
            ...r1Best.cfg,
            drawdownShield: { belowEquity: be, factor: f },
          };
          const r = runWalkForward(data, cfg, 0.25);
          if (score(r, r2Best.r) < 0) {
            r2Best = { cfg, r };
            console.log(fmt(`  dds be=${be} f=${f}`, r));
          }
        }
      }
      console.log(fmt("R2 winner", r2Best.r));

      // R3: combined PTP fine-grain on the new base
      console.log(`\n--- R3: PTP fine-grain on V6+throttle ---`);
      let r3Best = { cfg: r2Best.cfg, r: r2Best.r };
      for (const trigger of [0.005, 0.008, 0.01, 0.012, 0.015, 0.02, 0.025]) {
        for (const frac of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
          const cfg = {
            ...r2Best.cfg,
            partialTakeProfit: { triggerPct: trigger, closeFraction: frac },
          };
          const r = runWalkForward(data, cfg, 0.25);
          if (score(r, r3Best.r) < 0) {
            r3Best = { cfg, r };
            console.log(fmt(`  PTP t=${trigger} f=${frac}`, r));
          }
        }
      }
      console.log(fmt("R3 winner", r3Best.r));

      console.log(`\n========== V7 FINAL ==========`);
      console.log(fmt("V6 baseline", baseR));
      console.log(fmt("V7 final   ", r3Best.r));
      console.log(
        `Δ V6→V7: +${((r3Best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${r3Best.r.p90Days - baseR.p90Days}d p90`,
      );
      console.log(`\nFinal config:`);
      console.log(
        JSON.stringify(
          {
            peakDrawdownThrottle: r3Best.cfg.peakDrawdownThrottle,
            drawdownShield: r3Best.cfg.drawdownShield,
            partialTakeProfit: r3Best.cfg.partialTakeProfit,
          },
          null,
          2,
        ),
      );
      expect(r3Best.r.passRate).toBeGreaterThan(0);
    });
  },
);
