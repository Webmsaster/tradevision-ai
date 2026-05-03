/**
 * V5_QUARTZ Walk-Forward Asset Re-Selection — Overfitting Audit on V5_QUARTZ_LITE.
 *
 * V5_QUARTZ_LITE was built by greedy in-sample drop of 6 assets
 * {AVAX, DOGE, INJ, RUNE, SAND, ARB}, optimised on the FULL 5.71y history.
 * That single greedy pass selects the 9-asset pool that *happened* to perform
 * best on the entire dataset → classic in-sample selection bias.
 *
 * The Random-Drop Bootstrap (`_v5QuartzRandomDropBootstrap.test.ts`) tells us
 * whether the cherry-picked drop beats a random drop, but it doesn't tell us
 * whether the *same* selection rule generalises forward in time.
 *
 * Walk-Forward Asset Re-Selection answers:
 *   "If we re-ran the greedy asset-drop optimiser on each prior year's data
 *    (TRAIN), would the chosen 9-asset pool still pass on the NEXT year (TEST)?"
 *
 * If the chosen pool is similar across years (high set-intersection) AND
 * test-window pass-rate stays >70% → the LITE selection generalises and is NOT
 * an overfit. If the chosen pool flips wildly between years (low intersection)
 * or test pass-rate collapses → the LITE drop is overfit to one snapshot of
 * history and won't survive future data.
 *
 * Method:
 *   1. Load 5.71y of 30m bars for the 15-asset V5_QUARTZ basket + crossAsset
 *      filters (BTC/ETH for CAF). Align to common timestamp grid.
 *   2. Split aligned data into 5 calendar-yearly chunks (Y1..Y5) by bar count.
 *   3. For each year Yk (k=2..5):
 *        a) TRAIN = concat(Y1..Y_{k-1})
 *        b) Greedy-search 9-asset subset of 15 that maximises pass-rate on
 *           TRAIN (greedy backward elimination: drop one asset at a time, the
 *           drop that yields the highest remaining-pool pass-rate, repeat 6×).
 *           Greedy is O(15+14+13+12+11+10) = 75 evaluations vs C(15,6)=5005
 *           exhaustive — same algorithm that built LITE in the first place.
 *        c) TEST = Yk → evaluate the chosen pool on the held-out year.
 *   4. Output:
 *        - Best 9-asset pool per year + chosen drops
 *        - Set-intersection across all 4 yearly pools (stability)
 *        - Per-year TRAIN/TEST pass-rate (overfit gap = TRAIN − TEST)
 *        - Walk-forward weighted-average TEST pass-rate (weighted by windows)
 *        - Comparison vs static LITE pool on every yearly TEST window
 *
 * Interpretation:
 *   - High pool stability (e.g. ≥7/9 assets common to all 4 yearly winners)
 *     AND mean TEST pass-rate >70% → LITE asset selection is robust.
 *   - Low stability OR mean TEST pass-rate <60% → LITE was overfit to the
 *     full-history snapshot, real-world live pass will degrade as market
 *     regime shifts.
 *
 * Engine settings:
 *   Inherits LITE-style overrides (liveCaps 5%/40%, pauseAtTargetReached=true,
 *   dailyPeakTrailingStop trail=2%) for apples-to-apples comparison vs the
 *   published LITE 80.72% number.
 *
 * Run with:
 *   node ./node_modules/vitest/vitest.mjs run \
 *     scripts/_v5QuartzWalkForwardAssetSelection.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48; // 30m timeframe
const NUM_YEARS = 5;
const KEEP_COUNT = 9; // V5_QUARTZ_LITE keeps 9 of 15 assets
const DROP_COUNT = 6; // greedy drops this many
const LITE_PASS_RATE_PUBLISHED = 0.8072; // V5_QUARTZ_LITE full-history baseline
const LITE_KEEP = [
  "BTC-TREND",
  "ETH-TREND",
  "BNB-TREND",
  "ADA-TREND",
  "LTC-TREND",
  "BCH-TREND",
  "ETC-TREND",
  "XRP-TREND",
  "AAVE-TREND",
];

// ─── Eval helpers (same as Round 19 / random-drop bootstrap) ───────────────
function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}

function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Evaluate a config on a sliced, pre-aligned dataset.
 * Slice contract: every symbol in `data` already has the same bar count.
 */
