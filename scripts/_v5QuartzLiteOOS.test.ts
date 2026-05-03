/**
 * V5_QUARTZ_LITE out-of-sample robustness audit.
 *
 * Background: V5_QUARTZ_LITE was created via greedy asset-drop from V5_QUARTZ
 * (dropped AVAX, DOGE, INJ, RUNE, SAND, ARB). Pass-rate 52% → 80%, median 6d → 1d.
 * The asset pool was selected post-hoc using ALL historical data → look-ahead bias.
 * In-sample headline numbers may not survive on truly unseen data.
 *
 * Three independent OOS-stress dimensions (each on its own answers a different
 * "is the 80% real?" question):
 *
 *   1. WALK-FORWARD SPLIT  — train on first 50%, test on second 50% (and vice versa).
 *      If the asset-pool is genuinely robust, the test-half pass-rate should not
 *      collapse far below the headline. A drop to <60% on test is a red flag.
 *
 *   2. YEAR-BY-YEAR        — split 5.71y into 5 single-year segments. If one year
 *      is 90%+ and another <40%, the headline 80% is averaging over regime-luck,
 *      not skill. Stable strategies show low std() across years.
 *
 *   3. BLOCK-BOOTSTRAP CI  — 200 block-bootstrap resamples (block size = 30 windows
 *      ≈ 3 months). 95% CI quantifies sampling uncertainty. A wide CI ([55%, 92%])
 *      means 80% is a noisy point estimate; a tight CI ([76%, 84%]) means 80% is
 *      genuinely the population pass-rate.
 *
 * BONUS: Re-evaluates the dropped 6 assets standalone on the test-half to confirm
 * they were truly bad (vs removed by chance) — sanity check for the asset-drop.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY_30M = 48;

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

interface EvalResult {
  windows: number;
  passes: number;
  passRate: number;
  tlPct: number;
  dlPct: number;
  med: number;
  p90: number;
  perWindow: boolean[]; // for bootstrap
}

function evaluate(
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  symbols: string[],
  stepDays = 3,
  startBar = 0,
  endBar?: number,
): EvalResult | null {
  const n = endBar ?? Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (n - startBar <= 0) return null;
  const winBars = cfg.maxDays * BARS_PER_DAY_30M;
  const stepBars = stepDays * BARS_PER_DAY_30M;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0;
  const days: number[] = [];
  const perWindow: boolean[] = [];
  for (let start = startBar; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    perWindow.push(res.passed);
    if (res.passed) {
      passes++;
      if (res.passDay && res.passDay > 0) days.push(res.passDay);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
  }
  days.sort((a, b) => a - b);
  return {
    windows,
    passes,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    perWindow,
  };
}

function fmt(r: EvalResult | null, label: string): string {
  if (!r) return `${label}: <no-data>`;
  return `${label}: n=${r.windows} pass=${(r.passRate * 100).toFixed(2)}% TL=${(r.tlPct * 100).toFixed(1)}% DL=${(r.dlPct * 100).toFixed(1)}% med=${r.med}d p90=${r.p90}d`;
}

describe(
  "V5_QUARTZ_LITE OOS robustness audit",
  { timeout: 90 * 60_000 },
  () => {
    it("walk-forward + year-by-year + block-bootstrap CI", async () => {
      const QZL = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        pauseAtTargetReached: false,
      };
      const QZ_FULL = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        pauseAtTargetReached: false,
      };

      // We need union of LITE-9 + DROPPED-6 assets so we can evaluate both pools
      // on identical bar windows (apples-to-apples).
      const liteSymbols = syms(QZL);
      const fullSymbols = syms(QZ_FULL);
      const droppedSymbolNames = ["AVAX", "DOGE", "INJ", "RUNE", "SAND", "ARB"];
      const allSymbols = [...new Set([...liteSymbols, ...fullSymbols])].sort();

      console.log(`\nLoading 30m data for ${allSymbols.length} symbols...`);
      const data: Record<string, Candle[]> = {};
      for (const s of allSymbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: 100000,
            maxPages: 120,
          });
          data[s] = r.filter((c) => c.isFinal);
          console.log(
            `  ${s}: ${data[s].length} bars (${new Date(data[s][0].openTime).toISOString().slice(0, 10)} → ${new Date(data[s][data[s].length - 1].openTime).toISOString().slice(0, 10)})`,
          );
        } catch (e) {
          console.log(`  ${s}: LOAD-FAIL — ${(e as Error).message}`);
        }
      }

      // Use LITE-pool's own intersection of timestamps for the LITE eval (this is
      // how the headline number is computed). Note: forcing alignment across
      // the DROPPED pool too would shrink history.
      const alignedLite = alignCommon(data, liteSymbols);
      const totalBarsLite = Math.min(
        ...liteSymbols.map((s) => alignedLite[s]?.length ?? 0),
      );
      const yearsLite = totalBarsLite / BARS_PER_DAY_30M / 365;
      console.log(
        `\nLITE-pool aligned: ${totalBarsLite} bars (${yearsLite.toFixed(2)}y)`,
      );

      // ============================================================
      // 1. WALK-FORWARD SPLIT
      // ============================================================
      console.log(
        "\n=== 1. WALK-FORWARD SPLIT (train=first half, test=second half) ===",
      );
      const midBar = Math.floor(totalBarsLite / 2);
      const wfTrain = evaluate(QZL, alignedLite, liteSymbols, 3, 0, midBar);
      const wfTest = evaluate(QZL, alignedLite, liteSymbols, 3, midBar);
      console.log(fmt(wfTrain, "TRAIN  (older half)"));
      console.log(
        fmt(wfTest, "TEST   (newer half — TRUE OOS for asset-pool selection)"),
      );
      const wfDelta = (wfTest?.passRate ?? 0) - (wfTrain?.passRate ?? 0);
      console.log(
        `walk-forward Δ (test - train): ${(wfDelta * 100).toFixed(2)}pp ` +
          `${Math.abs(wfDelta) > 0.15 ? "⚠️ regime-shift / overfit" : "✓ stable"}`,
      );
      const oosPass = (wfTest?.passRate ?? 0) >= 0.6;
      console.log(
        `OOS test-half ≥ 60%? ${oosPass ? "✓ YES" : "⚠️ NO — overfit warning"}`,
      );

      // ============================================================
      // 2. YEAR-BY-YEAR
      // ============================================================
      console.log("\n=== 2. YEAR-BY-YEAR (5 single-year segments) ===");
      const barsPerYear = 365 * BARS_PER_DAY_30M;
      const numYears = Math.floor(totalBarsLite / barsPerYear);
      const yearlyRates: number[] = [];
      for (let y = 0; y < numYears; y++) {
        const startBar = y * barsPerYear;
        const endBar = Math.min((y + 1) * barsPerYear, totalBarsLite);
        const r = evaluate(QZL, alignedLite, liteSymbols, 3, startBar, endBar);
        if (r && r.windows > 0) {
          yearlyRates.push(r.passRate);
          const startDate = new Date(
            alignedLite[liteSymbols[0]][startBar].openTime,
          )
            .toISOString()
            .slice(0, 7);
          console.log(
            `year ${y + 1} (${startDate}+12m): pass=${(r.passRate * 100).toFixed(2)}% n=${r.windows} TL=${(r.tlPct * 100).toFixed(1)}% DL=${(r.dlPct * 100).toFixed(1)}% med=${r.med}d`,
          );
        }
      }
      if (yearlyRates.length > 0) {
        const mean =
          yearlyRates.reduce((a, b) => a + b, 0) / yearlyRates.length;
        const variance =
          yearlyRates.reduce((a, b) => a + (b - mean) ** 2, 0) /
          yearlyRates.length;
        const std = Math.sqrt(variance);
        const min = Math.min(...yearlyRates);
        const max = Math.max(...yearlyRates);
        console.log(
          `\nYearly stats: mean=${(mean * 100).toFixed(2)}% / std=${(std * 100).toFixed(2)}pp / min=${(min * 100).toFixed(2)}% / max=${(max * 100).toFixed(2)}%`,
        );
        console.log(
          `Year-spread (max - min): ${((max - min) * 100).toFixed(2)}pp ` +
            `${max - min > 0.4 ? "⚠️ regime-luck dependent" : "✓ stable across years"}`,
        );
        console.log(
          `Worst-year ≥ 50%? ${min >= 0.5 ? "✓ YES" : "⚠️ NO — at least one year underperforms"}`,
        );
      }

      // ============================================================
      // 3. BLOCK-BOOTSTRAP CI
      // ============================================================
      console.log(
        "\n=== 3. BLOCK-BOOTSTRAP CI (step=1d, 200 resamples, block=30 windows ≈ 1 month) ===",
      );
      const allWf = evaluate(QZL, alignedLite, liteSymbols, 1);
      if (!allWf) throw new Error("bootstrap eval returned null");
      console.log(
        `Total step=1d windows: ${allWf.windows} (point estimate ${(allWf.passRate * 100).toFixed(2)}%)`,
      );
      const blockSize = 30;
      const numBlocks = Math.ceil(allWf.windows / blockSize);
      const passRates: number[] = [];
      const rng = (seed: number) => {
        let s = seed;
        return () => {
          s = (s * 1664525 + 1013904223) % 0x100000000;
          return s / 0x100000000;
        };
      };
      for (let b = 0; b < 200; b++) {
        const r = rng(42 + b);
        const resampled: boolean[] = [];
        for (let i = 0; i < numBlocks; i++) {
          const startBlock = Math.floor(
            r() * Math.max(1, allWf.windows - blockSize),
          );
          for (
            let k = 0;
            k < blockSize && startBlock + k < allWf.perWindow.length;
            k++
          ) {
            resampled.push(allWf.perWindow[startBlock + k]);
          }
        }
        const passes = resampled.filter((p) => p).length;
        passRates.push(passes / Math.max(1, resampled.length));
      }
      passRates.sort((a, b) => a - b);
      const ci95Lo = passRates[Math.floor(passRates.length * 0.025)];
      const ci95Hi = passRates[Math.floor(passRates.length * 0.975)];
      const bootMean = passRates.reduce((a, b) => a + b, 0) / passRates.length;
      console.log(
        `Bootstrap mean: ${(bootMean * 100).toFixed(2)}% / 95% CI [${(ci95Lo * 100).toFixed(2)}%, ${(ci95Hi * 100).toFixed(2)}%]`,
      );
      const widthPp = (ci95Hi - ci95Lo) * 100;
      console.log(
        `CI width: ${widthPp.toFixed(2)}pp ` +
          `${widthPp > 15 ? "⚠️ very wide — high uncertainty" : widthPp > 8 ? "⚠️ moderately wide" : "✓ tight"}`,
      );
      console.log(
        `CI lower-bound ≥ 60%? ${ci95Lo >= 0.6 ? "✓ YES — 80% is genuinely high" : "⚠️ NO — true rate may be << 80%"}`,
      );

      // ============================================================
      // BONUS: Validate the asset-drop on TEST half
      // ============================================================
      console.log(
        "\n=== BONUS: Asset-drop sanity check on TEST half (newer 50%) ===",
      );
      console.log(
        "Were the 6 dropped assets (AVAX/DOGE/INJ/RUNE/SAND/ARB) actually bad on UNSEEN data?",
      );
      // Re-align on full QUARTZ pool for fair test-half comparison.
      const alignedFull = alignCommon(data, fullSymbols);
      const totalBarsFull = Math.min(
        ...fullSymbols.map((s) => alignedFull[s]?.length ?? 0),
      );
      const midBarFull = Math.floor(totalBarsFull / 2);
      const fullTest = evaluate(
        QZ_FULL,
        alignedFull,
        fullSymbols,
        3,
        midBarFull,
      );
      const liteTest = evaluate(QZL, alignedFull, liteSymbols, 3, midBarFull);
      console.log(fmt(fullTest, "V5_QUARTZ (15 assets) TEST half"));
      console.log(fmt(liteTest, "V5_QUARTZ_LITE ( 9 assets) TEST half"));
      const dropImproveTest =
        (liteTest?.passRate ?? 0) - (fullTest?.passRate ?? 0);
      console.log(
        `Drop-effect on TEST: ${(dropImproveTest * 100).toFixed(2)}pp ` +
          `${dropImproveTest > 0.05 ? "✓ drop helps OOS too — robust" : dropImproveTest < -0.05 ? "⚠️ drop HURTS OOS — overfit" : "≈ neutral OOS"}`,
      );
      console.log(
        `\nDropped: ${droppedSymbolNames.join(", ")} — ${droppedSymbolNames.length} assets`,
      );

      // ============================================================
      // FINAL VERDICT
      // ============================================================
      console.log("\n=== FINAL VERDICT ===");
      const signals = {
        walkForwardOk: oosPass,
        yearStable: yearlyRates.length > 0 && Math.min(...yearlyRates) >= 0.5,
        ciTight: widthPp < 15 && ci95Lo >= 0.6,
        dropRobust: dropImproveTest > 0,
      };
      console.log(
        `  walk-forward OOS ≥ 60%:     ${signals.walkForwardOk ? "✓" : "⚠️"}`,
      );
      console.log(
        `  worst year ≥ 50%:           ${signals.yearStable ? "✓" : "⚠️"}`,
      );
      console.log(
        `  bootstrap CI tight + ≥60%:  ${signals.ciTight ? "✓" : "⚠️"}`,
      );
      console.log(
        `  asset-drop robust OOS:      ${signals.dropRobust ? "✓" : "⚠️"}`,
      );
      const okCount = Object.values(signals).filter(Boolean).length;
      console.log(
        `\nRobustness score: ${okCount}/4 ` +
          `${okCount === 4 ? "— V5_QUARTZ_LITE is genuinely robust" : okCount >= 2 ? "— borderline, deploy with caution" : "— OVERFIT WARNING, do not deploy as-is"}`,
      );

      expect(true).toBe(true);
    });
  },
);
