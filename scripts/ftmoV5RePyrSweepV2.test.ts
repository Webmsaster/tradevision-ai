/**
 * V5 Re-Entry + Pyramid sweep V2 — extended re-run.
 *
 * Predecessor (`ftmoV5RePyrSweep.test.ts`) covered:
 *   A) reEntryAfterStop wb∈{1,2,3,4} mr∈{1,2}        →  8 variants
 *   B) virtual *-PYR asset    tp∈{1,1.5,2,3%}, sz∈{0.5,1.0}, lvl∈{1,2}  → 16
 *   C) Top-2 A × Top-2 B + safe-pick combo                              → 5
 *
 * R57 explored pullbackEntry generically and got 0 wins. V2 fills the gaps:
 *
 *   D) ASYMMETRIC pullbackEntry — only on high-vol assets (DOGE/AVAX/LINK).
 *      Trade-off: tighter dollar stop on noisy assets, no signal-loss on
 *      slow-trend ones (BTC/ETH).
 *
 *   E) Re-entry × asymmetric pullback combo.
 *
 *   F) atrStop addition (V5 lacks atrStop — V239 engine breakthrough never
 *      ported back to V5). atrStop alone + atrStop+reEntry combos.
 *
 *   G) Wider re-entry window grid: wb∈{1,2,3,4,6,8}, mr∈{1,2,3} = 18 variants.
 *
 *   H) Pyramid lvl=3 (PYR1+PYR2+PYR3 stacked) — predecessor only tested lvl≤2.
 *
 * Total ~70 variants. Multi-fold OOS (30d/3d-step on 5.71y) with FTMO-real
 * costs (40bp/12bp), 9 cryptos.
 *
 * Acceptance: ≥+1.5pp pass / ΔTL ≤+0.5pp / median-pass-day not lost.
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
const LOG_FILE = `${LOG_DIR}/V5_REPYR_V2_${new Date()
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

/** High-volatility assets where pullbackEntry is most likely to add R:R. */
const HIGH_VOL_SYMBOLS = new Set(["DOGE-TREND", "AVAX-TREND", "LINK-TREND"]);

// ---------- Config builders ----------

function withRealCosts(assets: Daytrade24hAssetCfg[]): Daytrade24hAssetCfg[] {
  return assets.map((a) => ({ ...a, costBp: 40, slippageBp: 12 }));
}

function buildBaseline(): FtmoDaytrade24hConfig {
  return {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    assets: withRealCosts(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets),
  };
}

/** A — Re-entry only (extended grid). */
function buildReEntry(
  windowBars: number,
  maxRetries: number,
): FtmoDaytrade24hConfig {
  const cfg = buildBaseline();
  return { ...cfg, reEntryAfterStop: { windowBars, maxRetries } };
}

