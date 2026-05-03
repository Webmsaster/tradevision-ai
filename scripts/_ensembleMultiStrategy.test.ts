/**
 * Ensemble Multi-Strategy Diversification Test (Round 53).
 *
 * Question: do three orthogonal strategies (crypto-trend / crypto-breakout /
 * forex-MR), each well below the 80% deployment goal alone, combine into a
 * deployable ensemble where min-1-pass clears 80%?
 *
 * Components (all run via the production V4 Live Engine `simulate()`):
 *   - R28_V5  = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5
 *               (30m crypto-trend, 9 assets, V4-Engine 58.82%)
 *   - BO_V1   = FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1
 *               (30m crypto-breakout, 9 assets, V4-Sim 49.25%)
 *   - FX_TOP3 = forex-MR via makeForexAsset (2h, 6 majors, V4-Sim ~99% on 1.4y)
 *
 * Method: rolling 30-day windows synced to a common UTC start timestamp
 * across all 3 asset classes.  For each window we measure {pass, day, reason}
 * for each strategy and compute:
 *   - per-strategy pass-rate
 *   - ensemble min-1-pass / min-2-pass / all-3-pass
 *   - failure-correlation matrix P(B fails | A fails)
 *
 * Theory: with independent strategies p_i, min-1-pass = 1 − Π(1−p_i).
 *   pcrypto≈0.59, pbo≈0.43, pfx≈0.99 → independent ceiling 99.7%.
 *   Real correlation (especially crypto-trend vs crypto-breakout) will lower it.
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run \
 *     --config vitest.scripts.config.ts \
 *     scripts/_ensembleMultiStrategy.test.ts
 */
import { describe, it } from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5,
  FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import {
  loadForexMajors,
  alignForexCommon,
  FOREX_MAJORS,
} from "./_loadForexHistory";
import type { Daytrade24hAssetCfg } from "../src/utils/ftmoDaytrade24h";

// ────────────────────────────────────────────────────────────────────────
// Forex config builder — duplicated from _round41ForexBaseline.test.ts to
// avoid importing a *.test.ts file (would auto-run its describe() block).
// Mirror exactly so FX_TOP3 numbers are comparable to Round 41/44 baseline.
// ────────────────────────────────────────────────────────────────────────
function makeForexAsset(yahoo: string): Daytrade24hAssetCfg {
  const stem = yahoo.replace(/=X$/, "");
  return {
    symbol: `${stem}-FX`,
    sourceSymbol: yahoo,
    costBp: 3,
    slippageBp: 1,
    swapBpPerDay: 0.5,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: false,
    stopPct: 0.03,
    tpPct: 0.01,
    holdBars: 60,
  };
}

