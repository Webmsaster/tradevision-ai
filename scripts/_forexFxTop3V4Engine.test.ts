/**
 * FX_TOP3 — V4 Live Engine Validation on Real 1.41y Forex 2h Data.
 *
 * Goal: validate the FX_TOP3 99.39% claim (which uses runFtmoDaytrade24h, the
 * optimistic backtest engine) against the HONEST live-equivalent V4 Live
 * Engine (`simulate()` from `ftmoLiveEngineV4.ts`).
 *
 * Why this matters: memory feedback_backtest_vs_v4sim_gap.md documents that
 * crypto champions drift -30 to -45pp between the backtest engine and V4 Sim.
 * If FX_TOP3 holds up under V4 Engine, forex single-account is a real
 * upgrade over R28_V5's 58.82% V4-Engine pass-rate.
 *
 * Setup (verbatim from Round 41/42 baseline):
 *   - 6 majors (EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, NZDUSD), 2h
 *   - sp=0.035 tp=0.0075 lev=10 mct=12 hb=60
 *   - dpt=1.5% idl=3% liveCaps {0.05, 0.4}
 *   - hours [8,10,12,14,16,18,20] (London + NY overlap)
 *
 * Validation method:
 *   - Real 1.41y aligned 2h history via _loadForexHistory.ts
 *   - Both engines run on identical 30d windows / step=3d
 *   - Compare: pass-rate, median pass-day, drift (V4 - backtest)
 *
 * Honest verdict criterion: V4-Engine pass-rate ≥ 60% deploys; <60% sticks
 * with crypto R28_V5.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import {
  loadForexMajors,
  alignForexCommon,
  FOREX_MAJORS,
} from "./_loadForexHistory";
import { makeForexAsset } from "./_round41ForexBaseline.test";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/FOREX_FX_TOP3_V4_ENGINE_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const BARS_PER_DAY_2H = 12;

// ───────── FX_TOP3 champion config (Round 41-44 lineage) ─────────
function buildFxTop3Cfg(eligible: string[]): FtmoDaytrade24hConfig {
  return {
    triggerBars: 1,
    leverage: 10,
    tpPct: 0.0075,
    stopPct: 0.035,
    holdBars: 60,
    timeframe: "2h",
    maxConcurrentTrades: 12,
    assets: eligible.map((s) => ({
      ...makeForexAsset(s),
      stopPct: 0.035,
      tpPct: 0.0075,
      holdBars: 60,
    })),
    profitTarget: 0.08,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    maxDays: 30,
    pauseAtTargetReached: true,
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    dailyPeakTrailingStop: { trailDistance: 0.015 },
    intradayDailyLossThrottle: {
      hardLossThreshold: 0.03,
      softLossThreshold: 0.018,
      softFactor: 0.5,
    },
    allowedHoursUtc: [8, 10, 12, 14, 16, 18, 20],
  };
}

interface SweepResult {
  passes: number;
  windows: number;
  pr: number;
  tl: number;
  dl: number;
  giveBack: number;
  med: number;
  p90: number;
}

function sweepBacktest(
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  eligible: string[],
  startBar: number,
  endBar: number,
): SweepResult {
  const winBars = 30 * BARS_PER_DAY_2H;
  const stepBars = 3 * BARS_PER_DAY_2H;
  let passes = 0,
    windows = 0,
    tl = 0,
    dl = 0;
  const passDays: number[] = [];
  for (let s = startBar; s + winBars <= endBar; s += stepBars) {
    const sub: Record<string, Candle[]> = {};
    for (const sym of eligible) sub[sym] = aligned[sym]!.slice(s, s + winBars);
    const r = runFtmoDaytrade24h(sub, cfg);
    windows++;
    if (r.passed) {
      passes++;
      if (r.passDay !== undefined) passDays.push(r.passDay);
    }
    if (r.reason === "total_loss") tl++;
    if (r.reason === "daily_loss") dl++;
  }
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    passes,
    windows,
    pr: windows > 0 ? passes / windows : 0,
    tl,
    dl,
    giveBack: 0,
    med: pick(0.5),
    p90: pick(0.9),
  };
}

function sweepV4Engine(
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  eligible: string[],
  startBar: number,
  endBar: number,
): SweepResult {
  const winBars = 30 * BARS_PER_DAY_2H;
  const stepBars = 3 * BARS_PER_DAY_2H;
  let passes = 0,
    windows = 0,
    tl = 0,
    dl = 0,
    giveBack = 0;
  const passDays: number[] = [];
  // V4 Engine wants pre-aligned full series + start/end indices.
  // Each window passes the FULL aligned data with [s, s+winBars] indices.
  for (let s = startBar; s + winBars <= endBar; s += stepBars) {
    // Trim to [s, s+winBars] so simulate's per-tick slice(0,i+1) stays bounded.
    const trimmed: Record<string, Candle[]> = {};
    for (const sym of eligible)
      trimmed[sym] = aligned[sym]!.slice(s, s + winBars);
    const r = simulate(trimmed, cfg, 0, winBars, "FX_TOP3_V4");
    windows++;
    if (r.passed) {
      passes++;
      if (r.passDay !== undefined) passDays.push(r.passDay);
    }
    if (r.reason === "total_loss") tl++;
    if (r.reason === "daily_loss") dl++;
    if (r.reason === "give_back") giveBack++;
  }
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    passes,
    windows,
    pr: windows > 0 ? passes / windows : 0,
    tl,
    dl,
    giveBack,
    med: pick(0.5),
    p90: pick(0.9),
  };
}

describe("FX_TOP3 V4 Live Engine validation", { timeout: 60 * 60_000 }, () => {
  it("compares backtest engine vs V4 Live Engine on real 1.41y forex 2h data", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `FX_TOP3 V4 ENGINE VALIDATION ${new Date().toISOString()}\n`,
    );

    log(`Loading Yahoo forex 1h → resampled to 2h, range=2y...`);
    const data = await loadForexMajors(
      { timeframe: "2h", range: "2y" },
      FOREX_MAJORS,
    );
    for (const s of Object.keys(data)) {
      const n = data[s]!.length;
      const years = n / BARS_PER_DAY_2H / 365;
      log(`  ${s}: ${n} bars (${years.toFixed(2)}y)`);
    }
    const eligible = Object.keys(data).filter(
      (s) => data[s]!.length >= 30 * BARS_PER_DAY_2H,
    );
    if (eligible.length === 0) {
      log("FATAL: no eligible forex pairs.");
      expect(eligible.length).toBeGreaterThan(0);
      return;
    }

    const aligned = alignForexCommon(
      Object.fromEntries(eligible.map((s) => [s, data[s]!])),
    );
    const minLen = Math.min(...eligible.map((s) => aligned[s]!.length));
    log(
      `\nAligned: ${eligible.length} pairs / ${minLen} bars / ${(minLen / BARS_PER_DAY_2H / 365).toFixed(2)}y`,
    );

    const cfg = buildFxTop3Cfg(eligible);

    // ───────── Backtest engine (runFtmoDaytrade24h) ─────────
    log(`\n========== BACKTEST ENGINE (runFtmoDaytrade24h) ==========`);
    const tBacktest = Date.now();
    const bt = sweepBacktest(cfg, aligned, eligible, 0, minLen);
    log(`Pass-rate: ${(bt.pr * 100).toFixed(2)}% (${bt.passes}/${bt.windows})`);
    log(
      `TL fails:  ${((bt.tl / Math.max(bt.windows, 1)) * 100).toFixed(2)}% (${bt.tl})`,
    );
    log(
      `DL fails:  ${((bt.dl / Math.max(bt.windows, 1)) * 100).toFixed(2)}% (${bt.dl})`,
    );
    log(`Pass-days p50/p90: ${bt.med}d / ${bt.p90}d`);
    log(`Time: ${Math.round((Date.now() - tBacktest) / 1000)}s`);

    // ───────── V4 Live Engine (honest, no lookahead) ─────────
    log(`\n========== V4 LIVE ENGINE (simulate) ==========`);
    const tV4 = Date.now();
    const v4 = sweepV4Engine(cfg, aligned, eligible, 0, minLen);
    log(`Pass-rate: ${(v4.pr * 100).toFixed(2)}% (${v4.passes}/${v4.windows})`);
    log(
      `TL fails:    ${((v4.tl / Math.max(v4.windows, 1)) * 100).toFixed(2)}% (${v4.tl})`,
    );
    log(
      `DL fails:    ${((v4.dl / Math.max(v4.windows, 1)) * 100).toFixed(2)}% (${v4.dl})`,
    );
    log(
      `give_back:   ${((v4.giveBack / Math.max(v4.windows, 1)) * 100).toFixed(2)}% (${v4.giveBack})`,
    );
    log(`Pass-days p50/p90: ${v4.med}d / ${v4.p90}d`);
    log(`Time: ${Math.round((Date.now() - tV4) / 1000)}s`);

    // ───────── Drift analysis ─────────
    log(`\n========== DRIFT (V4 Engine − Backtest Engine) ==========`);
    const driftPp = (v4.pr - bt.pr) * 100;
    log(`Backtest:   ${(bt.pr * 100).toFixed(2)}%`);
    log(`V4 Engine:  ${(v4.pr * 100).toFixed(2)}%`);
    log(`Drift:      ${driftPp >= 0 ? "+" : ""}${driftPp.toFixed(2)}pp`);

    // ───────── Verdict vs R28_V5 (58.82% V4-Engine baseline) ─────────
    log(`\n========== VERDICT vs R28_V5 CRYPTO (58.82% V4-Engine) ==========`);
    const r28v5 = 58.82;
    const v4Pct = v4.pr * 100;
    const advantage = v4Pct - r28v5;
    log(`R28_V5 V4-Engine:    ${r28v5.toFixed(2)}%`);
    log(`FX_TOP3 V4-Engine:   ${v4Pct.toFixed(2)}%`);
    log(
      `Advantage forex:     ${advantage >= 0 ? "+" : ""}${advantage.toFixed(2)}pp`,
    );
    log("");
    if (advantage >= 5) {
      log(`>>> DEPLOY FOREX: FX_TOP3 beats R28_V5 by ≥5pp on V4 Engine.`);
    } else if (advantage >= -5) {
      log(
        `>>> TIE — within ±5pp. Stick with crypto for live-deployed simplicity.`,
      );
    } else {
      log(
        `>>> STICK WITH CRYPTO: FX_TOP3 underperforms R28_V5 by >${Math.abs(advantage).toFixed(0)}pp.`,
      );
    }

    // ───────── Markdown summary table ─────────
    log(`\n========== MARKDOWN COMPARISON TABLE ==========`);
    log(`| Strategy   | Engine    | Pass-Rate | Median d | TL%  | DL%  |`);
    log(`|------------|-----------|-----------|----------|------|------|`);
    log(
      `| FX_TOP3    | Backtest  | ${(bt.pr * 100).toFixed(2)}%    | ${bt.med}d       | ${((bt.tl / Math.max(bt.windows, 1)) * 100).toFixed(1)}% | ${((bt.dl / Math.max(bt.windows, 1)) * 100).toFixed(1)}% |`,
    );
    log(
      `| FX_TOP3    | V4 Engine | ${(v4.pr * 100).toFixed(2)}%    | ${v4.med}d       | ${((v4.tl / Math.max(v4.windows, 1)) * 100).toFixed(1)}% | ${((v4.dl / Math.max(v4.windows, 1)) * 100).toFixed(1)}% |`,
    );
    log(`| R28_V5     | V4 Engine | 58.82%    | n/a      | n/a  | n/a  |`);

    expect(v4.windows).toBeGreaterThan(0);
  });
});
