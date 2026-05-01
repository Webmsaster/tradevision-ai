/**
 * Round 42 — Forex Sweep (50+ variants on the 6-major basket).
 *
 * Goal: find robust optimum + alt configurations to fight overfit.
 * Around Round 41 baseline (sp3 tp1 lev8 mct12 dpt15 idl3 → 94.48% pass).
 *
 * Sweep dimensions (independent + grouped):
 *   stopPct        ∈ {0.02, 0.025, 0.03, 0.035, 0.04}
 *   tpPct          ∈ {0.005, 0.0075, 0.01, 0.0125, 0.015}
 *   leverage       ∈ {5, 6, 7, 8, 10}
 *   mct            ∈ {8, 10, 12, 14, 16}
 *   holdBars       ∈ {36, 48, 60, 72, 96}
 *   dpt            ∈ {0.01, 0.015, 0.02, 0.025}
 *   idl-hard       ∈ {0.025, 0.03, 0.035, 0.04}
 *
 * Output: top-15 configs by pass-rate + walk-forward train/test split.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import {
  loadForexMajors,
  alignForexCommon,
  FOREX_MAJORS,
} from "./_loadForexHistory";
import { makeForexAsset } from "./_round41ForexBaseline.test";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/ROUND42_FOREX_SWEEP_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const BARS_PER_DAY_2H = 12;

interface SweepParams {
  name: string;
  stopPct: number;
  tpPct: number;
  lev: number;
  mct: number;
  holdBars: number;
  dpt: number;
  idl: number;
  hours?: number[];
}

function buildCfg(eligible: string[], p: SweepParams): FtmoDaytrade24hConfig {
  return {
    triggerBars: 1,
    leverage: p.lev,
    tpPct: p.tpPct,
    stopPct: p.stopPct,
    holdBars: p.holdBars,
    timeframe: "2h",
    maxConcurrentTrades: p.mct,
    assets: eligible.map((s) => ({
      ...makeForexAsset(s),
      stopPct: p.stopPct,
      tpPct: p.tpPct,
      holdBars: p.holdBars,
    })),
    profitTarget: 0.08,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    maxDays: 30,
    pauseAtTargetReached: true,
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    dailyPeakTrailingStop: { trailDistance: p.dpt },
    intradayDailyLossThrottle: {
      hardLossThreshold: p.idl,
      softLossThreshold: p.idl * 0.6,
      softFactor: 0.5,
    },
    allowedHoursUtc: p.hours ?? [8, 10, 12, 14, 16, 18, 20],
  };
}

interface Result {
  pr: number;
  passes: number;
  windows: number;
  tl: number;
  dl: number;
  med: number;
  p90: number;
  wr: number;
}

function evalCfg(
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  eligible: string[],
  startBar: number,
  endBar: number,
): Result {
  const winBars = 30 * BARS_PER_DAY_2H;
  const stepBars = 3 * BARS_PER_DAY_2H;
  let p = 0,
    w = 0,
    tl = 0,
    dl = 0,
    wins = 0,
    losses = 0;
  const passDays: number[] = [];
  for (let s = startBar; s + winBars <= endBar; s += stepBars) {
    const sub: Record<string, Candle[]> = {};
    for (const sym of eligible) sub[sym] = aligned[sym].slice(s, s + winBars);
    const r = runFtmoDaytrade24h(sub, cfg);
    w++;
    if (r.passed) {
      p++;
      if (r.passDay !== undefined) passDays.push(r.passDay);
    }
    if (r.reason === "total_loss") tl++;
    if (r.reason === "daily_loss") dl++;
    for (const t of r.trades) {
      const ep = (t as { effPnl?: number }).effPnl;
      if (ep !== undefined) {
        if (ep > 0) wins++;
        else if (ep < 0) losses++;
      }
    }
  }
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    pr: w > 0 ? p / w : 0,
    passes: p,
    windows: w,
    tl,
    dl,
    med: pick(0.5),
    p90: pick(0.9),
    wr: wins + losses > 0 ? wins / (wins + losses) : 0,
  };
}

function generateGrid(): SweepParams[] {
  const out: SweepParams[] = [];
  // Champion baseline
  out.push({
    name: "BASE",
    stopPct: 0.03,
    tpPct: 0.01,
    lev: 8,
    mct: 12,
    holdBars: 60,
    dpt: 0.015,
    idl: 0.03,
  });
  // 1-axis sweeps (each from baseline)
  const base = {
    stopPct: 0.03,
    tpPct: 0.01,
    lev: 8,
    mct: 12,
    holdBars: 60,
    dpt: 0.015,
    idl: 0.03,
  };
  for (const sp of [0.02, 0.025, 0.035, 0.04])
    out.push({ ...base, name: `sp${sp}`, stopPct: sp });
  for (const tp of [0.005, 0.0075, 0.0125, 0.015])
    out.push({ ...base, name: `tp${tp}`, tpPct: tp });
  for (const lv of [5, 6, 7, 10])
    out.push({ ...base, name: `lev${lv}`, lev: lv });
  for (const mc of [8, 10, 14, 16])
    out.push({ ...base, name: `mct${mc}`, mct: mc });
  for (const hb of [36, 48, 72, 96])
    out.push({ ...base, name: `hb${hb}`, holdBars: hb });
  for (const dp of [0.01, 0.02, 0.025])
    out.push({ ...base, name: `dpt${dp}`, dpt: dp });
  for (const id of [0.025, 0.035, 0.04])
    out.push({ ...base, name: `idl${id}`, idl: id });
  // Hour-filter variants
  out.push({
    ...base,
    name: "hours-all",
    hours: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22],
  });
  out.push({ ...base, name: "hours-london", hours: [8, 10, 12, 14] });
  out.push({ ...base, name: "hours-ny", hours: [14, 16, 18, 20] });
  out.push({ ...base, name: "hours-overlap", hours: [12, 14, 16] });
  // Combo variants
  out.push({
    ...base,
    name: "tighter sp25 tp75",
    stopPct: 0.025,
    tpPct: 0.0075,
  });
  out.push({ ...base, name: "tighter sp25 tp1", stopPct: 0.025, tpPct: 0.01 });
  out.push({ ...base, name: "wider sp4 tp15", stopPct: 0.04, tpPct: 0.015 });
  out.push({
    ...base,
    name: "wider sp35 tp125",
    stopPct: 0.035,
    tpPct: 0.0125,
  });
  // Speed: smaller hb + dpt
  out.push({ ...base, name: "speed hb36 dpt1", holdBars: 36, dpt: 0.01 });
  out.push({ ...base, name: "speed hb48 dpt12", holdBars: 48, dpt: 0.012 });
  // Heavy lev
  out.push({ ...base, name: "lev10 mct16", lev: 10, mct: 16 });
  out.push({ ...base, name: "lev6 mct16 sp4", lev: 6, mct: 16, stopPct: 0.04 });
  // Anti-DL hardener
  out.push({ ...base, name: "idl25 dpt12", idl: 0.025, dpt: 0.012 });
  out.push({ ...base, name: "idl2 dpt1", idl: 0.02, dpt: 0.01 });
  // Multi-axis explore
  for (const sp of [0.025, 0.03, 0.035]) {
    for (const tp of [0.0075, 0.01, 0.0125]) {
      for (const lv of [6, 8, 10]) {
        out.push({
          ...base,
          name: `g_sp${sp}_tp${tp}_lev${lv}`,
          stopPct: sp,
          tpPct: tp,
          lev: lv,
        });
      }
    }
  }
  return out;
}

describe("Round 42 — Forex Sweep", { timeout: 60 * 60_000 }, () => {
  it("sweep top configs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `ROUND 42 FOREX SWEEP ${new Date().toISOString()}\n`,
    );

    log(`Loading Yahoo forex 1h → resampled to 2h, range=2y...`);
    const data = await loadForexMajors(
      { timeframe: "2h", range: "2y" },
      FOREX_MAJORS,
    );
    const eligible = Object.keys(data).filter(
      (s) => data[s].length >= 30 * BARS_PER_DAY_2H,
    );
    if (eligible.length === 0) {
      log("FATAL: no eligible forex pairs.");
      expect(eligible.length).toBeGreaterThan(0);
      return;
    }
    const aligned = alignForexCommon(
      Object.fromEntries(eligible.map((s) => [s, data[s]])),
    );
    const minLen = Math.min(...eligible.map((s) => aligned[s].length));
    log(
      `Aligned: ${eligible.length} pairs / ${minLen} bars / ${(minLen / BARS_PER_DAY_2H / 365).toFixed(2)}y`,
    );

    // Walk-forward split: first 50% TRAIN, last 50% TEST.
    const half = Math.floor(minLen / 2);
    log(
      `TRAIN: bars 0-${half} (${(half / BARS_PER_DAY_2H / 365).toFixed(2)}y)`,
    );
    log(
      `TEST:  bars ${half}-${minLen} (${((minLen - half) / BARS_PER_DAY_2H / 365).toFixed(2)}y)\n`,
    );

    const grid = generateGrid();
    log(`Sweeping ${grid.length} variants...\n`);

    interface Row {
      params: SweepParams;
      train: Result;
      test: Result;
      full: Result;
      score: number;
    }
    const rows: Row[] = [];
    for (const p of grid) {
      const cfg = buildCfg(eligible, p);
      const train = evalCfg(cfg, aligned, eligible, 0, half);
      const test = evalCfg(cfg, aligned, eligible, half, minLen);
      const full = evalCfg(cfg, aligned, eligible, 0, minLen);
      // Score: full pass-rate, penalize TL>3% and walk-forward drift >5pp
      const drift = Math.abs(train.pr - test.pr);
      const wfPenalty = drift > 0.05 ? (drift - 0.05) * 100 : 0;
      const tlPenalty =
        full.tl / full.windows > 0.03
          ? (full.tl / full.windows - 0.03) * 100
          : 0;
      const score = full.pr * 100 - wfPenalty - tlPenalty;
      rows.push({ params: p, train, test, full, score });
    }
    rows.sort((a, b) => b.score - a.score);

    log(
      `============ TOP 15 by Score (full-pass-rate − walk-forward drift − TL penalty) ============`,
    );
    log(
      `${"Rank".padEnd(5)}${"Name".padEnd(28)}${"Full%".padEnd(8)}${"Trn%".padEnd(8)}${"Tst%".padEnd(8)}${"Drft".padEnd(7)}${"TL%".padEnd(7)}${"DL%".padEnd(7)}${"med".padEnd(6)}${"p90".padEnd(6)}${"wr%"}`,
    );
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const r = rows[i];
      const drift = (r.train.pr - r.test.pr) * 100;
      log(
        `${(i + 1).toString().padEnd(5)}${r.params.name.padEnd(28)}` +
          `${(r.full.pr * 100).toFixed(2).padEnd(8)}` +
          `${(r.train.pr * 100).toFixed(2).padEnd(8)}` +
          `${(r.test.pr * 100).toFixed(2).padEnd(8)}` +
          `${(drift >= 0 ? "+" : "") + drift.toFixed(2).padEnd(6)}` +
          `${((r.full.tl / r.full.windows) * 100).toFixed(1).padEnd(7)}` +
          `${((r.full.dl / r.full.windows) * 100).toFixed(1).padEnd(7)}` +
          `${r.full.med.toString().padEnd(6)}` +
          `${r.full.p90.toString().padEnd(6)}` +
          `${(r.full.wr * 100).toFixed(1)}`,
      );
    }
    log(`\nSweep complete. Top-3 selected for Round 43 V4-Sim validation.`);
    expect(rows.length).toBeGreaterThan(0);
  });
});
