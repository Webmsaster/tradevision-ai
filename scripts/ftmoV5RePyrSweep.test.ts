/**
 * V5 Re-Entry + Pyramid sweep.
 *
 * Goal: push V5 from ~46.7% pass-rate towards 50% via:
 *   A) Re-entry after stop (engine field `reEntryAfterStop`)
 *   B) Pyramid (virtual *-PYR asset with minEquityGain)
 *   C) Combo of A + B
 *
 * Methodology: multi-fold OOS like R47 (30d window / 3d step, 5.71y data).
 * Realistic FTMO costs (40bp / 12bp slippage). 9 cryptos.
 *
 * Acceptance: at least +1.5pp pass-rate vs baseline,
 *             TL increase < +0.5pp,
 *             median-pass-day not lost.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  loadBinanceFundingRate,
  alignFundingToCandles,
} from "./_loadFundingRate";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_REPYR_${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
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

// ---------- Config builders ----------

/** Apply realistic FTMO costs (40bp / 12bp slip) to asset list — like V5_STEP2. */
function withRealCosts(assets: Daytrade24hAssetCfg[]): Daytrade24hAssetCfg[] {
  return assets.map((a) => ({ ...a, costBp: 40, slippageBp: 12 }));
}

/** Baseline = V5 with FTMO-real costs. */
function buildBaseline(): FtmoDaytrade24hConfig {
  return {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    assets: withRealCosts(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets),
  };
}

/** Variant A — Re-entry after stop. */
function buildReEntry(
  windowBars: number,
  maxRetries: number,
): FtmoDaytrade24hConfig {
  const cfg = buildBaseline();
  return {
    ...cfg,
    reEntryAfterStop: { windowBars, maxRetries },
  };
}

/**
 * Variant B — Pyramid via duplicated *-PYR asset.
 * Engine fires the PYR asset only when equity-1 >= triggerPct.
 *
 * `secondTrancheSize` scales the PYR-asset's riskFrac relative to the
 * original (1.0 = same size, 0.5 = half size).
 *
 * `maxPyramidLevels` adds additional PYR2 layers stacked on higher
 * minEquityGain thresholds.
 */
function buildPyramid(
  triggerPct: number,
  secondTrancheSize: number,
  maxPyramidLevels: number,
): FtmoDaytrade24hConfig {
  const base = buildBaseline();
  const baseAssets = base.assets;
  const pyrAssets: Daytrade24hAssetCfg[] = [];
  for (let lvl = 1; lvl <= maxPyramidLevels; lvl++) {
    const trigger = triggerPct * lvl; // PYR1 @ X, PYR2 @ 2X, ...
    for (const a of baseAssets) {
      pyrAssets.push({
        ...a,
        symbol: `${a.symbol}-PYR${lvl}`,
        riskFrac: (a.riskFrac ?? 1.0) * secondTrancheSize,
        minEquityGain: trigger,
      });
    }
  }
  return { ...base, assets: [...baseAssets, ...pyrAssets] };
}

/** Variant C — Combo: re-entry + pyramid. */
function buildCombo(
  windowBars: number,
  maxRetries: number,
  triggerPct: number,
  secondTrancheSize: number,
  maxPyramidLevels: number,
): FtmoDaytrade24hConfig {
  const pyr = buildPyramid(triggerPct, secondTrancheSize, maxPyramidLevels);
  return {
    ...pyr,
    reEntryAfterStop: { windowBars, maxRetries },
  };
}

// ---------- Multi-fold evaluation ----------

interface EvalResult {
  pass: number;
  windows: number;
  totalLoss: number;
  passRate: number;
  tlRate: number;
  medianPassDay: number; // median of pass-day across passing windows
}

