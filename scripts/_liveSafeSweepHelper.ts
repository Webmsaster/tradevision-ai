/**
 * Reusable live-safe tuning helper.
 *
 * Given a base config + candles + tfHours, runs:
 *   R1: atrStop period × mult grid
 *   R2: lossStreakCooldown sweep on R1 winner
 *   R3: htfTrendFilter sweep on R2 winner
 * and returns the best variant (highest pass-rate, ties broken by median).
 */
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import type { Candle } from "../src/utils/indicators";
import { pick, computePassDay, assertAligned } from "./_passDayUtils";

export const LIVE_CAPS = { maxStopPct: 0.03, maxRiskFrac: 0.02 };
export const CHALLENGE_DAYS = 30;

export interface BatchResult {
  passes: number;
  windows: number;
  passRate: number;
  medianDays: number;
  p25Days: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
  totalTrades: number;
  ev: number;
}

export function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  tfHours: number,
  stepDays = 3,
): BatchResult {
  assertAligned(byAsset);
  const barsPerDay = 24 / tfHours;
  const winBars = Math.round(CHALLENGE_DAYS * barsPerDay);
  const stepBars = Math.round(stepDays * barsPerDay);
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
    if (r.passed) passDays.push(computePassDay(r));
  }
  passDays.sort((a, b) => a - b);
  const px = (q: number) => {
    const v = pick(passDays, q);
    return Number.isNaN(v) ? 0 : v;
  };
  return {
    passes,
    windows: out.length,
    passRate: passes / out.length,
    medianDays: px(0.5),
    p25Days: px(0.25),
    p75Days: px(0.75),
    p90Days: px(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    totalTrades,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
}

export function fmt(label: string, r: BatchResult) {
  return `${label.padEnd(40)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

interface Variant {
  cfg: FtmoDaytrade24hConfig;
  label: string;
  r: BatchResult;
}

export function findBestLiveSafe(
  base: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  tfHours: number,
  log: (s: string) => void = console.log,
) {
  const baseWithCap: FtmoDaytrade24hConfig = { ...base, liveCaps: LIVE_CAPS };
  const baseRun = runWalkForward(data, baseWithCap, tfHours);
  log(fmt("BASELINE (live-cap)", baseRun));

  // R1: atrStop period × mult — produces stops that fit the 3% cap.
  log(`\n--- R1: atrStop sweep ---`);
  const r1: Variant[] = [];
  const atrPeriods = [14, 28, 42, 84];
  const atrMults = [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];
  for (const p of atrPeriods) {
    for (const m of atrMults) {
      const cfg: FtmoDaytrade24hConfig = {
        ...baseWithCap,
        atrStop: { period: p, stopMult: m },
      };
      const r = runWalkForward(data, cfg, tfHours);
      const label = `atr p${p} m${m}`;
      r1.push({ cfg, label, r });
    }
  }
  const r1Best = r1
    .filter((v) => v.r.totalTrades >= 50)
    .sort(
      (a, b) => b.r.passRate - a.r.passRate || a.r.medianDays - b.r.medianDays,
    )[0];
  log(fmt(`R1 winner: ${r1Best.label}`, r1Best.r));

  // R2: lossStreakCooldown
  log(`\n--- R2: LSC sweep ---`);
  const r2: Variant[] = [];
  const cooldowns = [50, 100, 150, 200, 300, 400, 600];
  for (const cd of cooldowns) {
    for (const after of [2, 3]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...r1Best.cfg,
        lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
      };
      const r = runWalkForward(data, cfg, tfHours);
      const label = `LSC after=${after} cd=${cd}`;
      r2.push({ cfg, label, r });
    }
  }
  const r2Best = r2
    .filter((v) => v.r.totalTrades >= 50)
    .sort(
      (a, b) => b.r.passRate - a.r.passRate || a.r.medianDays - b.r.medianDays,
    )[0];
  log(fmt(`R2 winner: ${r2Best.label}`, r2Best.r));

  // R3: htfTrendFilter
  log(`\n--- R3: HTF sweep ---`);
  const r3: Variant[] = [];
  for (const lb of [100, 200, 300, 400]) {
    for (const thr of [0.05, 0.08, 0.1, 0.12, 0.15]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...r2Best.cfg,
        htfTrendFilter: {
          lookbackBars: lb,
          apply: "short",
          threshold: thr,
        },
      };
      const r = runWalkForward(data, cfg, tfHours);
      const label = `HTF lb=${lb} thr=${thr}`;
      r3.push({ cfg, label, r });
    }
  }
  const r3Best = r3
    .filter((v) => v.r.totalTrades >= 50)
    .sort(
      (a, b) => b.r.passRate - a.r.passRate || a.r.medianDays - b.r.medianDays,
    )[0];
  log(fmt(`R3 winner: ${r3Best.label}`, r3Best.r));

  log(`\n========== FINAL ==========`);
  log(fmt("Baseline   ", baseRun));
  log(fmt("R1 atrStop ", r1Best.r));
  log(fmt("R2 LSC     ", r2Best.r));
  log(fmt("R3 HTF     ", r3Best.r));
  log(
    `Δ baseline → final: +${((r3Best.r.passRate - baseRun.passRate) * 100).toFixed(2)}pp`,
  );

  return {
    baseline: baseRun,
    finalCfg: r3Best.cfg,
    finalResult: r3Best.r,
    label: `${r1Best.label} | ${r2Best.label} | ${r3Best.label}`,
  };
}
