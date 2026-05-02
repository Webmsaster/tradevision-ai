/**
 * V5_QUARTZ Random-Drop Bootstrap — Selection-Bias Audit on V5_QUARTZ_LITE.
 *
 * V5_QUARTZ_LITE achieved 80.72% pass-rate by dropping the 6 cherry-picked
 * assets {AVAX, DOGE, INJ, RUNE, SAND, ARB}. Question: is that pass-rate the
 * result of genuine asset-selection skill, or just selection bias on the
 * training data — i.e. would *any* random 6-asset drop produce a similar
 * pass-rate?
 *
 * Method:
 *   - Bootstrap 50 iterations, each picking 6 RANDOM assets to drop from the
 *     V5_QUARTZ 15-asset basket. Keep the remaining 9 and run the LITE-style
 *     evaluation (same engine fields: pauseAtTargetReached=true, liveCaps,
 *     dailyPeakTrailingStop trail=2%).
 *   - Output: distribution of pass-rates + count of trials beating LITE 80%.
 *
 * Two control groups (deterministic):
 *   - DROP-LOWEST-VOL: drop 6 assets with lowest realised stdev of log-returns
 *   - DROP-HIGHEST-VOL: drop 6 assets with highest realised stdev of log-returns
 *
 * Interpretation:
 *   - If random pass-rate distribution clusters near 80% (or above) → LITE
 *     drops are NOT special: the data favours almost any 9-asset subset.
 *   - If LITE clearly outperforms the random distribution (e.g. >95th %ile) →
 *     the {AVAX, DOGE, INJ, RUNE, SAND, ARB} drops genuinely add edge.
 *   - DROP-HIGHEST-VOL test indicates whether the LITE intuition (dropping
 *     volatile assets) generalises beyond the 6 cherry-picked names.
 *
 * Seeded RNG → reproducible distribution. Run with:
 *   node ./node_modules/vitest/vitest.mjs run \
 *     scripts/_v5QuartzRandomDropBootstrap.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;
const NUM_TRIALS = 50;
const DROP_COUNT = 6;
const LITE_PASS_RATE = 0.8072; // V5_QUARTZ_LITE published baseline
const LITE_DROPS = [
  "AVAX-TREND",
  "DOGE-TREND",
  "INJ-TREND",
  "RUNE-TREND",
  "SAND-TREND",
  "ARB-TREND",
];
const SEED = 0x5eed_42;

// ─── Mulberry32 deterministic PRNG ────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickK<T>(items: T[], k: number, rng: () => number): T[] {
  return shuffleInPlace([...items], rng).slice(0, k);
}

// ─── Same eval helpers as Round 19/21 ─────────────────────────────────────
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

function evaluate(cfg: FtmoDaytrade24hConfig, data: Record<string, Candle[]>) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (!isFinite(n) || n === 0) return null;
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0;
  const passDays: number[] = [];
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
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
    p25: pctile(passDays, 0.25),
    med: pctile(passDays, 0.5),
    p75: pctile(passDays, 0.75),
    p90: pctile(passDays, 0.9),
  };
}

// Compute realised stddev of log-returns per symbol (single number per asset).
function realisedStdevByAsset(
  data: Record<string, Candle[]>,
  assetToSym: Map<string, string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [asset, sym] of assetToSym) {
    const candles = data[sym];
    if (!candles || candles.length < 2) {
      out.set(asset, 0);
      continue;
    }
    const rets: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const p0 = candles[i - 1].close;
      const p1 = candles[i].close;
      if (p0 > 0 && p1 > 0) rets.push(Math.log(p1 / p0));
    }
    const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
    const v =
      rets.reduce((a, b) => a + (b - mean) ** 2, 0) /
      Math.max(1, rets.length - 1);
    out.set(asset, Math.sqrt(v));
  }
  return out;
}

function summarise(name: string, vals: number[]): string {
  if (vals.length === 0) return `${name}: (no data)`;
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const v =
    vals.reduce((a, b) => a + (b - mean) ** 2, 0) /
    Math.max(1, vals.length - 1);
  const stdev = Math.sqrt(v);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const med = pctile(sorted, 0.5);
  const p05 = pctile(sorted, 0.05);
  const p95 = pctile(sorted, 0.95);
  return (
    `${name} N=${vals.length}  mean=${(mean * 100).toFixed(2)}%  stdev=${(stdev * 100).toFixed(2)}pp  ` +
    `min=${(min * 100).toFixed(2)}%  p05=${(p05 * 100).toFixed(2)}%  med=${(med * 100).toFixed(2)}%  ` +
    `p95=${(p95 * 100).toFixed(2)}%  max=${(max * 100).toFixed(2)}%`
  );
}

describe(
  "V5_QUARTZ random-drop bootstrap (selection-bias audit)",
  { timeout: 4 * 60 * 60_000 },
  () => {
    it(`${NUM_TRIALS} random 6-asset drops + lowest/highest-vol controls vs LITE 80%`, async () => {
      const QZ = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ;
      const allAssetSyms = QZ.assets.map((a) => a.symbol); // 15 assets
      const assetToSrc = new Map<string, string>(
        QZ.assets.map((a) => [a.symbol, a.sourceSymbol ?? a.symbol]),
      );
      expect(allAssetSyms.length).toBe(15);

      // Load historical data once (LITE-style: 30m, 5y deep).
      const symbols = syms(QZ);
      console.log(`Loading ${symbols.length} symbols (30m)...`);
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
          // skip — alignCommon will downcast to common-bar floor
        }
      }
      console.log(`Loaded data ranges (bar counts):`);
      for (const s of symbols)
        console.log(`  ${s.padEnd(12)} ${data[s]?.length ?? 0} bars`);

      // Base LITE-style overrides — keep apples-to-apples vs published 80.72%.
      const liteOverrides: Partial<FtmoDaytrade24hConfig> = {
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        dailyPeakTrailingStop: { trailDistance: 0.02 },
        pauseAtTargetReached: true,
      };
      const buildCfg = (keepSet: Set<string>): FtmoDaytrade24hConfig => ({
        ...QZ,
        ...liteOverrides,
        assets: QZ.assets.filter((a) => keepSet.has(a.symbol)),
      });

      // ─── Sanity: re-run the cherry-picked LITE drop ──────────────────────
      const liteKeep = new Set(
        allAssetSyms.filter((a) => !LITE_DROPS.includes(a)),
      );
      console.log(`\nLITE published drops: ${LITE_DROPS.join(", ")}`);
      const liteRes = evaluate(buildCfg(liteKeep), data);
      if (liteRes) {
        console.log(
          `LITE (cherry-pick)  pass=${(liteRes.passRate * 100).toFixed(2)}%  med=${liteRes.med}d  p90=${liteRes.p90}d  TL=${(liteRes.tlPct * 100).toFixed(2)}%  windows=${liteRes.windows}`,
        );
      }

      // ─── Random-drop bootstrap ───────────────────────────────────────────
      const rng = mulberry32(SEED);
      const randomResults: Array<{
        i: number;
        drops: string[];
        pass: number;
        med: number;
        p90: number;
        tl: number;
      }> = [];

      console.log(`\n=== RANDOM-DROP BOOTSTRAP (N=${NUM_TRIALS}) ===`);
      for (let i = 0; i < NUM_TRIALS; i++) {
        const drops = pickK(allAssetSyms, DROP_COUNT, rng).sort();
        const keep = new Set(allAssetSyms.filter((a) => !drops.includes(a)));
        const r = evaluate(buildCfg(keep), data);
        if (!r) continue;
        randomResults.push({
          i,
          drops,
          pass: r.passRate,
          med: r.med,
          p90: r.p90,
          tl: r.tlPct,
        });
        const beats = r.passRate >= LITE_PASS_RATE ? " *>=LITE" : "";
        console.log(
          `[${String(i + 1).padStart(2)}/${NUM_TRIALS}] drop=${drops
            .map((s) => s.replace("-TREND", ""))
            .join(",")
            .padEnd(
              40,
            )} pass=${(r.passRate * 100).toFixed(2)}%  med=${String(r.med).padStart(2)}d  p90=${String(r.p90).padStart(2)}d  TL=${(r.tlPct * 100).toFixed(2)}%${beats}`,
        );
      }

      // ─── Distribution summary ────────────────────────────────────────────
      const passes = randomResults.map((r) => r.pass);
      console.log(`\n${summarise("RANDOM pass-rate", passes)}`);
      const beat = passes.filter((p) => p >= LITE_PASS_RATE).length;
      const beatPct = passes.length ? (beat / passes.length) * 100 : 0;
      console.log(
        `Trials beating LITE (>=80.72%): ${beat}/${passes.length} = ${beatPct.toFixed(1)}%`,
      );
      // Empirical p-value: fraction of random trials at least as good as LITE.
      // Low p (e.g. <5%) → LITE genuinely outperforms random selection.
      console.log(
        `Empirical p-value (P[random >= LITE]): ${(beatPct / 100).toFixed(3)}`,
      );

      // ─── Control group: DROP-LOWEST-VOL ──────────────────────────────────
      console.log(`\n=== CONTROL: DROP-LOWEST-VOL & DROP-HIGHEST-VOL ===`);
      const stdevByAsset = realisedStdevByAsset(data, assetToSrc);
      const ranked = [...allAssetSyms].sort(
        (a, b) => (stdevByAsset.get(a) ?? 0) - (stdevByAsset.get(b) ?? 0),
      );
      console.log(
        `Assets ranked by realised stdev (low→high):\n  ` +
          ranked
            .map(
              (a) =>
                `${a.replace("-TREND", "")}=${((stdevByAsset.get(a) ?? 0) * 100).toFixed(3)}%`,
            )
            .join("  "),
      );

      const lowestVolDrops = ranked.slice(0, DROP_COUNT);
      const highestVolDrops = ranked.slice(-DROP_COUNT);

      const dropLow = new Set(
        allAssetSyms.filter((a) => !lowestVolDrops.includes(a)),
      );
      const dropHigh = new Set(
        allAssetSyms.filter((a) => !highestVolDrops.includes(a)),
      );

      console.log(
        `\nDROP-LOWEST-VOL drops:  ${lowestVolDrops.map((s) => s.replace("-TREND", "")).join(", ")}`,
      );
      const lowRes = evaluate(buildCfg(dropLow), data);
      if (lowRes) {
        console.log(
          `  pass=${(lowRes.passRate * 100).toFixed(2)}%  med=${lowRes.med}d  p90=${lowRes.p90}d  TL=${(lowRes.tlPct * 100).toFixed(2)}%`,
        );
      }

      console.log(
        `\nDROP-HIGHEST-VOL drops: ${highestVolDrops.map((s) => s.replace("-TREND", "")).join(", ")}`,
      );
      const highRes = evaluate(buildCfg(dropHigh), data);
      if (highRes) {
        console.log(
          `  pass=${(highRes.passRate * 100).toFixed(2)}%  med=${highRes.med}d  p90=${highRes.p90}d  TL=${(highRes.tlPct * 100).toFixed(2)}%`,
        );
      }

      // ─── Verdict ─────────────────────────────────────────────────────────
      console.log(`\n=== VERDICT ===`);
      console.log(
        `LITE (cherry-pick) pass-rate: ${liteRes ? (liteRes.passRate * 100).toFixed(2) + "%" : "n/a"}`,
      );
      console.log(
        `RANDOM-drop median pass-rate: ${(pctile(passes, 0.5) * 100).toFixed(2)}%`,
      );
      console.log(
        `DROP-HIGHEST-VOL pass-rate:   ${highRes ? (highRes.passRate * 100).toFixed(2) + "%" : "n/a"}`,
      );
      console.log(
        `DROP-LOWEST-VOL pass-rate:    ${lowRes ? (lowRes.passRate * 100).toFixed(2) + "%" : "n/a"}`,
      );
      console.log(
        `If random median ≈ LITE → LITE is NOT special (selection bias).`,
      );
      console.log(
        `If LITE >> random p95 → cherry-picked drops add genuine edge.`,
      );
      console.log(
        `If DROP-HIGHEST-VOL ≈ LITE → "drop high-vol" rule generalises beyond the 6 names.`,
      );

      expect(true).toBe(true);
    });
  },
);
