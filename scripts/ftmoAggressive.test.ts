/**
 * FTMO Aggressive Plan + Realistic Costs
 *
 * Rules:
 *   - Profit target: 20% (2× Normal Plan)
 *   - Max daily loss: 5%
 *   - Max total loss: 10%
 *   - Crypto leverage: 1:3 max
 *   - 30 days max
 *
 * Hidden costs modeled:
 *   - Slippage: 10 bp per fill (realistic market-order on FTMO-broker)
 *   - Swap: 5 bp per overnight crossing (CFD typical)
 *   - Total round-trip: ~50-70 bp vs our 30 bp Binance baseline
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

function runBatch(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  barsPerDay: number,
  step = 3,
) {
  const winBars = 30 * barsPerDay;
  const stepBars = step * barsPerDay;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passRate = passes / out.length;
  const avgTrades = out.reduce((s, r) => s + r.trades.length, 0) / out.length;
  const passDays: number[] = [];
  for (const r of out) if (r.passed) passDays.push(r.uniqueTradingDays);
  passDays.sort((a, b) => a - b);
  const medianPassDays =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)] : 0;
  return {
    windows: out.length,
    passes,
    passRate,
    ev: passRate * 0.5 * 16_000 - 249, // aggressive fee ~249, payout ~16k (double reward)
    tradesPerDay: avgTrades / 30,
    medianPassDays,
  };
}

function fmt(label: string, r: ReturnType<typeof runBatch>) {
  return `${label.padEnd(85)} ${r.passes.toString().padStart(3)}/${r.windows}=${(r.passRate * 100).toFixed(1).padStart(5)}%  ${r.tradesPerDay.toFixed(2).padStart(4)}t/d  med=${r.medianPassDays.toString().padStart(2)}d  EV=$${r.ev.toFixed(0).padStart(6)}`;
}

describe(
  "FTMO Aggressive Plan — 20% target + realistic costs",
  { timeout: 900_000 },
  () => {
    it("4h and 1h variants with realistic costs", async () => {
      console.log("\nLoading data...");
      const eth4h = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "4h",
        targetCount: 30000,
        maxPages: 40,
      });
      const btc4h = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "4h",
        targetCount: 30000,
        maxPages: 40,
      });
      const eth1h = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "1h",
        targetCount: 30000,
        maxPages: 40,
      });
      const btc1h = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 30000,
        maxPages: 40,
      });
      const n4h = Math.min(eth4h.length, btc4h.length);
      const n1h = Math.min(eth1h.length, btc1h.length);
      const data4h = { ETHUSDT: eth4h.slice(-n4h), BTCUSDT: btc4h.slice(-n4h) };
      const data1h = { ETHUSDT: eth1h.slice(-n1h), BTCUSDT: btc1h.slice(-n1h) };
      console.log(
        `  4h: ${(n4h / 6 / 365).toFixed(1)}y,  1h: ${(n1h / 24 / 365).toFixed(1)}y\n`,
      );

      // Realistic FTMO asset config: higher cost, slippage, swap
      const realistic = (
        extraCfg: Partial<Daytrade24hAssetCfg> = {},
      ): Daytrade24hAssetCfg => ({
        symbol: "ETHUSDT",
        costBp: 35, // FTMO commission + typical spread (vs 30 bp Binance)
        slippageBp: 10, // per-fill execution slippage
        swapBpPerDay: 5, // overnight swap if crosses UTC midnight
        riskFrac: 1.0,
        ...extraCfg,
      });

      const variants: Array<{
        label: string;
        cfg: FtmoDaytrade24hConfig;
        data: Record<string, Candle[]>;
        bpd: number;
      }> = [];

      // --- 4h AGGRESSIVE with iter211-style (24h hold) ---
      for (const lev of [2, 3]) {
        for (const [stop, tp] of [
          [0.015, 0.1],
          [0.02, 0.12],
          [0.025, 0.15],
          [0.03, 0.18],
        ] as [number, number][]) {
          for (const pyrR of [3, 4, 5]) {
            variants.push({
              label: `4h-AGGR lev=${lev} s=${(stop * 100).toFixed(1)}% tp=${(tp * 100).toFixed(0)}% pyr=${pyrR}`,
              cfg: {
                ...FTMO_DAYTRADE_24H_CONFIG,
                leverage: lev,
                stopPct: stop,
                tpPct: tp,
                holdBars: 6, // 24h
                profitTarget: 0.2, // AGGRESSIVE 20%
                allowedHoursUtc: undefined,
                allowedDowsUtc: undefined,
                assets: [
                  realistic({
                    symbol: "ETH-BASE",
                    sourceSymbol: "ETHUSDT",
                    riskFrac: 1.0,
                  }),
                  realistic({
                    symbol: "ETH-PYR",
                    sourceSymbol: "ETHUSDT",
                    riskFrac: pyrR,
                    minEquityGain: 0.025,
                  }),
                ],
              },
              data: data4h,
              bpd: 6,
            });
          }
        }
      }

      // --- 1h AGGRESSIVE ---
      for (const lev of [2, 3]) {
        for (const [stop, tp] of [
          [0.01, 0.05],
          [0.012, 0.06],
          [0.015, 0.08],
          [0.02, 0.1],
        ] as [number, number][]) {
          for (const pyrR of [3, 5]) {
            for (const hold of [6, 12, 24]) {
              variants.push({
                label: `1h-AGGR lev=${lev} s=${(stop * 100).toFixed(1)}% tp=${(tp * 100).toFixed(0)}% pyr=${pyrR} hold=${hold}h`,
                cfg: {
                  ...FTMO_DAYTRADE_24H_CONFIG,
                  triggerBars: 3,
                  leverage: lev,
                  stopPct: stop,
                  tpPct: tp,
                  holdBars: hold,
                  profitTarget: 0.2,
                  allowedHoursUtc: undefined,
                  allowedDowsUtc: undefined,
                  assets: [
                    realistic({
                      symbol: "ETH-BASE",
                      sourceSymbol: "ETHUSDT",
                      riskFrac: 1.0,
                    }),
                    realistic({
                      symbol: "ETH-PYR",
                      sourceSymbol: "ETHUSDT",
                      riskFrac: pyrR,
                      minEquityGain: 0.03,
                    }),
                  ],
                },
                data: data1h,
                bpd: 24,
              });
            }
          }
        }
      }

      console.log(
        `Testing ${variants.length} aggressive variants with realistic costs...\n`,
      );
      const scored = variants.map((v) => ({
        ...v,
        r: runBatch(v.data, v.cfg, v.bpd),
      }));
      scored.sort((a, b) => b.r.passRate - a.r.passRate);

      console.log("--- AGGRESSIVE PLAN (20% target) top 20 ---");
      for (const { label, r } of scored.slice(0, 20))
        console.log(fmt(label, r));

      // 1-4 trades/day range
      const active = scored.filter(
        (s) => s.r.tradesPerDay >= 0.5 && s.r.tradesPerDay <= 5,
      );
      active.sort((a, b) => b.r.passRate - a.r.passRate);
      console.log(`\n--- 0.5-5 t/d (${active.length}) top 15 ---`);
      for (const { label, r } of active.slice(0, 15))
        console.log(fmt(label, r));

      // 50%+ pass
      const high = scored.filter((s) => s.r.passRate >= 0.5);
      high.sort((a, b) => b.r.tradesPerDay - a.r.tradesPerDay);
      console.log(`\n--- 50%+ pass rate (${high.length}) ---`);
      for (const { label, r } of high.slice(0, 10)) console.log(fmt(label, r));

      expect(true).toBe(true);
    });
  },
);
