/**
 * V5-Family R58 Re-Validation — direct runner (bypass vitest for speed).
 *
 * Runs ALL 13 V5-family configs through the post-R56/R57/R58 V4 Live Engine
 * to find the new R28_V7 candidate. R28_V6 honest = 56.62%; anything ≥60%
 * is a candidate.
 *
 * Sharded execution to use multiple cores:
 *   process.argv[2] = SHARD_IDX  (0-based)
 *   process.argv[3] = SHARD_COUNT
 *
 * Each shard runs only windows where windowIdx % SHARD_COUNT === SHARD_IDX
 * across ALL configs sequentially.
 *
 * Outputs:
 *   - One JSONL per (config × shard): cache_bakeoff/v5fam_<cfg>_shard_<idx>.jsonl
 *   - Combined log: cache_bakeoff/v5_family_r58_reval.log (shard 0 only writes setup)
 *
 * After all shards finish, run `_v5FamilyR58Aggregate.ts` to merge.
 *
 * Methodology (mirrors `_r28V6V4SimRevalidation.test.ts`):
 *   - 30-day rolling windows, 14-day step, 5000-bar warmup
 *   - V4 simulate() drives the challenge bar-by-bar
 *   - Per-config asset list pulled from cfg.assets
 *   - Aligned-by-openTime intersection of all required symbols
 *   - For 30m configs: 48 bars/day. For 2h configs (NOVA): 12 bars/day.
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_SAPPHIR,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_EMERALD,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PEARL,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OPAL,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AGATE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_JADE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = `${CACHE_DIR}/v5_family_r58_reval.log`;

const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);

// Only shard 0 writes log header to avoid corruption
function plog(s: string) {
  appendFileSync(
    LOG_FILE,
    `[${new Date().toISOString()}] [shard ${SHARD_IDX}] ${s}\n`,
  );
  console.log(`[shard ${SHARD_IDX}] ${s}`);
}

if (SHARD_IDX === 0 && !existsSync(LOG_FILE)) {
  writeFileSync(LOG_FILE, `[${new Date().toISOString()}] start sharding\n`);
}

interface ConfigEntry {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  preBugfixRate: number;
  expectedTimeframe: "30m" | "2h";
}

// Priority order (best pre-bugfix first)
const CONFIGS: ConfigEntry[] = [
  {
    name: "V5_QUARTZ_LITE",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
    preBugfixRate: 78.59,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_AGATE",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AGATE,
    preBugfixRate: 65.46,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_JADE",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_JADE,
    preBugfixRate: 65.46,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_AMBER",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
    preBugfixRate: 62.83,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_OBSIDIAN",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
    preBugfixRate: 60.56,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_ZIRKON",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON,
    preBugfixRate: 61.65,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_TOPAZ",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ,
    preBugfixRate: 61.65,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_RUBIN",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN,
    preBugfixRate: 61.74,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_SAPPHIR",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_SAPPHIR,
    preBugfixRate: 64.73,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_EMERALD",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_EMERALD,
    preBugfixRate: 64.82,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_PEARL",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PEARL,
    preBugfixRate: 65.1,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_OPAL",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OPAL,
    preBugfixRate: 65.28,
    expectedTimeframe: "30m",
  },
  {
    name: "V5_NOVA",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
    preBugfixRate: 47.24,
    expectedTimeframe: "2h",
  },
];

function loadCachedSymbol(symbol: string, tf: "30m" | "2h"): Candle[] | null {
  const path = `${CACHE_DIR}/${symbol}_${tf}.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Candle[];
  } catch {
    return null;
  }
}

function alignByOpenTime(
  symbolCandles: Record<string, Candle[]>,
): { aligned: Record<string, Candle[]>; minBars: number } | null {
  const symbols = Object.keys(symbolCandles);
  if (symbols.length === 0) return null;
  const sets = symbols.map(
    (s) => new Set(symbolCandles[s]!.map((c) => c.openTime)),
  );
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols) {
    aligned[s] = symbolCandles[s]!.filter((c) => cs.has(c.openTime));
  }
  return {
    aligned,
    minBars: Math.min(...symbols.map((s) => aligned[s]!.length)),
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}

interface ShardResult {
  windowsCompleted: number;
  passes: number;
  passDays: number[];
  reasonCounts: Record<string, number>;
  finalEquities: number[];
  totalWindows: number;
  elapsedSec: number;
}

function runConfig(entry: ConfigEntry): ShardResult | null {
  const { name, cfg, expectedTimeframe } = entry;
  const tf = expectedTimeframe;
  const barsPerDay = tf === "30m" ? 48 : 12;

  // Determine required symbols from cfg.assets
  const requiredSymbols = cfg.assets.map((a) => a.sourceSymbol ?? a.symbol);

  // Load candles for all required symbols
  const candleMap: Record<string, Candle[]> = {};
  const missing: string[] = [];
  for (const sym of requiredSymbols) {
    const c = loadCachedSymbol(sym, tf);
    if (!c || c.length === 0) {
      missing.push(sym);
    } else {
      candleMap[sym] = c;
    }
  }

  if (missing.length > 0) {
    plog(`[SKIP ${name}] missing cache for: ${missing.join(", ")} (tf=${tf})`);
    return null;
  }

  // Align
  const aligned = alignByOpenTime(candleMap);
  if (!aligned) {
    plog(`[SKIP ${name}] alignment failed`);
    return null;
  }
  const { aligned: a, minBars } = aligned;

  const winBars = cfg.maxDays * barsPerDay;
  const stepBars = 14 * barsPerDay;
  const WARMUP = Math.min(5000, Math.floor(minBars / 4));

  // Enumerate windows
  const windowStarts: number[] = [];
  for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
    windowStarts.push(start);
  }
  const totalWindows = windowStarts.length;

  if (totalWindows === 0) {
    plog(`[SKIP ${name}] no windows (minBars=${minBars})`);
    return null;
  }

  // Filter to this shard
  const myWindows = windowStarts.filter(
    (_, i) => i % SHARD_COUNT === SHARD_IDX,
  );

  plog(
    `[start ${name}] tf=${tf} assets=${requiredSymbols.length} minBars=${minBars} totalWindows=${totalWindows} myWindows=${myWindows.length}`,
  );

  const t0 = Date.now();
  let passes = 0;
  const passDays: number[] = [];
  const reasonCounts: Record<string, number> = {};
  const finalEquities: number[] = [];
  const outFile = `${CACHE_DIR}/v5fam_${name}_shard_${SHARD_IDX}.jsonl`;
  writeFileSync(outFile, "");

  let done = 0;
  for (const start of myWindows) {
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(a)) {
      trimmed[k] = a[k]!.slice(start - WARMUP, start + winBars);
    }
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, `${name}_REVAL`);
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
    finalEquities.push(r.finalEquityPct);
    if (r.passed) {
      passes++;
      if (r.passDay) passDays.push(r.passDay);
    }
    appendFileSync(
      outFile,
      JSON.stringify({
        winStart: start,
        passed: r.passed,
        reason: r.reason,
        passDay: r.passDay ?? null,
        finalEquityPct: r.finalEquityPct,
      }) + "\n",
    );
    done++;
    if (done % 5 === 0) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      plog(
        `[progress ${name}] ${done}/${myWindows.length} (passes ${passes}, ${((passes / done) * 100).toFixed(1)}%) / ${elapsed}s`,
      );
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  passDays.sort((a, b) => a - b);
  finalEquities.sort((a, b) => a - b);
  const medPassDay =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const p90PassDay = quantile(passDays, 0.9);
  const rate = (passes / myWindows.length) * 100;

  plog(
    `[done ${name}] shard rate ${passes}/${myWindows.length}=${rate.toFixed(2)}% / med=${medPassDay}d / p90=${p90PassDay}d / ${elapsed}s`,
  );

  return {
    windowsCompleted: myWindows.length,
    passes,
    passDays,
    reasonCounts,
    finalEquities,
    totalWindows,
    elapsedSec: elapsed,
  };
}

// Run all configs sequentially
plog(
  `=== V5-Family R58 Re-Validation start (shard ${SHARD_IDX}/${SHARD_COUNT}) ===`,
);

const allResults: Record<string, ShardResult | null> = {};
for (const entry of CONFIGS) {
  try {
    const res = runConfig(entry);
    allResults[entry.name] = res;
    // Save partial results after each config
    writeFileSync(
      `${CACHE_DIR}/v5fam_shard_${SHARD_IDX}_results.json`,
      JSON.stringify(allResults, null, 2),
    );
  } catch (e) {
    plog(`[ERROR ${entry.name}] ${(e as Error).message}`);
    allResults[entry.name] = null;
  }
}

plog(`=== V5-Family R58 Re-Validation DONE (shard ${SHARD_IDX}) ===`);
