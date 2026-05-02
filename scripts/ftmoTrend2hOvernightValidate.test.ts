/**
 * VALIDATE R3 winner on FULL 5.59y (drop short-history assets)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import {
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/VALIDATE_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  return `${label.padEnd(40)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

describe("Validate R3 winner full 5.59y", { timeout: 24 * 3600_000 }, () => {
  it("validates on full data", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `VALIDATE START ${new Date().toISOString()}\n`);

    const r3Path = `${LOG_DIR}/R3_FINAL_CONFIG.json`;
    const cur: FtmoDaytrade24hConfig = JSON.parse(
      readFileSync(r3Path, "utf-8"),
    );
    log(`Loaded R3 config: ${cur.assets.map((a) => a.symbol).join(", ")}`);

    // Load only what's in the config + R5 expects to be available
    const sources = cur.assets
      .map((a) => a.sourceSymbol)
      .filter(Boolean) as string[];
    log(`Loading ${sources.length} sources...`);
    const data: Record<string, Candle[]> = {};
    for (const s of sources) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      log(`  ${s}: ${data[s].length} bars`);
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of sources) data[s] = data[s].slice(-n);
    log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    const r3Result = runWalkForward(data, cur);
    log(fmt("R3 winner on FULL 5.59y", r3Result));

    // Also validate vs V5 baseline on same data for fair comparison
    const v5Result = runWalkForward(data, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5);
    log(fmt("V5 on same 5.59y", v5Result));

    log(
      `\nΔ V5 → R3: +${((r3Result.passRate - v5Result.passRate) * 100).toFixed(2)}pp`,
    );

    expect(r3Result.passRate).toBeGreaterThan(0);
  });
});
