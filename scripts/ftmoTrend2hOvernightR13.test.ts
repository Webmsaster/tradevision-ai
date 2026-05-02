/**
 * R13 — try V8-style on different timeframes
 *
 * 2h is plateaued at 46.20%. Maybe 1h or 4h TF has different ceiling.
 *
 * Test V8 base structure on 1h, 2h, 4h, 30m simultaneously.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R13_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  tfHours: number,
  stepDays = 3,
): BatchResult {
  const barsPerDay = Math.round(24 / tfHours);
  const winBars = 30 * barsPerDay;
  const stepBars = stepDays * barsPerDay;
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
  return `${label.padEnd(45)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
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

function adaptHoldBars(
  v8: FtmoDaytrade24hConfig,
  tfHours: number,
): FtmoDaytrade24hConfig {
  // V8's holdBars=240 is for 2h (= 20 days). Scale by tf ratio.
  const scaleFactor = 2 / tfHours; // 1h → 2x bars, 4h → 0.5x
  const newHb = Math.round(240 * scaleFactor);
  return {
    ...v8,
    holdBars: newHb,
    assets: v8.assets.map((a) => ({ ...a, holdBars: newHb })),
  };
}

describe("R13 — multi-TF V8-style", { timeout: 24 * 3600_000 }, () => {
  it("runs R13", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R13 START ${new Date().toISOString()}\n`);

    for (const tf of ["30m", "1h", "2h", "4h"] as const) {
      const tfHours = { "30m": 0.5, "1h": 1, "2h": 2, "4h": 4 }[tf];
      log(`\n========== TF=${tf} (${tfHours}h) ==========`);
      log(`Loading...`);
      const data: Record<string, Candle[]> = {};
      for (const s of SOURCES) {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: tf,
          targetCount: 30000,
          maxPages: 80,
        });
      }
      const n = Math.min(...Object.values(data).map((c) => c.length));
      for (const s of SOURCES) data[s] = data[s].slice(-n);
      const yrs = ((n * tfHours) / 24 / 365).toFixed(2);
      log(`Aligned: ${n} bars (${yrs}y)`);

      const cfg = adaptHoldBars(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8, tfHours);
      const r = runWalkForward(data, cfg, tfHours);
      log(fmt(`V8-style on ${tf}`, r));
    }

    log(`\n========== R13 SUMMARY ==========`);

    expect(true).toBe(true);
  });
});
