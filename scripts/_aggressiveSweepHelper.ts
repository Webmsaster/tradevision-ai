/**
 * Aggressive multi-axis live-cap sweep.
 *
 * Refines an already-cap-validated base config across:
 *   R1: greedy allowedHoursUtc drop (leave-one-out, accept if pass-rate up)
 *   R2: chandelierExit (period × mult)
 *   R3: partialTakeProfit (triggerPct × closeFraction)
 *   R4: timeBoost (afterDay × equityBelow × factor)
 *   R5: BTC-MR/SOL-MR minEquityGain × riskFrac
 *
 * Each round uses the previous winner as the new base.
 */
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import type { Candle } from "../src/utils/indicators";
import { pick, computePassDay, assertAligned } from "./_passDayUtils";

// Engine units: maxRiskFrac = live_loss / (stopPct × leverage) = 0.04 / 0.10 = 0.4
export const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
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
  return `${label.padEnd(38)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

/** Score: maximise pass-rate; on ties pick smaller p90 (better tail). */
function scoreCmp(a: BatchResult, b: BatchResult) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

export function aggressiveSweep(
  base: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  tfHours: number,
  log: (s: string) => void = console.log,
) {
  const cap = (cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig => ({
    ...cfg,
    liveCaps: LIVE_CAPS,
  });

  let cur = cap(base);
  const baseRun = runWalkForward(data, cur, tfHours);
  log(fmt("BASELINE", baseRun));

  // R1: greedy allowedHoursUtc drop
  log(`\n--- R1: greedy hour-drop ---`);
  let bestHoursR = { ...baseRun };
  let bestHours =
    cur.allowedHoursUtc ?? Array.from({ length: 24 }, (_, i) => i);
  let improved = true;
  let iter = 0;
  while (improved && iter < 5) {
    improved = false;
    for (const h of [...bestHours]) {
      const candidateHours = bestHours.filter((x) => x !== h);
      if (candidateHours.length < 6) continue;
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        allowedHoursUtc: candidateHours,
      };
      const r = runWalkForward(data, cfg, tfHours);
      if (scoreCmp(r, bestHoursR) < 0) {
        bestHoursR = r;
        bestHours = candidateHours;
        improved = true;
        log(fmt(`  drop hour ${h}`, r));
      }
    }
    iter++;
  }
  cur = { ...cur, allowedHoursUtc: bestHours };
  log(fmt(`R1 winner (hours=${bestHours.length})`, bestHoursR));

  // R2: chandelierExit
  log(`\n--- R2: chandelierExit sweep ---`);
  const r2: FtmoDaytrade24hConfig[] = [];
  let r2Best = { cfg: cur, r: bestHoursR };
  for (const period of [14, 28, 56, 84, 168]) {
    for (const mult of [2, 2.5, 3, 3.5, 4]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        chandelierExit: { period, mult, minMoveR: 0.5 },
      };
      const r = runWalkForward(data, cfg, tfHours);
      if (scoreCmp(r, r2Best.r) < 0) {
        r2Best = { cfg, r };
        log(fmt(`  chand p${period} m${mult}`, r));
      }
    }
  }
  cur = r2Best.cfg;
  log(fmt(`R2 winner`, r2Best.r));

  // R3: partialTakeProfit
  log(`\n--- R3: partialTakeProfit sweep ---`);
  let r3Best = { cfg: cur, r: r2Best.r };
  for (const trigger of [0.005, 0.01, 0.015, 0.02, 0.03]) {
    for (const frac of [0.2, 0.3, 0.5, 0.7]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        partialTakeProfit: { triggerPct: trigger, closeFraction: frac },
      };
      const r = runWalkForward(data, cfg, tfHours);
      if (scoreCmp(r, r3Best.r) < 0) {
        r3Best = { cfg, r };
        log(fmt(`  PTP t=${trigger} f=${frac}`, r));
      }
    }
  }
  cur = r3Best.cfg;
  log(fmt(`R3 winner`, r3Best.r));

  // R4: timeBoost (only INCREASES the sizing factor)
  log(`\n--- R4: timeBoost sweep ---`);
  let r4Best = { cfg: cur, r: r3Best.r };
  for (const day of [2, 4, 6, 8, 12]) {
    for (const eqBelow of [0.02, 0.04, 0.05, 0.07]) {
      for (const factor of [1.5, 2, 2.5, 3]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          timeBoost: { afterDay: day, equityBelow: eqBelow, factor },
        };
        const r = runWalkForward(data, cfg, tfHours);
        if (scoreCmp(r, r4Best.r) < 0) {
          r4Best = { cfg, r };
          log(fmt(`  tb d=${day} eb=${eqBelow} f=${factor}`, r));
        }
      }
    }
  }
  cur = r4Best.cfg;
  log(fmt(`R4 winner`, r4Best.r));

  // R5: BTC-MR / SOL-MR per-asset minEquityGain × riskFrac
  log(`\n--- R5: BTC/SOL asset tweaks ---`);
  let r5Best = { cfg: cur, r: r4Best.r };
  for (const meg of [0.005, 0.01, 0.02, 0.04]) {
    for (const rf of [0.5, 1.0, 1.5, 2.0]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        assets: cur.assets.map((a) =>
          a.symbol === "BTC-MR" || a.symbol === "SOL-MR"
            ? { ...a, minEquityGain: meg, riskFrac: rf }
            : a,
        ),
      };
      const r = runWalkForward(data, cfg, tfHours);
      if (scoreCmp(r, r5Best.r) < 0) {
        r5Best = { cfg, r };
        log(fmt(`  BTC/SOL meg=${meg} rf=${rf}`, r));
      }
    }
  }
  cur = r5Best.cfg;
  log(fmt(`R5 winner`, r5Best.r));

  log(`\n========== AGGRESSIVE SWEEP FINAL ==========`);
  log(fmt("Baseline   ", baseRun));
  log(fmt("R1 hours   ", bestHoursR));
  log(fmt("R2 chand   ", r2Best.r));
  log(fmt("R3 PTP     ", r3Best.r));
  log(fmt("R4 timeBoost", r4Best.r));
  log(fmt("R5 BTC/SOL ", r5Best.r));
  log(
    `Δ baseline → final: +${((r5Best.r.passRate - baseRun.passRate) * 100).toFixed(2)}pp`,
  );

  return { baseline: baseRun, finalCfg: cur, finalResult: r5Best.r };
}