function evaluateOnSlice(
  cfg: FtmoDaytrade24hConfig,
  slice: Record<string, Candle[]>,
) {
  const symbols = syms(cfg);
  // All symbols are pre-aligned, so n is just the slice length of any one.
  const n = Math.min(...symbols.map((s) => slice[s]?.length ?? 0));
  if (!isFinite(n) || n === 0) {
    return { windows: 0, passRate: 0, tlPct: 0, dlPct: 0, med: 0, p90: 0 };
  }
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY; // step=3d (LITE published anchor)
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0;
  const passDays: number[] = [];
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const window: Record<string, Candle[]> = {};
    for (const s of symbols) window[s] = slice[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(window, cfg);
    windows++;
    if (res.passed) {
      passes++;
      if (res.passDay && res.passDay > 0) passDays.push(res.passDay);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
  }
  passDays.sort((a, b) => a - b);
  return {
    windows,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
    med: pctile(passDays, 0.5),
    p90: pctile(passDays, 0.9),
  };
}

/** Build a config keeping only the named assets, with LITE-style overrides. */
function buildCfg(
  baseCfg: FtmoDaytrade24hConfig,
  keepAssets: string[],
): FtmoDaytrade24hConfig {
  const keepSet = new Set(keepAssets);
  return {
    ...baseCfg,
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    dailyPeakTrailingStop: { trailDistance: 0.02 },
    pauseAtTargetReached: true,
    assets: baseCfg.assets.filter((a) => keepSet.has(a.symbol)),
  };
}

/** Slice an aligned dataset by bar-index range [from, to). */
function sliceData(
  aligned: Record<string, Candle[]>,
  from: number,
  to: number,
): Record<string, Candle[]> {
  const out: Record<string, Candle[]> = {};
  for (const [s, candles] of Object.entries(aligned)) {
    out[s] = candles.slice(from, to);
  }
  return out;
}

/**
 * Greedy backward elimination: drop one asset at a time, picking the drop
 * that yields the highest remaining-pool pass-rate. Stop after DROP_COUNT
 * drops. Returns the chosen 9-asset pool plus per-step trace.
 *
 * Cost: 15 + 14 + 13 + 12 + 11 + 10 = 75 evaluations per fold. Vs exhaustive
 * C(15,9) = 5005. Greedy is the same algorithm that built LITE.
 */
function greedyDropOnTrain(
  baseCfg: FtmoDaytrade24hConfig,
  trainSlice: Record<string, Candle[]>,
  allAssets: string[],
): {
  keep: string[];
  drops: string[];
  trace: Array<{ step: number; dropped: string; pass: number }>;
} {
  let pool = [...allAssets];
  const drops: string[] = [];
  const trace: Array<{ step: number; dropped: string; pass: number }> = [];
  for (let step = 1; step <= DROP_COUNT; step++) {
    let bestPass = -1;
    let bestDrop: string | null = null;
    for (const candidate of pool) {
      const trial = pool.filter((a) => a !== candidate);
      const cfg = buildCfg(baseCfg, trial);
      const r = evaluateOnSlice(cfg, trainSlice);
      if (r.passRate > bestPass) {
        bestPass = r.passRate;
        bestDrop = candidate;
      }
    }
    if (bestDrop === null) break;
    pool = pool.filter((a) => a !== bestDrop);
    drops.push(bestDrop);
    trace.push({ step, dropped: bestDrop, pass: bestPass });
  }
  return { keep: pool, drops, trace };
}

describe(
  "V5_QUARTZ walk-forward asset re-selection (overfitting audit)",
  { timeout: 12 * 60 * 60_000 },
  () => {
    it("yearly TRAIN-then-TEST greedy re-selection vs static LITE pool", async () => {
      const QZ = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ;
      const allAssetSyms = QZ.assets.map((a) => a.symbol); // 15 assets
      expect(allAssetSyms.length).toBe(15);

      // ── Load 5.71y / 30m for all 15 quartz assets + CAF ─────────────────
      const symbols = syms(QZ);
      console.log(`Loading ${symbols.length} symbols (30m, ~5.7y)...`);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: 100000,
            maxPages: 120,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch {
          // skip
        }
      }
      const aligned = alignCommon(data, symbols);
      const totalBars = Math.min(...symbols.map((s) => aligned[s].length));
      const totalDays = totalBars / BARS_PER_DAY;
      const totalYears = totalDays / 365;
      console.log(
        `Aligned: ${totalBars} bars across ${symbols.length} symbols = ` +
          `${totalDays.toFixed(0)} days = ${totalYears.toFixed(2)} years`,
      );

      // ── Split into NUM_YEARS equal chunks ───────────────────────────────
      const chunkSize = Math.floor(totalBars / NUM_YEARS);
      const chunks: Array<{ from: number; to: number; days: number }> = [];
      for (let i = 0; i < NUM_YEARS; i++) {
        const from = i * chunkSize;
        const to = i === NUM_YEARS - 1 ? totalBars : (i + 1) * chunkSize;
        chunks.push({ from, to, days: (to - from) / BARS_PER_DAY });
      }
      console.log(`\nYearly chunks (bars):`);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        console.log(
          `  Y${i + 1}: bars [${c.from}..${c.to}) = ${c.to - c.from} bars = ${c.days.toFixed(0)}d`,
        );
      }

      // ── Walk-forward folds: for k=2..NUM_YEARS, TRAIN=Y1..Y_{k-1}, TEST=Yk ──
      const folds: Array<{
        testYear: number;
        trainBars: number;
        testBars: number;
        keep: string[];
        drops: string[];
        trace: Array<{ step: number; dropped: string; pass: number }>;
        trainPass: number;
        trainWindows: number;
        testPass: number;
        testWindows: number;
        testMed: number;
        testP90: number;
        testTL: number;
        liteTestPass: number;
        liteTestWindows: number;
      }> = [];

      console.log(`\n=== WALK-FORWARD FOLDS ===`);
      for (let k = 2; k <= NUM_YEARS; k++) {
        const trainFrom = chunks[0].from;
        const trainTo = chunks[k - 2].to;
        const testFrom = chunks[k - 1].from;
        const testTo = chunks[k - 1].to;

        const trainSlice = sliceData(aligned, trainFrom, trainTo);
        const testSlice = sliceData(aligned, testFrom, testTo);

        console.log(
          `\nFold k=${k}: TRAIN=Y1..Y${k - 1} ([${trainFrom}..${trainTo}), ` +
            `${(trainTo - trainFrom) / BARS_PER_DAY}d) → TEST=Y${k} ` +
            `([${testFrom}..${testTo}), ${(testTo - testFrom) / BARS_PER_DAY}d)`,
        );

        // Greedy-drop on TRAIN
        const { keep, drops, trace } = greedyDropOnTrain(
          QZ,
          trainSlice,
          allAssetSyms,
        );
        console.log(`  Greedy trace (TRAIN):`);
        for (const t of trace) {
          console.log(
            `    step ${t.step}: drop ${t.dropped.replace("-TREND", "")} → ` +
              `pass ${(t.pass * 100).toFixed(2)}%`,
          );
        }

        // Re-evaluate selected pool on TRAIN (its full pass-rate after all drops)
        const trainCfg = buildCfg(QZ, keep);
        const trainRes = evaluateOnSlice(trainCfg, trainSlice);

        // Evaluate selected pool on held-out TEST
        const testRes = evaluateOnSlice(trainCfg, testSlice);

        // Evaluate static LITE pool on the same TEST (for direct comparison)
        const liteCfg = buildCfg(QZ, LITE_KEEP);
        const liteRes = evaluateOnSlice(liteCfg, testSlice);

        console.log(
          `  Selected keep (9): ${keep.map((a) => a.replace("-TREND", "")).join(", ")}`,
        );
        console.log(
          `  Selected drops (6): ${drops.map((a) => a.replace("-TREND", "")).join(", ")}`,
        );
        console.log(
          `  TRAIN  pass=${(trainRes.passRate * 100).toFixed(2)}%  windows=${trainRes.windows}`,
        );
        console.log(
          `  TEST   pass=${(testRes.passRate * 100).toFixed(2)}%  windows=${testRes.windows}  ` +
            `med=${testRes.med}d  p90=${testRes.p90}d  TL=${(testRes.tlPct * 100).toFixed(2)}%`,
        );
        console.log(
          `  LITE   pass=${(liteRes.passRate * 100).toFixed(2)}% (static pool on same TEST)`,
        );
        const gap = trainRes.passRate - testRes.passRate;
        console.log(
          `  Overfit gap (TRAIN-TEST): ${(gap * 100).toFixed(2)}pp ` +
            `${gap > 0.1 ? "⚠ overfit" : "✓ generalises"}`,
        );

        folds.push({
          testYear: k,
          trainBars: trainTo - trainFrom,
          testBars: testTo - testFrom,
          keep,
          drops,
          trace,
          trainPass: trainRes.passRate,
          trainWindows: trainRes.windows,
          testPass: testRes.passRate,
          testWindows: testRes.windows,
          testMed: testRes.med,
          testP90: testRes.p90,
          testTL: testRes.tlPct,
          liteTestPass: liteRes.passRate,
          liteTestWindows: liteRes.windows,
        });
      }

      // ── Stability: set-intersection across all chosen pools ────────────
      console.log(`\n=== POOL STABILITY (set-intersection) ===`);
      const pools = folds.map((f) => new Set(f.keep));
      const intersection = [...pools[0]].filter((a) =>
        pools.every((s) => s.has(a)),
      );
      const union = new Set<string>();
      for (const p of pools) for (const a of p) union.add(a);

      console.log(
        `Pools per year: ${folds
          .map(
            (f) =>
              `Y${f.testYear}:[${f.keep.map((a) => a.replace("-TREND", "")).join(",")}]`,
          )
          .join("\n              ")}`,
      );
      console.log(
        `\nIntersection (assets in EVERY yearly pool): ${intersection.length}/${KEEP_COUNT}` +
          `\n  ${
            intersection
              .map((a) => a.replace("-TREND", ""))
              .sort()
              .join(", ") || "(none)"
          }`,
      );
      console.log(
        `Union (assets in ANY yearly pool): ${union.size}/15` +
          `\n  ${[...union]
            .map((a) => a.replace("-TREND", ""))
            .sort()
            .join(", ")}`,
      );

      // Pool similarity vs LITE static
      const litePoolSet = new Set(LITE_KEEP);
      console.log(
        `\nLITE static pool: ${LITE_KEEP.map((a) => a.replace("-TREND", "")).join(", ")}`,
      );
      for (const f of folds) {
        const overlap = f.keep.filter((a) => litePoolSet.has(a));
        console.log(
          `  Y${f.testYear} ∩ LITE: ${overlap.length}/9 (${overlap.map((a) => a.replace("-TREND", "")).join(",")})`,
        );
      }

      // ── Walk-forward weighted-average TEST pass-rate ───────────────────
      const totalTestWindows = folds.reduce((acc, f) => acc + f.testWindows, 0);
      const wfPassRate =
        totalTestWindows > 0
          ? folds.reduce((acc, f) => acc + f.testPass * f.testWindows, 0) /
            totalTestWindows
          : 0;
      const liteWfPassRate =
        totalTestWindows > 0
          ? folds.reduce(
              (acc, f) => acc + f.liteTestPass * f.liteTestWindows,
              0,
            ) / folds.reduce((acc, f) => acc + f.liteTestWindows, 0)
          : 0;

      console.log(`\n=== WALK-FORWARD AGGREGATE ===`);
      console.log(`Per-year TEST pass-rates:`);
      for (const f of folds) {
        console.log(
          `  Y${f.testYear}  re-selected=${(f.testPass * 100).toFixed(2)}%  ` +
            `LITE-static=${(f.liteTestPass * 100).toFixed(2)}%  ` +
            `Δ=${((f.testPass - f.liteTestPass) * 100).toFixed(2)}pp  ` +
            `windows=${f.testWindows}`,
        );
      }
      console.log(
        `\nWeighted-avg TEST pass-rate (re-selected): ${(wfPassRate * 100).toFixed(2)}%`,
      );
      console.log(
        `Weighted-avg TEST pass-rate (LITE static):  ${(liteWfPassRate * 100).toFixed(2)}%`,
      );
      console.log(
        `Published LITE in-sample pass-rate:         ${(LITE_PASS_RATE_PUBLISHED * 100).toFixed(2)}%`,
      );

      // ── Verdict ─────────────────────────────────────────────────────────
      console.log(`\n=== VERDICT ===`);
      const stabilityRatio = intersection.length / KEEP_COUNT;
      const overfitDrop = LITE_PASS_RATE_PUBLISHED - wfPassRate;
      console.log(
        `Stability (∩/9):         ${(stabilityRatio * 100).toFixed(0)}% — ` +
          `${stabilityRatio >= 0.7 ? "HIGH (pool generalises)" : stabilityRatio >= 0.5 ? "MODERATE" : "LOW (selection drifts year-to-year)"}`,
      );
      console.log(
        `In-sample → walk-forward: ${(overfitDrop * 100).toFixed(2)}pp drop — ` +
          `${overfitDrop < 0.05 ? "minimal overfit" : overfitDrop < 0.1 ? "moderate overfit" : "SIGNIFICANT overfit"}`,
      );
      console.log(
        `WF mean pass >70%?       ${wfPassRate >= 0.7 ? "YES — robust" : "NO — degraded under walk-forward"}`,
      );
      console.log(
        `\nIf stability is HIGH AND WF pass-rate >70% → V5_QUARTZ_LITE asset` +
          `\nselection generalises forward and is NOT a one-snapshot overfit.` +
          `\nIf stability is LOW OR WF pass-rate <60% → LITE drop was overfit;` +
          `\nlive deployment will degrade as market regime shifts.`,
      );

      expect(folds.length).toBe(NUM_YEARS - 1);
    });
  },
);
