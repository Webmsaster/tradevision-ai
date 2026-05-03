/**
 * R28_V7 Basket Sweep — Asset-basket optimization on top of R28_V6.
 *
 * Baseline: R28_V6 = 60.29% pass-rate on 9 assets [AAVE, ADA, BCH, BNB, BTC,
 * ETC, ETH, LTC, XRP], 5.55y / 136 windows / 30m, V4 Live Engine.
 *
 * Hypothesis: V5_QUARTZ family started with more assets and converged to 9
 * via greedy drops — but that was BEFORE R28_V6's tightTP×0.55 + ptp 0.012.
 * The optimal basket may shift now that the per-asset TP geometry changed.
 *
 * Pragmatic 5-variant sweep + baseline (6 runs ~1.4h budget):
 *   - baseline:  R28_V6 unchanged (9 assets) — re-validation anchor
 *   - drop_AAVE: drop AAVEUSDT (lowest-volume in basket)
 *   - drop_ETC:  drop ETCUSDT (high-correlation with ETH)
 *   - add_SOL:   + SOLUSDT (top-7 by mcap, higher-vol than AVAX)
 *   - add_MATIC: + MATICUSDT (mid-cap, low correlation with majors)
 *   - add_ATOM:  + ATOMUSDT (cosmos ecosystem, low correlation)
 *
 * Method mirrors `_r28V6V4SimRevalidation.test.ts` exactly:
 *   - 30m candles, 5000-bar warmup, 30-day rolling windows, 14-day step
 *   - V4 simulate() drives challenge bar-by-bar
 *   - aligned by common openTime intersection (drops bars not in every asset)
 *
 * SOL/MATIC/ATOM/INJ are NOT in cache_bakeoff/ — fetched from Binance via
 * loadBinanceHistory + cached for re-runs.
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run \
 *     --config vitest.scripts.config.ts \
 *     scripts/_r28V7BasketSweep.test.ts
 */
