/**
 * R23 — pure hour-sweep on V12 (random 3000 hour subsets)
 *
 * R21 hint: trial 378 had hours [5,6,13,15,16,19,21,23] — possibly
 * the hours are doing more lifting than other params.
 * Test: keep V12 stack, only randomize hours.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { shuffled as fyShuffle } from "./_passDayUtils";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R23_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

function fmt(label: string, r: BatchResult, hrs?: number[]) {
  return `${label.padEnd(35)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches.toString().padStart(2)} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}${hrs ? ` h=${JSON.stringify(hrs)}` : ""}`;
}

// Pareto: pass-rate primary, TL secondary, with TL hard cap
function score(a: BatchResult, b: BatchResult, maxTL = 16) {
  const aOk = a.tlBreaches <= maxTL;
  const bOk = b.tlBreaches <= maxTL;
  if (aOk && !bOk) return -1;
  if (!aOk && bOk) return 1;
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.tlBreaches - b.tlBreaches;
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

describe("R23 — pure hour sweep on V12", { timeout: 24 * 3600_000 }, () => {
  it("runs R23", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R23 START ${new Date().toISOString()}\n`);

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
    log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    const baseR = runWalkForward(data, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12);
    log(fmt("V12 baseline", baseR));

    let best = {
      hours: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12.allowedHoursUtc!,
      r: baseR,
    };

    // 3000 random hour subsets, each tested with V12 stack
    log(`\n--- 3000 random hour subsets (TL ≤ 16 hard cap) ---`);
    for (let trial = 0; trial < 3000; trial++) {
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const targetCount = 4 + Math.floor(Math.random() * 14); // 4..17 hours
      const hours = fyShuffle(allHours)
        .slice(0, targetCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
        allowedHoursUtc: hours,
      };
      const r = runWalkForward(data, cfg);
      if (score(r, best.r, 16) < 0) {
        best = { hours, r };
        log(fmt(`  *** trial ${trial} BEST`, r, hours));
      }
      if ((trial + 1) % 500 === 0) {
        log(
          `  ${trial + 1}/3000 — best: ${(best.r.passRate * 100).toFixed(2)}% TL=${best.r.tlBreaches}`,
        );
      }
    }

    log(`\n========== R23 FINAL ==========`);
    log(
      fmt(
        "V12 baseline",
        baseR,
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12.allowedHoursUtc,
      ),
    );
    log(fmt("Best hour set", best.r, best.hours));
    log(
      `\nΔ V12 → R23: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    if (score(best.r, baseR, 16) < 0) {
      const cfg = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
        allowedHoursUtc: best.hours,
      };
      writeFileSync(
        `${LOG_DIR}/R23_FINAL_CONFIG.json`,
        JSON.stringify(cfg, null, 2),
      );
    }

    expect(best.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