function evalCfgFactory(
  data: Record<string, Candle[]>,
  fundingBySymbol: Record<string, (number | null)[]>,
  n: number,
) {
  const winBars = 30 * BARS_PER_DAY; // 30d FTMO Step-1
  const stepBars = 3 * BARS_PER_DAY; //  3d step

  return function evalCfg(cfg: FtmoDaytrade24hConfig): EvalResult {
    let pass = 0;
    let totalLoss = 0;
    let windows = 0;
    const passDays: number[] = [];

    for (let s = 0; s + winBars <= n; s += stepBars) {
      const sub: Record<string, Candle[]> = {};
      const subFund: Record<string, (number | null)[]> = {};
      for (const sym of SOURCES) {
        sub[sym] = data[sym].slice(s, s + winBars);
        subFund[sym] = fundingBySymbol[sym].slice(s, s + winBars);
      }
      const r = runFtmoDaytrade24h(sub, cfg, subFund);
      windows++;
      if (r.passed) {
        pass++;
        // pass-day = max trade.day among executed trades (last day before pass)
        let maxDay = 0;
        for (const t of r.trades) {
          if (t.day > maxDay) maxDay = t.day;
        }
        passDays.push(maxDay);
      }
      if (r.reason === "total_loss") totalLoss++;
    }
    passDays.sort((a, b) => a - b);
    const medianPassDay =
      passDays.length === 0 ? -1 : passDays[Math.floor(passDays.length / 2)];
    return {
      pass,
      windows,
      totalLoss,
      passRate: windows > 0 ? pass / windows : 0,
      tlRate: windows > 0 ? totalLoss / windows : 0,
      medianPassDay,
    };
  };
}

function fmt(r: EvalResult): string {
  return `${(r.passRate * 100).toFixed(2)}% (${r.pass}/${r.windows}) TL=${
    r.totalLoss
  } (${(r.tlRate * 100).toFixed(2)}%) medDay=${r.medianPassDay}`;
}

// ---------- Sweep ----------

