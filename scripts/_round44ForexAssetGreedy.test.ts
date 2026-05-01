/**
 * Round 44 — Forex Asset Greedy (drop/add per pair).
 *
 * Methodology mirrors V5_OBSIDIAN→V5_AMBER greedy from Round-19/20:
 *   1. Start from FX_TOP3 (sp0.035 tp0.0075 lev10, all 6 majors).
 *   2. Try DROP each pair (single-pair removal); keep best if > full-basket.
 *   3. Try ADD other forex candidates (USDCHF=X, EURGBP=X, EURJPY=X).
 *   4. Iterate until convergence.
 *
 * Output: optimal asset-set ranked by V4-Sim pass-rate.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import {
  loadForexMajors,
  loadForexSymbol,
  alignForexCommon,
  FOREX_MAJORS,
} from "./_loadForexHistory";
import { makeForexAsset } from "./_round41ForexBaseline.test";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/ROUND44_FOREX_ASSET_GREEDY_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const BARS_PER_DAY_2H = 12;

const ADD_CANDIDATES = ["USDCHF=X", "EURGBP=X", "EURJPY=X", "GBPJPY=X"];

function buildCfg(eligible: string[]): FtmoDaytrade24hConfig {
  return {
    triggerBars: 1,
    leverage: 10,
    tpPct: 0.0075,
    stopPct: 0.035,
    holdBars: 60,
    timeframe: "2h",
    maxConcurrentTrades: 12,
    assets: eligible.map(
      (s): Daytrade24hAssetCfg => ({
        ...makeForexAsset(s),
        stopPct: 0.035,
        tpPct: 0.0075,
        holdBars: 60,
      }),
    ),
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

function evalCfg(
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  symbols: string[],
): {
  pr: number;
  tl: number;
  dl: number;
  passes: number;
  windows: number;
  med: number;
} {
  const minLen = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  const winBars = 30 * BARS_PER_DAY_2H;
  const stepBars = 3 * BARS_PER_DAY_2H;
  let p = 0,
    w = 0,
    tl = 0,
    dl = 0;
  const passDays: number[] = [];
  for (let s = 0; s + winBars <= minLen; s += stepBars) {
    const sub: Record<string, Candle[]> = {};
    for (const sym of symbols) sub[sym] = aligned[sym].slice(s, s + winBars);
    const r = runFtmoDaytrade24h(sub, cfg);
    w++;
    if (r.passed) {
      p++;
      if (r.passDay !== undefined) passDays.push(r.passDay);
    }
    if (r.reason === "total_loss") tl++;
    if (r.reason === "daily_loss") dl++;
  }
  passDays.sort((a, b) => a - b);
  const med = passDays[Math.floor(passDays.length / 2)] ?? 0;
  return { pr: w > 0 ? p / w : 0, tl, dl, passes: p, windows: w, med };
}

describe("Round 44 — Forex Asset Greedy", { timeout: 60 * 60_000 }, () => {
  it("greedy add/drop pairs around FX_TOP3", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `ROUND 44 FOREX ASSET GREEDY ${new Date().toISOString()}\n`,
    );

    log(`Loading 6 majors + 4 candidates...`);
    const majors = await loadForexMajors(
      { timeframe: "2h", range: "2y" },
      FOREX_MAJORS,
    );
    const data: Record<string, Candle[]> = { ...majors };
    for (const cand of ADD_CANDIDATES) {
      try {
        data[cand] = await loadForexSymbol(cand, {
          timeframe: "2h",
          range: "2y",
        });
        log(`  ${cand}: ${data[cand].length} bars`);
      } catch (e) {
        log(`  ${cand}: FAIL ${(e as Error).message}`);
      }
    }
    const all = Object.keys(data).filter(
      (s) => data[s].length >= 30 * BARS_PER_DAY_2H,
    );
    const aligned = alignForexCommon(
      Object.fromEntries(all.map((s) => [s, data[s]])),
    );
    log(`All available: ${all.length} pairs aligned\n`);

    // Phase 0: baseline (FX_TOP3 with 6 majors)
    let current: string[] = [...FOREX_MAJORS];
    let cur = evalCfg(buildCfg(current), aligned, current);
    log(
      `PHASE 0 baseline 6-majors: ${(cur.pr * 100).toFixed(2)}% (${cur.passes}/${cur.windows}) TL=${cur.tl} DL=${cur.dl} med=${cur.med}d\n`,
    );

    // Phase 1: try DROP each major
    log(`========== PHASE 1: try DROP each pair ==========`);
    let improved = true;
    while (improved && current.length > 3) {
      improved = false;
      let bestDrop: { sym: string; r: ReturnType<typeof evalCfg> } | null =
        null;
      for (const drop of current) {
        const newSet = current.filter((s) => s !== drop);
        const r = evalCfg(buildCfg(newSet), aligned, newSet);
        log(
          `  drop ${drop} → ${(r.pr * 100).toFixed(2)}% (${r.passes}/${r.windows}) TL=${r.tl} DL=${r.dl}`,
        );
        if (
          r.pr > cur.pr ||
          (r.pr === cur.pr && r.tl + r.dl < cur.tl + cur.dl)
        ) {
          if (!bestDrop || r.pr > bestDrop.r.pr) bestDrop = { sym: drop, r };
        }
      }
      if (bestDrop) {
        log(
          `  → DROP ${bestDrop.sym} accepted (${(bestDrop.r.pr * 100).toFixed(2)}% > ${(cur.pr * 100).toFixed(2)}%)`,
        );
        current = current.filter((s) => s !== bestDrop!.sym);
        cur = bestDrop.r;
        improved = true;
      } else {
        log(`  → no drop improves, stop phase 1.`);
      }
    }
    log(
      `After PHASE 1: ${current.length} pairs (${current.join(",")}) → ${(cur.pr * 100).toFixed(2)}%\n`,
    );

    // Phase 2: try ADD candidates
    log(`========== PHASE 2: try ADD candidates ==========`);
    const addable = ADD_CANDIDATES.filter((c) => all.includes(c));
    improved = true;
    while (improved) {
      improved = false;
      let bestAdd: { sym: string; r: ReturnType<typeof evalCfg> } | null = null;
      for (const add of addable) {
        if (current.includes(add)) continue;
        const newSet = [...current, add];
        const r = evalCfg(buildCfg(newSet), aligned, newSet);
        log(
          `  add ${add} → ${(r.pr * 100).toFixed(2)}% (${r.passes}/${r.windows}) TL=${r.tl} DL=${r.dl}`,
        );
        if (
          r.pr > cur.pr ||
          (r.pr === cur.pr && r.tl + r.dl < cur.tl + cur.dl)
        ) {
          if (!bestAdd || r.pr > bestAdd.r.pr) bestAdd = { sym: add, r };
        }
      }
      if (bestAdd) {
        log(
          `  → ADD ${bestAdd.sym} accepted (${(bestAdd.r.pr * 100).toFixed(2)}% > ${(cur.pr * 100).toFixed(2)}%)`,
        );
        current = [...current, bestAdd.sym];
        cur = bestAdd.r;
        improved = true;
      } else {
        log(`  → no add improves, stop phase 2.`);
      }
    }

    log(`\n========== FINAL CHAMPION ==========`);
    log(`Pairs: ${current.join(", ")}`);
    log(
      `Pass-rate: ${(cur.pr * 100).toFixed(2)}% (${cur.passes}/${cur.windows})`,
    );
    log(`TL: ${cur.tl} / DL: ${cur.dl} / med: ${cur.med}d`);

    expect(cur.passes).toBeGreaterThan(0);
  });
});
