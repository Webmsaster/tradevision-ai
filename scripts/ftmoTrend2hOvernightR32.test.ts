/**
 * R32 — V5 + funding-rate filter (NEW engine extension)
 *
 * Funding rate is a perp-futures crowdedness signal:
 *   - High positive funding = longs paying shorts = crowded long = top often near
 *   - Skip long entries when funding > threshold
 *
 * 8h funding cadence on Binance perps. Forward-fill to 2h candle bars.
 *
 * Multi-fold OOS sweep on V5 with various maxFundingForLong thresholds.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
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
const LOG_FILE = `${LOG_DIR}/R32_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

interface BatchResult {
  windows: number;
  passes: number;
  passRate: number;
  medianDays: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
  ev: number;
}

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  fundingBySymbol?: Record<string, (number | null)[]>,
  stepDays = 3,
): BatchResult {
  const winBars = 30 * BARS_PER_DAY;
  const stepBars = stepDays * BARS_PER_DAY;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    const fundingSlice: Record<string, (number | null)[]> = {};
    for (const [sym, arr] of Object.entries(byAsset)) {
      slice[sym] = arr.slice(s, s + winBars);
      if (fundingBySymbol && fundingBySymbol[sym])
        fundingSlice[sym] = fundingBySymbol[sym].slice(s, s + winBars);
    }
    out.push(
      runFtmoDaytrade24h(
        slice,
        cfg,
        fundingBySymbol ? fundingSlice : undefined,
      ),
    );
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  for (const r of out)
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: pick(0.5),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
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

describe("R32 — funding-rate filter test", { timeout: 24 * 3600_000 }, () => {
  it("runs R32", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R32 START ${new Date().toISOString()}\n`);

    log(`Loading 2h candles...`);
    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      log(`  ${s}: ${data[s].length} bars`);
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);
    const startMs = data[SOURCES[0]][0].openTime;
    const endMs = data[SOURCES[0]][n - 1].openTime + 2 * 3600_000;
    log(
      `Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y) [${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}]`,
    );

    log(`\nLoading funding rate data (Binance perps)...`);
    const fundingBySymbol: Record<string, (number | null)[]> = {};
    for (const s of SOURCES) {
      try {
        const rows = await loadBinanceFundingRate(s, startMs, endMs);
        const aligned = alignFundingToCandles(
          rows,
          data[s].map((c) => c.openTime),
        );
        fundingBySymbol[s] = aligned;
        const valid = aligned.filter((x) => x !== null).length;
        log(
          `  ${s}: ${rows.length} funding rows, ${valid}/${aligned.length} candles aligned`,
        );
      } catch (e) {
        log(`  ${s}: SKIP (${(e as Error).message})`);
      }
    }

    // Sample funding stats
    log(`\n========== Funding rate distribution (BTCUSDT) ==========`);
    const btcFunding = fundingBySymbol["BTCUSDT"];
    if (btcFunding) {
      const valid = btcFunding.filter((x) => x !== null) as number[];
      valid.sort((a, b) => a - b);
      const pick = (q: number) => valid[Math.floor(valid.length * q)];
      log(
        `  median: ${(pick(0.5) * 100).toFixed(4)}% | p75: ${(pick(0.75) * 100).toFixed(4)}% | p90: ${(pick(0.9) * 100).toFixed(4)}% | p95: ${(pick(0.95) * 100).toFixed(4)}% | p99: ${(pick(0.99) * 100).toFixed(4)}%`,
      );
      log(
        `  min: ${(valid[0] * 100).toFixed(4)}% | max: ${(valid[valid.length - 1] * 100).toFixed(4)}%`,
      );
    }

    // Multi-fold OOS test
    const sixMo = Math.floor(0.5 * 365 * BARS_PER_DAY);
    const numSlices = Math.floor(n / sixMo);
    const slices: Record<string, Candle[]>[] = [];
    const fundingSlices: Record<string, (number | null)[]>[] = [];
    for (let i = 0; i < numSlices; i++) {
      const slice: Record<string, Candle[]> = {};
      const fSlice: Record<string, (number | null)[]> = {};
      for (const s of SOURCES) {
        slice[s] = data[s].slice(i * sixMo, (i + 1) * sixMo);
        if (fundingBySymbol[s])
          fSlice[s] = fundingBySymbol[s].slice(i * sixMo, (i + 1) * sixMo);
      }
      slices.push(slice);
      fundingSlices.push(fSlice);
    }
    log(`\n${slices.length} non-overlapping 6mo slices built`);

    const evalMulti = (cfg: FtmoDaytrade24hConfig, useFunding: boolean) => {
      const rates: number[] = [];
      for (let i = 0; i < slices.length; i++) {
        const out: FtmoDaytrade24hResult[] = [];
        const winBars = 30 * BARS_PER_DAY;
        const stepBars = 3 * BARS_PER_DAY;
        const sliceData = slices[i];
        const sliceFunding = useFunding ? fundingSlices[i] : undefined;
        const aligned = Math.min(
          ...Object.values(sliceData).map((a) => a.length),
        );
        let p = 0,
          w = 0;
        for (let s = 0; s + winBars <= aligned; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          const subFund: Record<string, (number | null)[]> = {};
          for (const [sym, arr] of Object.entries(sliceData)) {
            sub[sym] = arr.slice(s, s + winBars);
            if (sliceFunding && sliceFunding[sym])
              subFund[sym] = sliceFunding[sym].slice(s, s + winBars);
          }
          const r = runFtmoDaytrade24h(
            sub,
            cfg,
            useFunding ? subFund : undefined,
          );
          if (r.passed) p++;
          w++;
        }
        rates.push(w > 0 ? p / w : 0);
      }
      const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
      const min = Math.min(...rates);
      const std = Math.sqrt(
        rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length,
      );
      const recent3 = rates.slice(-3).reduce((a, b) => a + b, 0) / 3;
      return { rates, mean, min, std, recent3 };
    };

    log(`\n========== V5 baseline (no funding) ==========`);
    const v5R = evalMulti(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5, false);
    log(
      `mean=${(v5R.mean * 100).toFixed(2)}% min=${(v5R.min * 100).toFixed(2)}% std=${(v5R.std * 100).toFixed(2)}% recent3=${(v5R.recent3 * 100).toFixed(2)}%`,
    );

    log(`\n========== V5 + funding filter sweep ==========`);
    const candidates = [
      { name: "V5 + maxFunding 0.0001", maxFL: 0.0001 },
      { name: "V5 + maxFunding 0.0002", maxFL: 0.0002 },
      { name: "V5 + maxFunding 0.0003", maxFL: 0.0003 },
      { name: "V5 + maxFunding 0.0005", maxFL: 0.0005 },
      { name: "V5 + maxFunding 0.0010", maxFL: 0.001 },
      { name: "V5 + maxFunding 0.0020", maxFL: 0.002 },
    ];
    for (const c of candidates) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        fundingRateFilter: { maxFundingForLong: c.maxFL },
      };
      const r = evalMulti(cfg, true);
      const dM = ((r.mean - v5R.mean) * 100).toFixed(2);
      const dR = ((r.recent3 - v5R.recent3) * 100).toFixed(2);
      log(
        `  ${c.name.padEnd(30)} mean=${(r.mean * 100).toFixed(2)}% (Δ${dM}pp) recent3=${(r.recent3 * 100).toFixed(2)}% (Δ${dR}pp) min=${(r.min * 100).toFixed(2)}%`,
      );
    }

    log(`\n========== V5_RECENT + funding sweep ==========`);
    for (const c of candidates) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
        fundingRateFilter: { maxFundingForLong: c.maxFL },
      };
      const r = evalMulti(cfg, true);
      log(
        `  RECENT+${c.name.padEnd(28).slice(8)} mean=${(r.mean * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}%`,
      );
    }

    log(`\n========== V5_ROBUST + funding sweep ==========`);
    for (const c of candidates) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
        fundingRateFilter: { maxFundingForLong: c.maxFL },
      };
      const r = evalMulti(cfg, true);
      log(
        `  ROBUST+${c.name.padEnd(28).slice(8)} mean=${(r.mean * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}%`,
      );
    }

    expect(true).toBe(true);
  });
});