function buildForexBaselineCfg(
  eligible: string[],
  override: Partial<FtmoDaytrade24hConfig> = {},
): FtmoDaytrade24hConfig {
  return {
    triggerBars: 1,
    leverage: 8,
    tpPct: 0.01,
    stopPct: 0.03,
    holdBars: 60,
    timeframe: "2h",
    maxConcurrentTrades: 12,
    assets: eligible.map(makeForexAsset),
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
    ...override,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Logging
// ────────────────────────────────────────────────────────────────────────
const LOG_DIR = "scripts/overnight_results";
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = `${LOG_DIR}/ENSEMBLE_MULTI_STRATEGY_${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}.log`;
writeFileSync(
  LOG_FILE,
  `ENSEMBLE MULTI-STRATEGY ${new Date().toISOString()}\n`,
);
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────
const CACHE_DIR_CRYPTO = "scripts/cache_bakeoff";
const CACHE_DIR_FOREX = "scripts/cache_forex_2h";
mkdirSync(CACHE_DIR_FOREX, { recursive: true });

const BARS_PER_DAY = { "30m": 48, "2h": 12 } as const;
const TARGET_BARS_30M = 100_000;
const WINDOW_DAYS = 30;
const STEP_DAYS = 14;
const WARMUP_BARS_30M = 5_000;
const WARMUP_BARS_2H = 1_500;

// ────────────────────────────────────────────────────────────────────────
// Crypto loaders (re-uses cache_bakeoff)
// ────────────────────────────────────────────────────────────────────────
async function loadCrypto30m(symbol: string): Promise<Candle[]> {
  const cachePath = `${CACHE_DIR_CRYPTO}/${symbol}_30m.json`;
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as Candle[];
      if (cached.length >= 5_000) return cached;
    } catch {}
  }
  try {
    const r = await loadBinanceHistory({
      symbol,
      timeframe: "30m",
      targetCount: TARGET_BARS_30M,
      maxPages: 110,
    });
    const final = r.filter((c) => c.isFinal);
    if (final.length >= 5_000) writeFileSync(cachePath, JSON.stringify(final));
    return final;
  } catch (e) {
    console.warn(`[crypto-load] ${symbol} failed: ${(e as Error).message}`);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────
// Forex loader with disk cache (Yahoo is slow & flaky)
// ────────────────────────────────────────────────────────────────────────
async function loadForex2hCached(): Promise<Record<string, Candle[]>> {
  const cachePath = `${CACHE_DIR_FOREX}/forex_2h.json`;
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<
        string,
        Candle[]
      >;
      if (Object.keys(cached).length === FOREX_MAJORS.length) return cached;
    } catch {}
  }
  log("[forex-load] fetching Yahoo 1h → resampling to 2h, range=2y...");
  const data = await loadForexMajors(
    { timeframe: "2h", range: "2y" },
    FOREX_MAJORS,
  );
  writeFileSync(cachePath, JSON.stringify(data));
  return data;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────
function symsOf(cfg: FtmoDaytrade24hConfig): string[] {
  const s = new Set<string>();
  for (const a of cfg.assets) s.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) s.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) s.add(f.symbol);
  return [...s].sort();
}

function alignByOpenTime(
  data: Record<string, Candle[]>,
  symbols: string[],
): Record<string, Candle[]> {
  const sets = symbols.map(
    (s) => new Set((data[s] ?? []).map((c) => c.openTime)),
  );
  if (sets.length === 0) return {};
  const common = [...sets[0]!].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = (data[s] ?? [])
      .filter((c) => cs.has(c.openTime))
      .sort((a, b) => a.openTime - b.openTime);
  return aligned;
}

// Find the index in `candles` of the first bar with openTime >= ts.
function firstIdxAtOrAfter(candles: Candle[], ts: number): number {
  let lo = 0,
    hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid]!.openTime < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface WindowResult {
  startTs: number;
  passes: [boolean, boolean, boolean]; // [R28_V5, BO_V1, FX_TOP3]
  reasons: [string, string, string];
  passDays: [number | null, number | null, number | null];
}