/** B — Pyramid via virtual *-PYR asset (extended to lvl=3). */
function buildPyramid(
  triggerPct: number,
  secondTrancheSize: number,
  maxPyramidLevels: number,
): FtmoDaytrade24hConfig {
  const base = buildBaseline();
  const baseAssets = base.assets;
  const pyrAssets: Daytrade24hAssetCfg[] = [];
  for (let lvl = 1; lvl <= maxPyramidLevels; lvl++) {
    const trigger = triggerPct * lvl;
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

/** D — Asymmetric pullbackEntry: only high-vol assets get pullback. */
function buildAsymPullback(
  pullbackPct: number,
  maxWaitBars: number,
): FtmoDaytrade24hConfig {
  const base = buildBaseline();
  return {
    ...base,
    assets: base.assets.map((a) =>
      HIGH_VOL_SYMBOLS.has(a.symbol)
        ? { ...a, pullbackEntry: { pullbackPct, maxWaitBars } }
        : a,
    ),
  };
}

/** E — Asymmetric pullback + re-entry combo. */
function buildAsymPbReEntry(
  pullbackPct: number,
  maxWaitBars: number,
  windowBars: number,
  maxRetries: number,
): FtmoDaytrade24hConfig {
  const cfg = buildAsymPullback(pullbackPct, maxWaitBars);
  return { ...cfg, reEntryAfterStop: { windowBars, maxRetries } };
}

/** F — atrStop addition (V239 breakthrough). */
function buildAtrStop(period: number, stopMult: number): FtmoDaytrade24hConfig {
  return { ...buildBaseline(), atrStop: { period, stopMult } };
}

/** F2 — atrStop + reEntry combo. */
function buildAtrReEntry(
  period: number,
  stopMult: number,
  windowBars: number,
  maxRetries: number,
): FtmoDaytrade24hConfig {
  const cfg = buildAtrStop(period, stopMult);
  return { ...cfg, reEntryAfterStop: { windowBars, maxRetries } };
}

/** F3 — atrStop + Pyramid combo. */
function buildAtrPyr(
  period: number,
  stopMult: number,
  triggerPct: number,
  secondTrancheSize: number,
  maxPyramidLevels: number,
): FtmoDaytrade24hConfig {
  const pyr = buildPyramid(triggerPct, secondTrancheSize, maxPyramidLevels);
  return { ...pyr, atrStop: { period, stopMult } };
}

/** C — original combo: re-entry + pyramid. */
function buildCombo(
  windowBars: number,
  maxRetries: number,
  triggerPct: number,
  secondTrancheSize: number,
  maxPyramidLevels: number,
): FtmoDaytrade24hConfig {
  const pyr = buildPyramid(triggerPct, secondTrancheSize, maxPyramidLevels);
  return { ...pyr, reEntryAfterStop: { windowBars, maxRetries } };
}

// ---------- Multi-fold evaluation ----------

interface EvalResult {
  pass: number;
  windows: number;
  totalLoss: number;
  passRate: number;
  tlRate: number;
  medianPassDay: number;
}

function evalCfgFactory(
  data: Record<string, Candle[]>,
  fundingBySymbol: Record<string, (number | null)[]>,
  n: number,
) {
  const winBars = 30 * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;

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
        let maxDay = 0;
        for (const t of r.trades) if (t.day > maxDay) maxDay = t.day;
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

interface Cand {
  label: string;
  result: EvalResult;
  cfg: FtmoDaytrade24hConfig;
  family: "A" | "B" | "C" | "D" | "E" | "F" | "F2" | "F3";
}

// ---------- Sweep ----------

describe("V5 Re-Entry + Pyramid V2 sweep", { timeout: 24 * 3600_000 }, () => {
  it("sweeps extended re-entry, pyramid, asym-pullback, atrStop variants", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_REPYR_V2 START ${new Date().toISOString()}\n`);

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

    const all: Cand[] = [];

    // ---------- A — Re-entry extended grid ----------
    log("\n========== A — Re-entry extended (18 variants) ==========");
    for (const wb of [1, 2, 3, 4, 6, 8]) {
      for (const mr of [1, 2, 3]) {
        const cfg = buildReEntry(wb, mr);
        const r = evalCfg(cfg);
        const label = `A: wb=${wb} mr=${mr}`;
        log(`  ${label}: ${fmt(r)}`);
        all.push({ label, result: r, cfg, family: "A" });
      }
    }

    // ---------- B — Pyramid extended (lvl up to 3) ----------
    log("\n========== B — Pyramid extended (24 variants) ==========");
    for (const tp of [0.01, 0.015, 0.02, 0.03]) {
      for (const sz of [0.5, 1.0]) {
        for (const lvl of [1, 2, 3]) {
          const cfg = buildPyramid(tp, sz, lvl);
          const r = evalCfg(cfg);
          const label = `B: tp=${tp} sz=${sz} lvl=${lvl}`;
          log(`  ${label}: ${fmt(r)}`);
          all.push({ label, result: r, cfg, family: "B" });
        }
      }
    }

    // ---------- D — Asymmetric pullback only ----------
    log(
      "\n========== D — Asym pullback (high-vol only, 9 variants) ==========",
    );
    for (const pp of [0.005, 0.01, 0.015]) {
      for (const wait of [1, 2, 4]) {
        const cfg = buildAsymPullback(pp, wait);
        const r = evalCfg(cfg);
        const label = `D: pb=${pp} wait=${wait}`;
        log(`  ${label}: ${fmt(r)}`);
        all.push({ label, result: r, cfg, family: "D" });
      }
    }

    // ---------- F — atrStop only ----------
    log("\n========== F — atrStop only (8 variants) ==========");
    for (const period of [10, 14, 18]) {
      for (const m of [1.5, 2.5, 4.0]) {
        // skip extreme combos to save time, keep one cheap & two strong
        if (period === 10 && m === 4.0) continue;
        if (period === 18 && m === 1.5) continue;
        const cfg = buildAtrStop(period, m);
        const r = evalCfg(cfg);
        const label = `F: atr p=${period} m=${m}`;
        log(`  ${label}: ${fmt(r)}`);
        all.push({ label, result: r, cfg, family: "F" });
      }
    }

    // ---------- E — Asym pullback × re-entry (top combos) ----------
    // Pick the top-2 from D and re-combine with cheap re-entry windows.
    log(
      "\n========== E — Asym pullback × re-entry (top-D × top-A, 6 variants) ==========",
    );
    const topD = all
      .filter((c) => c.family === "D")
      .sort((a, b) => b.result.passRate - a.result.passRate)
      .slice(0, 2);
    const topA = all
      .filter((c) => c.family === "A")
      .sort((a, b) => b.result.passRate - a.result.passRate)
      .slice(0, 3);
    for (const d of topD) {
      const dm = d.label.match(/pb=([\d.]+)\s+wait=(\d+)/);
      if (!dm) continue;
      const pp = Number(dm[1]);
      const w = Number(dm[2]);
      for (const a of topA) {
        const am = a.label.match(/wb=(\d+)\s+mr=(\d+)/);
        if (!am) continue;
        const wb = Number(am[1]);
        const mr = Number(am[2]);
        const cfg = buildAsymPbReEntry(pp, w, wb, mr);
        const r = evalCfg(cfg);
        const label = `E: pb=${pp} wait=${w} wb=${wb} mr=${mr}`;
        log(`  ${label}: ${fmt(r)}`);
        all.push({ label, result: r, cfg, family: "E" });
      }
    }

    // ---------- F2 — atrStop × re-entry (top-A × top-F) ----------
    log("\n========== F2 — atrStop × re-entry (top combos) ==========");
    const topF = all
      .filter((c) => c.family === "F")
      .sort((a, b) => b.result.passRate - a.result.passRate)
      .slice(0, 2);
    for (const f of topF) {
      const fm = f.label.match(/p=(\d+)\s+m=([\d.]+)/);
      if (!fm) continue;
      const period = Number(fm[1]);
      const m = Number(fm[2]);
      for (const a of topA) {
        const am = a.label.match(/wb=(\d+)\s+mr=(\d+)/);
        if (!am) continue;
        const wb = Number(am[1]);
        const mr = Number(am[2]);
        const cfg = buildAtrReEntry(period, m, wb, mr);
        const r = evalCfg(cfg);
        const label = `F2: atr p=${period} m=${m} wb=${wb} mr=${mr}`;
        log(`  ${label}: ${fmt(r)}`);
        all.push({ label, result: r, cfg, family: "F2" });
      }
    }

    // ---------- F3 — atrStop × Pyramid (top-B × top-F) ----------
    log("\n========== F3 — atrStop × Pyramid (top combos) ==========");
    const topB = all
      .filter((c) => c.family === "B")
      .sort((a, b) => b.result.passRate - a.result.passRate)
      .slice(0, 2);
    for (const f of topF) {
      const fm = f.label.match(/p=(\d+)\s+m=([\d.]+)/);
      if (!fm) continue;
      const period = Number(fm[1]);
      const m = Number(fm[2]);
      for (const b of topB) {
        const bm = b.label.match(/tp=([\d.]+)\s+sz=([\d.]+)\s+lvl=(\d+)/);
        if (!bm) continue;
        const tp = Number(bm[1]);
        const sz = Number(bm[2]);
        const lvl = Number(bm[3]);
        const cfg = buildAtrPyr(period, m, tp, sz, lvl);
        const r = evalCfg(cfg);
        const label = `F3: atr p=${period} m=${m} tp=${tp} sz=${sz} lvl=${lvl}`;
        log(`  ${label}: ${fmt(r)}`);
        all.push({ label, result: r, cfg, family: "F3" });
      }
    }

    // ---------- C — Original combos (top-A × top-B) ----------
    log("\n========== C — re-entry × Pyramid (top combos) ==========");
    for (const a of topA.slice(0, 2)) {
      const am = a.label.match(/wb=(\d+)\s+mr=(\d+)/);
      if (!am) continue;
      const wb = Number(am[1]);
      const mr = Number(am[2]);
      for (const b of topB) {
        const bm = b.label.match(/tp=([\d.]+)\s+sz=([\d.]+)\s+lvl=(\d+)/);
        if (!bm) continue;
        const tp = Number(bm[1]);
        const sz = Number(bm[2]);
        const lvl = Number(bm[3]);
        const cfg = buildCombo(wb, mr, tp, sz, lvl);
        const r = evalCfg(cfg);
        const label = `C: wb=${wb} mr=${mr} tp=${tp} sz=${sz} lvl=${lvl}`;
        log(`  ${label}: ${fmt(r)}`);
        all.push({ label, result: r, cfg, family: "C" });
      }
    }

    // ---------- Final report ----------
    log("\n========== TOP-10 OVERALL ==========");
    const sorted = [...all].sort(
      (a, b) => b.result.passRate - a.result.passRate,
    );
    for (let i = 0; i < Math.min(10, sorted.length); i++) {
      const c = sorted[i];
      log(`  #${i + 1} ${c.label}: ${fmt(c.result)}`);
    }

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
      return passDelta(r) >= 1.5 && tlDelta(r) <= 0.5 && medianDelta(r) <= 1;
    }

    log("\n========== FINAL VS BASELINE ==========");
    log(`baseline: ${fmt(baseR)}`);
    const winners = sorted.filter((c) => meetsAcceptance(c.result));
    log(`winners (acceptance criteria met): ${winners.length}`);
    for (const w of winners.slice(0, 10)) {
      log(
        `  ${w.label}: Δpass=${passDelta(w.result).toFixed(2)}pp / Δtl=${tlDelta(
          w.result,
        ).toFixed(2)}pp / ΔmedDay=${medianDelta(w.result)} → ACCEPT`,
      );
    }

    if (winners.length > 0) {
      const champ = winners[0];
      log(`\n========== WINNER: ${champ.label} ==========`);
      log(fmt(champ.result));
      writeFileSync(
        `${LOG_DIR}/V5_REPYR_V2_BEST.json`,
        JSON.stringify(
          { label: champ.label, cfg: champ.cfg, result: champ.result },
          null,
          2,
        ),
      );
    } else {
      log(
        "\n========== NO WINNER — V5 plateau confirmed at this level ==========",
      );
      // Still write the top-3 as inspection candidates.
      writeFileSync(
        `${LOG_DIR}/V5_REPYR_V2_TOP3.json`,
        JSON.stringify(
          sorted.slice(0, 3).map((c) => ({
            label: c.label,
            result: c.result,
          })),
          null,
          2,
        ),
      );
    }

    expect(true).toBe(true);
  });
});