describe("V5 Re-Entry + Pyramid sweep", { timeout: 24 * 3600_000 }, () => {
  it("sweeps re-entry, pyramid, and combo variants", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_REPYR START ${new Date().toISOString()}\n`);

    log("Loading 30000-bar 2h history for 9 cryptos...");
    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      log(`  ${s}: ${data[s].length} bars`);
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);
    log(`Aligned to ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)`);

    const startMs = data[SOURCES[0]][0].openTime;
    const endMs = data[SOURCES[0]][n - 1].openTime + 2 * 3600_000;

    log("Loading funding rates...");
    const fundingBySymbol: Record<string, (number | null)[]> = {};
    for (const s of SOURCES) {
      const rows = await loadBinanceFundingRate(s, startMs, endMs);
      fundingBySymbol[s] = alignFundingToCandles(
        rows,
        data[s].map((c) => c.openTime),
      );
    }

    const evalCfg = evalCfgFactory(data, fundingBySymbol, n);

    // ---------- Baseline ----------
    log("\n========== BASELINE V5 (FTMO-real costs) ==========");
    const baseline = buildBaseline();
    const baseR = evalCfg(baseline);
    log(`baseline: ${fmt(baseR)}`);

    // ---------- Variant A — Re-entry only ----------
    log("\n========== VARIANT A — Re-entry only (8 variants) ==========");
    interface Cand {
      label: string;
      result: EvalResult;
      cfg: FtmoDaytrade24hConfig;
    }
    const candidatesA: Cand[] = [];
    for (const wb of [1, 2, 3, 4]) {
      for (const mr of [1, 2]) {
        const cfg = buildReEntry(wb, mr);
        const r = evalCfg(cfg);
        const label = `A: wb=${wb} mr=${mr}`;
        log(`  ${label}: ${fmt(r)}`);
        candidatesA.push({ label, result: r, cfg });
      }
    }
    candidatesA.sort((a, b) => b.result.passRate - a.result.passRate);
    const bestA = candidatesA[0];
    log(`\n  bestA → ${bestA.label}: ${fmt(bestA.result)}`);

    // ---------- Variant B — Pyramid only ----------
    log("\n========== VARIANT B — Pyramid only (16 variants) ==========");
    const candidatesB: Cand[] = [];
    for (const tp of [0.01, 0.015, 0.02, 0.03]) {
      for (const sz of [0.5, 1.0]) {
        for (const lvl of [1, 2]) {
          const cfg = buildPyramid(tp, sz, lvl);
          const r = evalCfg(cfg);
          const label = `B: tp=${tp} sz=${sz} lvl=${lvl}`;
          log(`  ${label}: ${fmt(r)}`);
          candidatesB.push({ label, result: r, cfg });
        }
      }
    }
    candidatesB.sort((a, b) => b.result.passRate - a.result.passRate);
    const bestB = candidatesB[0];
    log(`\n  bestB → ${bestB.label}: ${fmt(bestB.result)}`);

    // ---------- Variant C — Combo ----------
    log("\n========== VARIANT C — Combo (top 5) ==========");
    // Take top-2 A × top-2 B + a balanced safe-pick
    const topA = candidatesA.slice(0, 2);
    const topB = candidatesB.slice(0, 2);
    const candidatesC: Cand[] = [];
    for (const a of topA) {
      const aMatch = a.label.match(/wb=(\d+)\s+mr=(\d+)/);
      if (!aMatch) continue;
      const wb = Number(aMatch[1]);
      const mr = Number(aMatch[2]);
      for (const b of topB) {
        const bMatch = b.label.match(/tp=([\d.]+)\s+sz=([\d.]+)\s+lvl=(\d+)/);
        if (!bMatch) continue;
        const tp = Number(bMatch[1]);
        const sz = Number(bMatch[2]);
        const lvl = Number(bMatch[3]);
        const cfg = buildCombo(wb, mr, tp, sz, lvl);
        const r = evalCfg(cfg);
        const label = `C: wb=${wb} mr=${mr} tp=${tp} sz=${sz} lvl=${lvl}`;
        log(`  ${label}: ${fmt(r)}`);
        candidatesC.push({ label, result: r, cfg });
      }
    }
    // Add one safe-pick: smallest re-entry + smallest pyramid
    {
      const cfg = buildCombo(1, 1, 0.015, 0.5, 1);
      const r = evalCfg(cfg);
      const label = `C: wb=1 mr=1 tp=0.015 sz=0.5 lvl=1 (safe)`;
      log(`  ${label}: ${fmt(r)}`);
      candidatesC.push({ label, result: r, cfg });
    }
    candidatesC.sort((a, b) => b.result.passRate - a.result.passRate);
    const bestC = candidatesC[0];
    log(`\n  bestC → ${bestC.label}: ${fmt(bestC.result)}`);

    // ---------- Final report + acceptance ----------
    log("\n========== FINAL REPORT ==========");
    log(`baseline: ${fmt(baseR)}`);
    log(`bestA   : ${bestA.label} → ${fmt(bestA.result)}`);
    log(`bestB   : ${bestB.label} → ${fmt(bestB.result)}`);
    log(`bestC   : ${bestC.label} → ${fmt(bestC.result)}`);

    function passDelta(r: EvalResult): number {
      return (r.passRate - baseR.passRate) * 100;
    }
    function tlDelta(r: EvalResult): number {
      return (r.tlRate - baseR.tlRate) * 100;
    }
    function medianDelta(r: EvalResult): number {
      return r.medianPassDay - baseR.medianPassDay;
    }

    function meetsAcceptance(r: EvalResult): boolean {
      return (
        passDelta(r) >= 1.5 && tlDelta(r) <= 0.5 && medianDelta(r) <= 0 // median day not lost (smaller-or-equal is fine)
      );
    }

    const winners: Cand[] = [];
    for (const c of [bestA, bestB, bestC]) {
      log(
        `\n  ${c.label}: Δpass=${passDelta(c.result).toFixed(
          2,
        )}pp / Δtl=${tlDelta(c.result).toFixed(
          2,
        )}pp / ΔmedDay=${medianDelta(c.result)} → ${
          meetsAcceptance(c.result) ? "ACCEPT" : "reject"
        }`,
      );
      if (meetsAcceptance(c.result)) winners.push(c);
    }

    // Pick the winner with the highest pass-rate.
    if (winners.length > 0) {
      winners.sort((a, b) => b.result.passRate - a.result.passRate);
      const champ = winners[0];
      log(`\n========== WINNER: ${champ.label} ==========`);
      log(fmt(champ.result));
      writeFileSync(
        `${LOG_DIR}/V5_REPYR_BEST.json`,
        JSON.stringify(
          { label: champ.label, cfg: champ.cfg, result: champ.result },
          null,
          2,
        ),
      );
    } else {
      log("\n========== NO WINNER — Plateau confirmed ==========");
    }

    expect(true).toBe(true);
  });
});
