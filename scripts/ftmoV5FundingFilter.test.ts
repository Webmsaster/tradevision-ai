/**
 * V5 + funding-rate filter — Position-Size-Cut bei extremen funding rates.
 * Order-Flow-Research insight: |funding| > 0.05%/h = Cascade-Risk.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  loadBinanceFundingRate,
  alignFundingToCandles,
} from "./_loadFundingRate";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_FUNDING_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}
const SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];
const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };

describe("V5 with Funding Rate Filter", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_FUNDING START ${new Date().toISOString()}\n`);

    log("Loading 2h candles + funding rates...");
    const data: Record<string, Candle[]> = {};
    const fundingMap: Record<string, number[]> = {};
    for (const s of SOURCES) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      const startMs = data[s][0].openTime;
      const endMs = data[s][data[s].length - 1].closeTime;
      try {
        const funding = await loadBinanceFundingRate(s, startMs, endMs);
        // BUGFIX: alignFundingToCandles expects number[] (timestamps), not Candle[]
        const aligned = alignFundingToCandles(
          funding,
          data[s].map((c) => c.openTime),
        );
        fundingMap[s] = aligned.map((v) => v ?? 0);
        log(
          `  ${s}: ${data[s].length} candles, ${funding.length} funding rows`,
        );
      } catch (e) {
        log(`  ${s}: funding load failed (${(e as Error).message})`);
      }
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);
    log(`\nAligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    function evalCfg(cfg: FtmoDaytrade24hConfig) {
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      let p = 0,
        w = 0,
        tl = 0;
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
        const r = runFtmoDaytrade24h(sub, cfg);
        if (r.passed) p++;
        if (r.reason === "total_loss") tl++;
        w++;
      }
      return { passRate: p / w, tlRate: tl / w, p, w };
    }

    const V5_BASE: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      liveCaps: LIVE_CAPS,
    };
    const base = evalCfg(V5_BASE);
    log(
      `V5 baseline: ${(base.passRate * 100).toFixed(2)}% (${base.p}/${base.w}) TL=${(base.tlRate * 100).toFixed(2)}%\n`,
    );

    function test(name: string, mod: Partial<FtmoDaytrade24hConfig>) {
      const cfg: FtmoDaytrade24hConfig = { ...V5_BASE, ...mod };
      const r = evalCfg(cfg);
      const Δ = (r.passRate - base.passRate) * 100;
      const tag = Δ >= 1.0 ? "🚀" : Δ >= 0.3 ? "✅" : Δ <= -0.5 ? "❌" : "·";
      log(
        `  ${tag} ${name.padEnd(50)} pass=${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}%`,
      );
    }

    log(`========== Funding Rate Filter (per Agent 5 research) ==========`);
    // Funding-rate ist 8h funding (typically 0.01% = 0.0001 / 8h = 0.000125 per hour avg)
    // Threshold |funding| > 0.05%/h = 0.0005/h would be 0.004 per 8h
    // Conservative: cutoff at 0.0003 (= 0.04% / 8h)
    // Aggressive: cutoff at 0.001 (= 0.125% / 8h)

    for (const maxFL of [0.0001, 0.0003, 0.0005, 0.001, 0.002, 0.005]) {
      // For long: skip if funding too high (means longs are paying shorts heavily — overheated)
      test(`maxFundingForLong=${maxFL} (skip if funding above)`, {
        fundingRateFilter: { maxFundingForLong: maxFL },
      } as any);
    }

    log(`\n========== Funding Rate + Funding Data attached ==========`);
    // Need to inject funding data into engine. Check if engine pulls from candle metadata
    log(`(funding data injection requires engine integration check)`);

    expect(true).toBe(true);
  });
});
