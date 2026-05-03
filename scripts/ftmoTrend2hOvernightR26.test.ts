/**
 * R26 — most-recent-6-month OOS test for V5..V14
 * Honest forecast for live performance.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R26_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  stepDays = 3,
): BatchResult {
  const winBars = 30 * BARS_PER_DAY;
  const stepBars = stepDays * BARS_PER_DAY;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
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

function fmt(label: string, r: BatchResult) {
  return `${label.padEnd(15)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches.toString().padStart(2)} DL=${r.dlBreaches}`;
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

describe("R26 — recent-period OOS forecast", { timeout: 24 * 3600_000 }, () => {
  it("runs R26", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R26 START ${new Date().toISOString()}\n`);

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

    const all = [
      { name: "V5", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5 },
      { name: "V8", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8 },
      { name: "V12", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12 },
      { name: "V14", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14 },
      { name: "V13_RISKY", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY },
    ];

    // Multiple OOS slices: last 6mo, 1y, 2y, full
    const slices = [
      { name: "last 6mo", bars: 6 * 30 * BARS_PER_DAY },
      { name: "last 1y", bars: 365 * BARS_PER_DAY },
      { name: "last 2y", bars: 2 * 365 * BARS_PER_DAY },
      { name: "last 3y", bars: 3 * 365 * BARS_PER_DAY },
      { name: "FULL", bars: n },
    ];

    for (const slice of slices) {
      const sliceData: Record<string, Candle[]> = {};
      for (const s of SOURCES)
        sliceData[s] = data[s].slice(-Math.min(slice.bars, data[s].length));
      const aligned = Math.min(
        ...Object.values(sliceData).map((c) => c.length),
      );
      const yrs = (aligned / BARS_PER_DAY / 365).toFixed(2);
      log(`\n========== ${slice.name} (${aligned} bars / ${yrs}y) ==========`);
      for (const c of all) {
        const r = runWalkForward(sliceData, c.cfg);
        log(fmt(c.name, r));
      }
    }

    expect(true).toBe(true);
  });
});
