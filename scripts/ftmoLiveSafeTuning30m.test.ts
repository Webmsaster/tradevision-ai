/**
 * Live-Safe Tuning Sweep — 30m TF.
 *
 * Goal: find a 30m config that beats V231 (62.63% / 6d median) under the
 * live execution caps (stopPct ≤ 3%, riskFrac ≤ 2%).
 *
 * Strategy: take V12_30M_OPT's filter stack (allowedHoursUtc, htfTrendFilter,
 * lossStreakCooldown, chandelierExit, partialTakeProfit, BTC/SOL gating) but
 * sweep atrStop period × mult so effective stops fit under the 3% cap on
 * most bars. Wider sweeps explore other axes (holdBars, LSC cooldown).
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts \
 *     scripts/ftmoLiveSafeTuning30m.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V231,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const LIVE_CAPS = { maxStopPct: 0.03, maxRiskFrac: 0.02 };
const CHALLENGE_DAYS = 30;
const TF_HOURS = 0.5;
const BARS_PER_DAY = 48;

interface BatchResult {
  windows: number;
  passes: number;
  passRate: number;
  medianDays: number;
  p25Days: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
  totalTrades: number;
}

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  stepDays = 3,
): BatchResult {
  const winBars = Math.round(CHALLENGE_DAYS * BARS_PER_DAY);
  const stepBars = Math.round(stepDays * BARS_PER_DAY);
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
  let totalTrades = 0;
  for (const r of out) {
    totalTrades += r.trades.length;
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  }
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: pick(0.5),
    p25Days: pick(0.25),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    totalTrades,
  };
}

function fmt(label: string, r: BatchResult) {
  return `${label.padEnd(40)} ${r.passes.toString().padStart(3)}/${r.windows} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  trades=${r.totalTrades}`;
}

describe("Live-safe 30m tuning sweep", { timeout: 1500_000 }, () => {
  it("sweeps atrStop and finds best live-cap-respecting 30m config", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "30m",
      targetCount: 60000,
      maxPages: 60,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "30m",
      targetCount: 60000,
      maxPages: 60,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "30m",
      targetCount: 60000,
      maxPages: 60,
    });
    const n = Math.min(eth.length, btc.length, sol.length);
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
    };
    const yrs = (n / 48 / 365).toFixed(2);
    console.log(`\n=== Live-Safe 30m Tuning Sweep — ${yrs}y / ${n} bars ===`);
    console.log(
      `Caps: stop ≤ ${LIVE_CAPS.maxStopPct * 100}%, risk ≤ ${LIVE_CAPS.maxRiskFrac * 100}%\n`,
    );

    // Baselines
    const v231Cap = runWalkForward(data, {
      ...FTMO_DAYTRADE_24H_CONFIG_V231,
      liveCaps: LIVE_CAPS,
    });
    console.log(fmt("V231 (4h) live-cap [BASELINE]", v231Cap));

    const v12Cap = runWalkForward(data, {
      ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
      liveCaps: LIVE_CAPS,
    });
    console.log(fmt("V12 (30m) live-cap [SHOULD=0]", v12Cap));

    // Sweep atrStop period × mult to find a setting that survives the cap.
    // V12_30M_OPT keeps everything else (allowedHoursUtc, htfTrendFilter,
    // lossStreakCooldown, chandelierExit, partialTakeProfit, BTC/SOL gating).
    const atrPeriods = [14, 28, 42, 84];
    const atrMults = [1.5, 2, 2.5, 3, 3.5, 4, 5, 6];

    const results: Array<{ label: string; r: BatchResult }> = [];

    console.log(`\n--- atrStop sweep (period × mult) ---`);
    for (const p of atrPeriods) {
      for (const m of atrMults) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
          atrStop: { period: p, stopMult: m },
          liveCaps: LIVE_CAPS,
        };
        const r = runWalkForward(data, cfg);
        const label = `atr p${p} m${m}`;
        results.push({ label, r });
        console.log(fmt(label, r));
      }
    }

    // Top 3 by pass-rate (require ≥ 100 trades to avoid degenerate "skip-everything" winners)
    const ranked = results
      .filter((x) => x.r.totalTrades >= 100)
      .sort((a, b) => b.r.passRate - a.r.passRate);
    console.log(`\n--- TOP 5 by pass-rate (min 100 trades) ---`);
    for (const x of ranked.slice(0, 5)) {
      console.log(fmt(x.label, x.r));
    }

    // Tail-speed champion: lowest p90 among configs with passRate ≥ V231 baseline
    const speedRanked = results
      .filter((x) => x.r.passRate >= v231Cap.passRate && x.r.passes >= 30)
      .sort((a, b) => a.r.p90Days - b.r.p90Days || b.r.passRate - a.r.passRate);
    console.log(
      `\n--- TOP 3 by p90 (passRate ≥ V231 ${(v231Cap.passRate * 100).toFixed(1)}%) ---`,
    );
    for (const x of speedRanked.slice(0, 3)) {
      console.log(fmt(x.label, x.r));
    }

    // Median-speed champion
    const medRanked = results
      .filter((x) => x.r.passRate >= v231Cap.passRate && x.r.passes >= 30)
      .sort(
        (a, b) =>
          a.r.medianDays - b.r.medianDays || b.r.passRate - a.r.passRate,
      );
    console.log(`\n--- TOP 3 by median (passRate ≥ V231) ---`);
    for (const x of medRanked.slice(0, 3)) {
      console.log(fmt(x.label, x.r));
    }

    // Smoke: at least one variant must have produced trades.
    expect(results.some((x) => x.r.totalTrades > 0)).toBe(true);
  });
});
