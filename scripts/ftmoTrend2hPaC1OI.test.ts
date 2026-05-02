/**
 * Phase C.1: Open Interest filter (BTC OI as proxy for crypto-perp sentiment).
 * Skip trend-longs when OI is extreme high (overheated longs).
 */
import { describe, it, expect } from "vitest";
import {
  detectAsset,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { loadBinanceOpenInterest, alignOIToCandles } from "./_loadOpenInterest";
import { LIVE_CAPS, runWalkForward, fmt } from "./_aggressiveSweepHelper";
import { walkForwardEnsemble } from "./_multiTfEnsemble";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 2;
const SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "SOLUSDT",
  "BCHUSDT",
  "DOGEUSDT",
];

describe("Phase C.1 Open Interest Filter", { timeout: 1800_000 }, () => {
  it("filters trend-longs by BTC OI percentile", async () => {
    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);

    const minTs = data.BTCUSDT[0].openTime;
    const maxTs = data.BTCUSDT[n - 1].closeTime;
    console.log(
      `Loading BTC OI 2h from ${new Date(minTs).toISOString().slice(0, 10)} → ${new Date(maxTs).toISOString().slice(0, 10)}...`,
    );
    let oi: any[] = [];
    try {
      oi = await loadBinanceOpenInterest("BTCUSDT", "2h", minTs, maxTs);
    } catch (e) {
      console.log(
        `  OI fetch error: ${e}. Binance only keeps recent OI history.`,
      );
    }
    console.log(`  ${oi.length} OI samples loaded`);

    if (oi.length < 100) {
      console.log(
        `  WARN: Binance OI only goes back ~30 days — sample too small for 5y backtest.`,
      );
      console.log(`  Skipping further OI sweep.`);
      expect(true).toBe(true);
      return;
    }

    const candleTimes = data.BTCUSDT.map((c) => c.openTime);
    const oiAligned = alignOIToCandles(oi, candleTimes);
    const validOi = oiAligned.filter((x) => x !== null) as number[];
    const sortedOi = [...validOi].sort((a, b) => a - b);
    const pickQ = (q: number) => sortedOi[Math.floor(sortedOi.length * q)];
    console.log(
      `  OI percentiles: p50=${pickQ(0.5).toFixed(0)} p75=${pickQ(0.75).toFixed(0)} p90=${pickQ(0.9).toFixed(0)} p99=${pickQ(0.99).toFixed(0)}`,
    );

    const baseCfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, baseCfg, TF_HOURS);
    console.log(fmt("V3 BASELINE", baseR));

    // Pre-compute trades + tag with OI at entry
    const allTrades: Array<
      Daytrade24hTrade & { tf: string; entryOi: number | null }
    > = [];
    for (const asset of baseCfg.assets) {
      const lookupKey = asset.sourceSymbol ?? asset.symbol;
      const candles = data[lookupKey];
      if (!candles) continue;
      const trades = detectAsset(candles, asset, baseCfg);
      for (const t of trades) {
        const idx = candles.findIndex((c) => c.openTime === t.entryTime);
        const oiAtEntry =
          idx >= 0 && idx < oiAligned.length ? oiAligned[idx] : null;
        allTrades.push({ ...t, tf: "2h", entryOi: oiAtEntry });
      }
    }
    allTrades.sort((a, b) => a.entryTime - b.entryTime);

    function fmtRow(label: string, r: any) {
      return `${label.padEnd(38)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p90=${r.p90Days}  EV=$${r.ev.toFixed(0)}`;
    }
    const r0 = walkForwardEnsemble(allTrades, minTs, maxTs, baseCfg, 1);
    console.log(fmtRow("ensemble baseline (no OI filter)", r0));

    // Sweep: skip trades when OI exceeds quantile threshold
    let best = { quantile: Infinity, r: r0 };
    for (const q of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
      const cap = pickQ(q);
      const filtered = allTrades.filter(
        (t) => t.entryOi === null || t.entryOi <= cap,
      );
      const r = walkForwardEnsemble(filtered, minTs, maxTs, baseCfg, 1);
      console.log(
        fmtRow(
          `  OI ≤ p${(q * 100).toFixed(0)} (${filtered.length}/${allTrades.length})`,
          r,
        ),
      );
      if (r.passRate > best.r.passRate) best = { quantile: q, r };
    }

    console.log(`\n========== C.1 FINAL ==========`);
    console.log(fmtRow("ensemble baseline", r0));
    console.log(fmtRow(`OI winner (q=${best.quantile})`, best.r));
    console.log(`Δ: +${((best.r.passRate - r0.passRate) * 100).toFixed(2)}pp`);
    expect(allTrades.length).toBeGreaterThan(0);
  });
});