import { describe, it } from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = `${CACHE_DIR}/r28v7_basket_sweep.log`;
writeFileSync(LOG_FILE, `[${new Date().toISOString()}] start\n`);
function plog(s: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`);
  console.log(s);
}

// ────────────────────────────────────────────────────────────────────────
// Asset universe — base (9) + candidate adds (4)
// ────────────────────────────────────────────────────────────────────────
// `sourceSymbol` is the Binance ticker; aligned-candle dict is keyed by it.
const BASE_SYMBOLS = [
  "AAVEUSDT",
  "ADAUSDT",
  "BCHUSDT",
  "BNBUSDT",
  "BTCUSDT",
  "ETCUSDT",
  "ETHUSDT",
  "LTCUSDT",
  "XRPUSDT",
];
const CANDIDATE_ADDS = ["SOLUSDT", "MATICUSDT", "ATOMUSDT"];
const ALL_SYMBOLS = [...BASE_SYMBOLS, ...CANDIDATE_ADDS];

// Standard new-asset template — matches conventions from V5_DIAMOND/PEARL
// where INJ/RUNE/ATOM were added with these exact fields. R28_V4 inherits
// per-asset config from V5_QUARTZ_LITE; the tpPct ×0.55 multiplier is
// applied at config-build time below to mirror R28_V6's mechanism.
function makeNewAsset(sourceSymbol: string, tpPct = 0.04): Daytrade24hAssetCfg {
  const ticker = sourceSymbol.replace("USDT", "");
  return {
    symbol: `${ticker}-TREND`,
    sourceSymbol,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: true,
    stopPct: 0.05,
    tpPct, // baseline 0.04 — will be ×0.55 at config-build → 0.022
    holdBars: 240,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Candle loader — disk cache → Binance fallback
// ────────────────────────────────────────────────────────────────────────
const TARGET_BARS_30M = 100_000;

async function loadCandles(symbol: string): Promise<Candle[]> {
  const cachePath = `${CACHE_DIR}/${symbol}_30m.json`;
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as Candle[];
      if (cached.length >= 5_000) {
        plog(`[cache-hit]  ${symbol}: ${cached.length} bars`);
        return cached;
      }
    } catch (e) {
      plog(`[cache-bad]  ${symbol}: ${(e as Error).message}`);
    }
  }
  plog(`[cache-miss] ${symbol}: fetching from Binance`);
  const t0 = Date.now();
  const r = await loadBinanceHistory({
    symbol,
    timeframe: "30m",
    targetCount: TARGET_BARS_30M,
    maxPages: 110,
  });
  const final = r.filter((c) => c.isFinal);
  if (final.length >= 5_000) {
    writeFileSync(cachePath, JSON.stringify(final));
    plog(
      `[binance]    ${symbol}: ${final.length} bars in ${Math.round((Date.now() - t0) / 1000)}s — cached`,
    );
  } else {
    plog(
      `[binance]    ${symbol}: ONLY ${final.length} bars (target 5000+) — UNUSABLE`,
    );
  }
  return final;
}

// ────────────────────────────────────────────────────────────────────────
// Aligned-data builder — restricted to a chosen subset
// ────────────────────────────────────────────────────────────────────────
function buildAligned(
  raw: Record<string, Candle[]>,
  symbols: string[],
): { aligned: Record<string, Candle[]>; minBars: number } {
  const sets = symbols.map((s) => new Set(raw[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = raw[s]!.filter((c) => cs.has(c.openTime));
  return {
    aligned,
    minBars: Math.min(...symbols.map((s) => aligned[s]!.length)),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Simulation runner
// ────────────────────────────────────────────────────────────────────────
interface Result {
  passes: number;
  windows: number;
  rate: number;
  medPassDay: number;
  p90PassDay: number;
  reasonCounts: Record<string, number>;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}

function run(
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  minBars: number,
  label: string,
): Result {
  const winBars = cfg.maxDays * 48; // 30m → 48 bars/day
  const stepBars = 14 * 48;
  const WARMUP = 5000;
  let passes = 0;
  let windows = 0;
  const passDays: number[] = [];
  const reasonCounts: Record<string, number> = {};
  const t0 = Date.now();
  for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
    windows++;
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned))
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, label);
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
    if (r.passed) {
      passes++;
      if (r.passDay) passDays.push(r.passDay);
    }
    if (windows % 20 === 0) {
      plog(
        `  [${label}] ${windows} win / ${passes} pass (${((passes / windows) * 100).toFixed(2)}%) / ${Math.round((Date.now() - t0) / 1000)}s`,
      );
    }
  }
  passDays.sort((a, b) => a - b);
  const medPassDay =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const rate = (passes / windows) * 100;
  const tSec = Math.round((Date.now() - t0) / 1000);
  plog(
    `[done] ${label.padEnd(14)} ${passes}/${windows} = ${rate.toFixed(2)}% / med=${medPassDay}d / p90=${quantile(passDays, 0.9)}d / ${tSec}s`,
  );
  return {
    passes,
    windows,
    rate,
    medPassDay,
    p90PassDay: quantile(passDays, 0.9),
    reasonCounts,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Config builders — apply R28_V6's tightTP×0.55 to fresh assets too
// ────────────────────────────────────────────────────────────────────────
function buildVariant(
  label: string,
  symbolSubset: string[],
  extraAssets: Daytrade24hAssetCfg[],
): { cfg: FtmoDaytrade24hConfig; symbols: string[]; label: string } {
  // Base R28_V6 assets ALREADY have ×0.55 applied. New assets are added
  // raw with tpPct 0.04 → multiply by 0.55 → 0.022 to match the basket.
  const baseAssets =
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6.assets.filter((a) =>
      symbolSubset.includes(a.sourceSymbol ?? a.symbol),
    );
  const adjustedExtras = extraAssets.map((a) => ({
    ...a,
    tpPct: (a.tpPct ?? 0.04) * 0.55,
  }));
  const allAssets = [...baseAssets, ...adjustedExtras];
  const cfg: FtmoDaytrade24hConfig = {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
    assets: allAssets,
  };
  const allSymbols = [
    ...symbolSubset,
    ...extraAssets.map((a) => a.sourceSymbol ?? a.symbol),
  ];
  return { cfg, symbols: allSymbols, label };
}

// ────────────────────────────────────────────────────────────────────────
// Main: load all candle data, build 6 variants, run sequentially
// ────────────────────────────────────────────────────────────────────────
describe("R28_V7 Basket Sweep", { timeout: 3 * 60 * 60_000 }, () => {
  it("evaluates 6 basket variants on 5.55y / 136 windows", async () => {
    plog(
      `[setup] base=${BASE_SYMBOLS.length} candidates=${CANDIDATE_ADDS.length}`,
    );
    plog(`[setup] R28_V6 baseline (memory): 60.29% / 5.55y / 136 windows`);

    // Phase 1: load all candle data (cache-first)
    const raw: Record<string, Candle[]> = {};
    for (const sym of ALL_SYMBOLS) {
      const candles = await loadCandles(sym);
      if (candles.length < 5_000) {
        plog(
          `[abort?] ${sym} unusable (${candles.length} bars) — variants depending on it will be skipped`,
        );
      }
      raw[sym] = candles;
    }

    // Phase 2: build variants
    const variants = [
      // baseline = current R28_V6 9-asset basket
      buildVariant("baseline", BASE_SYMBOLS, []),
      // drops
      buildVariant(
        "drop_AAVE",
        BASE_SYMBOLS.filter((s) => s !== "AAVEUSDT"),
        [],
      ),
      buildVariant(
        "drop_ETC",
        BASE_SYMBOLS.filter((s) => s !== "ETCUSDT"),
        [],
      ),
      // adds (only if data available)
      ...(raw["SOLUSDT"]!.length >= 5_000
        ? [buildVariant("add_SOL", BASE_SYMBOLS, [makeNewAsset("SOLUSDT")])]
        : []),
      ...(raw["MATICUSDT"]!.length >= 5_000
        ? [buildVariant("add_MATIC", BASE_SYMBOLS, [makeNewAsset("MATICUSDT")])]
        : []),
      ...(raw["ATOMUSDT"]!.length >= 5_000
        ? [buildVariant("add_ATOM", BASE_SYMBOLS, [makeNewAsset("ATOMUSDT")])]
        : []),
    ];
    plog(`[setup] running ${variants.length} variants`);

    // Phase 3: run each
    const results: Array<{ label: string; res: Result; symbols: string[] }> =
      [];
    const tStart = Date.now();
    const budgetMs = 2 * 60 * 60_000; // 2h hard budget
    for (const v of variants) {
      const elapsed = Date.now() - tStart;
      if (elapsed > budgetMs) {
        plog(
          `[abort] 2h budget exceeded after ${results.length} variants — partial report`,
        );
        break;
      }
      plog(
        `\n[run] ${v.label}: ${v.symbols.length} assets [${v.symbols.join(",")}]`,
      );
      const { aligned, minBars } = buildAligned(raw, v.symbols);
      plog(
        `  aligned minBars=${minBars} (~${(minBars / 48 / 365).toFixed(2)}y)`,
      );
      const res = run(v.cfg, aligned, minBars, v.label);
      results.push({ label: v.label, res, symbols: v.symbols });
    }

    // Phase 4: report — sorted by pass-rate
    plog("\n=== R28_V7 BASKET SWEEP — RANKED ===");
    const sorted = [...results].sort((a, b) => b.res.rate - a.res.rate);
    for (const r of sorted) {
      plog(
        `  ${r.label.padEnd(12)} ${r.res.rate.toFixed(2)}% (${r.res.passes}/${r.res.windows}) med=${r.res.medPassDay}d p90=${r.res.p90PassDay}d  [${r.symbols.length} assets]`,
      );
    }

    const baseline = results.find((r) => r.label === "baseline");
    const winner = sorted[0];
    if (!baseline || !winner) {
      plog("\n[fatal] no baseline or winner — all variants failed");
      return;
    }

    plog("\n=== VS BASELINE ===");
    plog(`baseline (R28_V6 reproduction): ${baseline.res.rate.toFixed(2)}%`);
    plog(`memory R28_V6 expectation:      60.29%`);
    plog(
      `baseline drift:                 ${(baseline.res.rate - 60.29).toFixed(2)}pp`,
    );

    plog(
      `\nwinner:                         ${winner.label} = ${winner.res.rate.toFixed(2)}%`,
    );
    const lift = winner.res.rate - baseline.res.rate;
    plog(
      `lift over baseline:             ${lift >= 0 ? "+" : ""}${lift.toFixed(2)}pp`,
    );

    if (winner.label === "baseline") {
      plog(
        `\n[verdict] no improvement found, R28_V6 basket is locally optimal`,
      );
    } else if (winner.res.rate >= 61) {
      plog(`\n[verdict] SHIP as R28_V7_BASKET candidate`);
      const baseSyms = new Set(BASE_SYMBOLS);
      const winSyms = new Set(winner.symbols);
      const dropped = [...baseSyms].filter((s) => !winSyms.has(s));
      const added = [...winSyms].filter((s) => !baseSyms.has(s));
      plog(
        `  basket diff: drop=[${dropped.join(",") || "—"}] add=[${added.join(",") || "—"}]`,
      );
      plog(`  full basket: [${winner.symbols.join(",")}]`);
    } else {
      plog(
        `\n[verdict] best variant (${winner.label}=${winner.res.rate.toFixed(2)}%) below 61% threshold — keep R28_V6`,
      );
    }
  });
});
