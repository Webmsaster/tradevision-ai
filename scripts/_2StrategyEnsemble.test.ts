/**
 * 2-Strategy Ensemble Diversification Test (Round 53 Priority 3).
 *
 * Question: drop BO_V1 from the 3-strategy ensemble (it correlates 0.90 with
 * R28_V5 — see project memory). Does R28_V5 + FX_TOP3 (corr 0.55) deliver a
 * cleaner diversification benefit with less complexity?
 *
 * Components (V4 Live Engine):
 *   - R28_V5  = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5
 *               (30m crypto-trend, 9 assets, V4-Engine 58.82%)
 *   - FX_TOP3 = forex-MR via makeForexAsset (2h, 6 majors, V4-Engine ~53.7%)
 *
 * Hypothesis: with corr 0.55, theoretical min-1-pass ≈
 *   1 - (1-0.59)*(1-0.54) = 81%.  Adjusted for residual correlation we expect
 *   ~75-78% which still clears the deployment goal of "single strategy plus
 *   diversifier" with materially less infrastructure than 3 parallel feeds.
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
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import {
  loadForexMajors,
  alignForexCommon,
  FOREX_MAJORS,
} from "./_loadForexHistory";

// Forex builder mirrors _ensembleMultiStrategy.test.ts so numbers stay comparable.
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

function buildForexBaselineCfg(eligible: string[]): FtmoDaytrade24hConfig {
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
  };
}

const LOG_DIR = "scripts/overnight_results";
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = `${LOG_DIR}/ENSEMBLE_2STRATEGY_${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}.log`;
writeFileSync(LOG_FILE, `2-STRATEGY ENSEMBLE ${new Date().toISOString()}\n`);
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const CACHE_DIR_CRYPTO = "scripts/cache_bakeoff";
const CACHE_DIR_FOREX = "scripts/cache_forex_2h";
mkdirSync(CACHE_DIR_FOREX, { recursive: true });

const BARS_PER_DAY = { "30m": 48, "2h": 12 } as const;
const TARGET_BARS_30M = 100_000;
const WINDOW_DAYS = 30;
const STEP_DAYS = 14;
const WARMUP_BARS_30M = 5_000;
const WARMUP_BARS_2H = 1_500;

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
  passes: [boolean, boolean]; // [R28_V5, FX_TOP3]
  reasons: [string, string];
  passDays: [number | null, number | null];
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

  const trimStart = startIdx - warmup;
  const trimEnd = startIdx + winBars;
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned)) {
    trimmed[k] = aligned[k]!.slice(trimStart, trimEnd);
  }
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

describe(
  "2-Strategy Ensemble (R28_V5 + FX_TOP3)",
  { timeout: 90 * 60_000 },
  () => {
    it("measures diversification benefit of crypto-trend + forex-MR", async () => {
      const cryptoSymbols = symsOf(
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5,
      );
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

      const r28v5Aligned = alignByOpenTime(cryptoRaw, cryptoSymbols);
      const fxCfg = buildForexBaselineCfg(eligibleFx);

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
      const windowMs = WINDOW_DAYS * 24 * 3_600_000;
      const stepMs = STEP_DAYS * 24 * 3_600_000;
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
          fxCfg,
          forexAligned,
          startTs,
          BARS_PER_DAY["2h"],
          WARMUP_BARS_2H,
          "FX_TOP3",
        );
        if (!r1 || !r2) {
          log(
            `  win ${i} @${new Date(startTs).toISOString()}: SKIP (insufficient bars)`,
          );
          continue;
        }
        results_.push({
          startTs,
          passes: [r1.passed, r2.passed],
          reasons: [r1.reason, r2.reason],
          passDays: [r1.passDay, r2.passDay],
        });
        log(
          `  win ${i} @${new Date(startTs).toISOString().slice(0, 10)}: ` +
            `R28_V5=${r1.passed ? "PASS" : r1.reason}` +
            ` | FX_TOP3=${r2.passed ? "PASS" : r2.reason}` +
            ` (${Math.round((Date.now() - t) / 1000)}s)`,
        );
      }
      const N = results_.length;
      if (N === 0) {
        log("FATAL: zero usable windows.");
        return;
      }

      const NAMES = ["R28_V5 ", "FX_TOP3"] as const;
      const passes = [0, 0];
      const passDays: number[][] = [[], []];
      for (const w of results_) {
        for (let k = 0; k < 2; k++) {
          if (w.passes[k]) passes[k]!++;
          if (w.passDays[k] !== null) passDays[k]!.push(w.passDays[k]!);
        }
      }
      const passRates = passes.map((p) => p / N);

      let min1 = 0,
        all2 = 0;
      for (const w of results_) {
        const c = w.passes.filter(Boolean).length;
        if (c >= 1) min1++;
        if (c === 2) all2++;
      }
      const min1R = min1 / N;
      const all2R = all2 / N;

      const independent_min1 = 1 - (1 - passRates[0]!) * (1 - passRates[1]!);

      // Failure-correlation: P(B fails | A fails)
      const failMatrix: number[][] = [
        [0, 0],
        [0, 0],
      ];
      const failCounts = [0, 0];
      for (const w of results_) {
        for (let a = 0; a < 2; a++)
          if (!w.passes[a]) {
            failCounts[a]!++;
            for (let b = 0; b < 2; b++) if (!w.passes[b]) failMatrix[a]![b]!++;
          }
      }
      const corrMatrix: number[][] = [
        [0, 0],
        [0, 0],
      ];
      for (let a = 0; a < 2; a++) {
        if (failCounts[a]! === 0) continue;
        for (let b = 0; b < 2; b++)
          corrMatrix[a]![b] = failMatrix[a]![b]! / failCounts[a]!;
      }

      log("\n========== 2-STRATEGY ENSEMBLE RESULTS ==========");
      log(
        `Windows: ${N}  /  step=${STEP_DAYS}d  /  windowDays=${WINDOW_DAYS}d`,
      );
      log(`\n--- Per-strategy pass-rate ---`);
      log(`strategy | pass-rate    | passes/N | med-day | p90-day`);
      log(`---------+--------------+----------+---------+--------`);
      for (let k = 0; k < 2; k++) {
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
        `min-1-pass  (any of 2 passes):   ${(min1R * 100).toFixed(2)}%   (${min1}/${N})`,
      );
      log(
        `both-pass   (R28_V5 AND FX):     ${(all2R * 100).toFixed(2)}%   (${all2}/${N})`,
      );
      log(
        `independence baseline min-1:     ${(independent_min1 * 100).toFixed(2)}%   (assumes p_i are independent)`,
      );
      log(
        `diversification gap:             ${((min1R - independent_min1) * 100).toFixed(2)}pp   (negative = correlated failures vs theory)`,
      );

      log(`\n--- Failure-correlation matrix  P(B fails | A fails) ---`);
      log(`           | R28_V5  FX_TOP3`);
      log(`-----------+----------------`);
      for (let a = 0; a < 2; a++) {
        const row = corrMatrix[a]!.map((v) => v.toFixed(2).padStart(6)).join(
          "  ",
        );
        log(`${NAMES[a]}  | ${row}`);
      }

      const pBgivenA = failCounts[0]! > 0 ? corrMatrix[0]![1]! : 0;
      const pAgivenB = failCounts[1]! > 0 ? corrMatrix[1]![0]! : 0;
      const avgCorr = (pBgivenA + pAgivenB) / 2;

      log(`\n--- Verdict ---`);
      log(`avg failure-correlation:         ${avgCorr.toFixed(2)}`);
      let verdict: string;
      if (min1R >= 0.78 && avgCorr <= 0.6) {
        verdict = `DEPLOY. min-1-pass ${(min1R * 100).toFixed(1)}% ≥ 78% goal and avg failure-correlation ${avgCorr.toFixed(2)} ≤ 0.60 → 2 parallel feeds (crypto-trend + forex-MR) is the leanest path to deployment.`;
      } else if (min1R >= 0.78) {
        verdict = `DEPLOY WITH CAVEAT. min-1-pass ${(min1R * 100).toFixed(1)}% clears 78% but failure-correlation ${avgCorr.toFixed(2)} > 0.60 — some shared-regime risk; still an upgrade over single-account R28_V5 (~59%).`;
      } else if (min1R >= 0.7) {
        verdict = `MARGINAL. min-1-pass ${(min1R * 100).toFixed(1)}% in 70-78% range — better than single-account but doesn't clear 78%. Consider 2× R28_V5 multi-account (~83%) instead.`;
      } else {
        verdict = `DO NOT DEPLOY. min-1-pass ${(min1R * 100).toFixed(1)}% < 70% — diversification gain insufficient. 2× R28_V5 multi-account (155€ extra, ~83%) is the better deployment path.`;
      }
      log(`\n${verdict}`);

      log(`\nLog file: ${LOG_FILE}`);
    });
  },
);