function runStrategy(
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  startTs: number,
  bpd: 48 | 12,
  warmup: number,
  cfgLabel: string,
): { passed: boolean; reason: string; passDay: number | null } | null {
  const sym0 = Object.keys(aligned)[0]!;
  const startIdx = firstIdxAtOrAfter(aligned[sym0]!, startTs);
  const winBars = WINDOW_DAYS * bpd;
  if (startIdx < warmup) return null;
  if (startIdx + winBars > aligned[sym0]!.length) return null;

  // Trim to [startIdx-warmup, startIdx+winBars] so per-tick slice cost is bounded.
  const trimStart = startIdx - warmup;
  const trimEnd = startIdx + winBars;
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned)) {
    trimmed[k] = aligned[k]!.slice(trimStart, trimEnd);
  }
  // Inject conservative liveCaps if not present.
  const safeCfg: FtmoDaytrade24hConfig = {
    ...cfg,
    liveCaps: cfg.liveCaps ?? { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  };
  const r = simulate(trimmed, safeCfg, warmup, warmup + winBars, cfgLabel);
  return {
    passed: r.passed,
    reason: r.passed ? "pass" : r.reason,
    passDay: typeof r.passDay === "number" ? r.passDay : null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Test
// ────────────────────────────────────────────────────────────────────────
describe(
  "Ensemble Multi-Strategy (R28_V5 + BREAKOUT_V1 + FX_TOP3)",
  { timeout: 120 * 60_000 },
  () => {
    it("measures diversification benefit across 3 asset-class strategies", async () => {
      // 1. Load all crypto (30m) data shared by R28_V5 ∪ BREAKOUT_V1 baskets
      const cryptoSymbols = [
        ...new Set([
          ...symsOf(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5),
          ...symsOf(FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1),
        ]),
      ].sort();
      log(
        `[crypto] symbols (${cryptoSymbols.length}): ${cryptoSymbols.join(",")}`,
      );
      const t0 = Date.now();
      const cryptoRaw: Record<string, Candle[]> = {};
      const results = await Promise.all(
        cryptoSymbols.map((s) => loadCrypto30m(s)),
      );
      cryptoSymbols.forEach((s, i) => (cryptoRaw[s] = results[i]!));
      log(
        `[crypto] loaded in ${Math.round((Date.now() - t0) / 1000)}s — ${cryptoSymbols
          .map((s) => `${s}=${cryptoRaw[s]?.length ?? 0}`)
          .join(" ")}`,
      );

      // 2. Forex (2h) — fetch + cache
      const forexRaw = await loadForex2hCached();
      const eligibleFx = Object.keys(forexRaw).filter(
        (s) => forexRaw[s]!.length >= WINDOW_DAYS * BARS_PER_DAY["2h"],
      );
      const forexAligned = alignForexCommon(
        Object.fromEntries(eligibleFx.map((s) => [s, forexRaw[s]!])),
      );
      log(
        `[forex] loaded ${eligibleFx.length} pairs / common bars=${forexAligned[eligibleFx[0]!]?.length ?? 0}`,
      );

      // 3. Per-strategy aligned data (subset of cryptoRaw / forexAligned)
      const r28v5Syms = symsOf(
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5,
      );
      const boV1Syms = symsOf(FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1);
      const r28v5Aligned = alignByOpenTime(cryptoRaw, r28v5Syms);
      const boV1Aligned = alignByOpenTime(cryptoRaw, boV1Syms);

      // 4. Build FX cfg using actual eligible majors
      const fxCfg = buildForexBaselineCfg(eligibleFx);

      // 5. Determine common time window across all 3 asset classes.
      //    Forex (2h) is the binding constraint (~1.4y).  Use forex first/last
      //    openTime as the [tStart, tEnd] envelope and step in 14d increments.
      const fxFirstSym = eligibleFx[0]!;
      const fxBars = forexAligned[fxFirstSym]!;
      const fxFirstTs = fxBars[0]!.openTime;
      const fxLastTs = fxBars[fxBars.length - 1]!.openTime;

      const cryptoFirstTs = Math.min(
        ...cryptoSymbols.map((s) => cryptoRaw[s]?.[0]?.openTime ?? Infinity),
      );
      const cryptoLastTs = Math.max(
        ...cryptoSymbols.map(
          (s) => cryptoRaw[s]?.[cryptoRaw[s]!.length - 1]?.openTime ?? 0,
        ),
      );
      // The window-start range is the intersection minus `winDays` from end &
      // minus enough warmup from start.
      const windowMs = WINDOW_DAYS * 24 * 3_600_000;
      const stepMs = STEP_DAYS * 24 * 3_600_000;
      // Crypto warmup needs ≈ WARMUP_BARS_30M * 30m = 104.2 days of pre-history.
      const cryptoWarmupMs = WARMUP_BARS_30M * 30 * 60_000;
      const fxWarmupMs = WARMUP_BARS_2H * 2 * 3_600_000;
      const tStartMin = Math.max(
        fxFirstTs + fxWarmupMs,
        cryptoFirstTs + cryptoWarmupMs,
      );
      const tEndMax = Math.min(fxLastTs, cryptoLastTs) - windowMs;
      log(
        `[align] window-start range: ${new Date(tStartMin).toISOString()} → ${new Date(tEndMax).toISOString()}`,
      );
      if (tEndMax <= tStartMin) {
        log("FATAL: no common window — abort.");
        return;
      }

      const startTimestamps: number[] = [];
      for (let ts = tStartMin; ts <= tEndMax; ts += stepMs)
        startTimestamps.push(ts);
      log(
        `[align] ${startTimestamps.length} aligned 30d windows / step=${STEP_DAYS}d`,
      );

      // 6. Run all 3 strategies on every window
      const results_: WindowResult[] = [];
      let i = 0;
      for (const startTs of startTimestamps) {
        i++;
        const t = Date.now();
        const r1 = runStrategy(
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5,
          r28v5Aligned,
          startTs,
          BARS_PER_DAY["30m"],
          WARMUP_BARS_30M,
          "R28_V5",
        );
        const r2 = runStrategy(
          FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1,
          boV1Aligned,
          startTs,
          BARS_PER_DAY["30m"],
          WARMUP_BARS_30M,
          "BO_V1",
        );
        const r3 = runStrategy(
          fxCfg,
          forexAligned,
          startTs,
          BARS_PER_DAY["2h"],
          WARMUP_BARS_2H,
          "FX_TOP3",
        );
        if (!r1 || !r2 || !r3) {
          log(
            `  win ${i} @${new Date(startTs).toISOString()}: SKIP (insufficient bars on at least one feed)`,
          );
          continue;
        }
        results_.push({
          startTs,
          passes: [r1.passed, r2.passed, r3.passed],
          reasons: [r1.reason, r2.reason, r3.reason],
          passDays: [r1.passDay, r2.passDay, r3.passDay],
        });
        log(
          `  win ${i} @${new Date(startTs).toISOString().slice(0, 10)}: ` +
            `R28_V5=${r1.passed ? "PASS" : r1.reason}` +
            ` | BO_V1=${r2.passed ? "PASS" : r2.reason}` +
            ` | FX_TOP3=${r3.passed ? "PASS" : r3.reason}` +
            ` (${Math.round((Date.now() - t) / 1000)}s)`,
        );
      }
      const N = results_.length;
      if (N === 0) {
        log("FATAL: zero usable windows.");
        return;
      }

      // 7. Per-strategy pass-rate
      const NAMES = ["R28_V5", "BO_V1  ", "FX_TOP3"] as const;
      const passes = [0, 0, 0];
      const passDays: number[][] = [[], [], []];
      for (const w of results_) {
        for (let k = 0; k < 3; k++) {
          if (w.passes[k]) passes[k]!++;
          if (w.passDays[k] !== null) passDays[k]!.push(w.passDays[k]!);
        }
      }
      const passRates = passes.map((p) => p / N);

      // 8. Ensemble metrics
      let min1 = 0,
        min2 = 0,
        all3 = 0;
      for (const w of results_) {
        const c = w.passes.filter(Boolean).length;
        if (c >= 1) min1++;
        if (c >= 2) min2++;
        if (c === 3) all3++;
      }
      const min1R = min1 / N;
      const min2R = min2 / N;
      const all3R = all3 / N;

      // Independence baseline = 1 − Π(1 − p_i)
      const independent_min1 =
        1 - (1 - passRates[0]!) * (1 - passRates[1]!) * (1 - passRates[2]!);

      // 9. Failure-correlation: P(B fails | A fails)
      //    matrix[a][b] = (#windows where both fail) / (#windows where a fails)
      const failMatrix: number[][] = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      const failCounts = [0, 0, 0];
      for (const w of results_) {
        for (let a = 0; a < 3; a++)
          if (!w.passes[a]) {
            failCounts[a]!++;
            for (let b = 0; b < 3; b++) if (!w.passes[b]) failMatrix[a]![b]!++;
          }
      }
      const corrMatrix: number[][] = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      for (let a = 0; a < 3; a++) {
        if (failCounts[a]! === 0) continue;
        for (let b = 0; b < 3; b++)
          corrMatrix[a]![b] = failMatrix[a]![b]! / failCounts[a]!;
      }

      // 10. Output
      log("\n========== ENSEMBLE MULTI-STRATEGY RESULTS ==========");
      log(
        `Windows: ${N}  /  step=${STEP_DAYS}d  /  windowDays=${WINDOW_DAYS}d`,
      );
      log(`\n--- Per-strategy pass-rate ---`);
      log(`strategy | pass-rate    | passes/N | med-day | p90-day`);
      log(`---------+--------------+----------+---------+--------`);
      for (let k = 0; k < 3; k++) {
        const pd = [...passDays[k]!].sort((a, b) => a - b);
        const med = pd.length > 0 ? pd[Math.floor(pd.length / 2)]! : 0;
        const p90 =
          pd.length > 0
            ? pd[Math.min(pd.length - 1, Math.floor(pd.length * 0.9))]!
            : 0;
        log(
          `${NAMES[k]}  | ${(passRates[k]! * 100).toFixed(2).padStart(6)}%      | ${String(passes[k]).padStart(3)}/${N}   | ${String(med).padStart(4)}d   | ${String(p90).padStart(4)}d`,
        );
      }

      log(`\n--- Ensemble pass-rates ---`);
      log(
        `min-1-pass  (any of 3 passes):   ${(min1R * 100).toFixed(2)}%   (${min1}/${N})`,
      );
      log(
        `min-2-pass  (≥2 of 3 pass):       ${(min2R * 100).toFixed(2)}%   (${min2}/${N})`,
      );
      log(
        `all-3-pass  (every strategy):    ${(all3R * 100).toFixed(2)}%   (${all3}/${N})`,
      );
      log(
        `independence baseline min-1:     ${(independent_min1 * 100).toFixed(2)}%   (assumes p_i are independent)`,
      );
      log(
        `diversification gap:             ${((min1R - independent_min1) * 100).toFixed(2)}pp   (negative = correlated failures vs theory)`,
      );

      log(`\n--- Failure-correlation matrix  P(B fails | A fails) ---`);
      log(`           | R28_V5  BO_V1   FX_TOP3`);
      log(`-----------+-------------------------`);
      for (let a = 0; a < 3; a++) {
        const row = corrMatrix[a]!.map((v) => v.toFixed(2).padStart(6)).join(
          "  ",
        );
        log(`${NAMES[a]}  | ${row}`);
      }

      // 11. Verdict
      // P(B|A) for off-diagonal pairs measures shared-failure regime.
      const offDiag: number[] = [];
      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++)
          if (a !== b && failCounts[a]! > 0) offDiag.push(corrMatrix[a]![b]!);
      const avgOffDiag =
        offDiag.length > 0
          ? offDiag.reduce((s, v) => s + v, 0) / offDiag.length
          : 0;

      log(`\n--- Verdict ---`);
      log(`avg off-diagonal P(B fails|A fails): ${avgOffDiag.toFixed(2)}`);
      let verdict: string;
      if (min1R >= 0.8 && avgOffDiag <= 0.7) {
        verdict = `DEPLOY. min-1-pass ${(min1R * 100).toFixed(1)}% ≥ 80% goal and avg failure-correlation ${avgOffDiag.toFixed(2)} ≤ 0.70 → strategies are diversifying as theorized; run 3 parallel FTMO challenges (one per strategy).`;
      } else if (min1R >= 0.8) {
        verdict = `DEPLOY WITH CAVEAT. min-1-pass ${(min1R * 100).toFixed(1)}% clears 80% but failure-correlation ${avgOffDiag.toFixed(2)} > 0.70 — some shared-regime risk; budget for occasional triple-fail months.`;
      } else if (avgOffDiag <= 0.5) {
        verdict = `DO NOT DEPLOY YET. Strategies decorrelate well (avg corr ${avgOffDiag.toFixed(2)}) but min-1-pass ${(min1R * 100).toFixed(1)}% < 80% — improve weakest strategy or add 4th.`;
      } else {
        verdict = `DO NOT DEPLOY. Both min-1-pass (${(min1R * 100).toFixed(1)}%) below 80% AND failure-correlation (${avgOffDiag.toFixed(2)}) too high — diversification benefit is illusory on this sample.`;
      }
      log(`\n${verdict}`);

      log(`\nLog file: ${LOG_FILE}`);
    });
  },
);
