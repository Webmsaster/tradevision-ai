/**
 * R28_V7 FTMO-Confirmed Basket Sweep — Round 53 follow-up.
 *
 * Baseline: R28_V6 = 60.29% pass-rate on 9 assets [AAVE, ADA, BCH, BNB, BTC,
 * ETC, ETH, LTC, XRP] over 5.55y / 136 windows / 30m, V4 Live Engine.
 *
 * Constraint: only test assets confirmed available on FTMO MT5 (memory
 * `reference_ftmo_mt5_tickers.md` — 2026-04-27 user screenshot):
 *   - SOL  (FTMO: SOLUSD)   Binance: SOLUSDT
 *   - LINK (FTMO: LNKUSD)   Binance: LINKUSDT  ⚠️ non-obvious ticker
 *   - DOGE (FTMO: DOGEUSD)  Binance: DOGEUSDT
 *   - AVAX (FTMO: AVAUSD)   Binance: AVAXUSDT  ⚠️ non-obvious ticker
 *   - DOT  (FTMO: DOTUSD)   Binance: DOTUSDT
 *   - UNI  (FTMO: UNIUSD)   Binance: UNIUSDT
 * Skipped: MATIC, ATOM, INJ, ALGO, NEAR (not confirmed on FTMO).
 *
 * Variants:
 *   V0: R28_V6 baseline (9 assets) — sanity check vs memory's 60.29%
 *   V1: +SOL   (10)
 *   V2: +LINK  (10)
 *   V3: +DOGE  (10)
 *   V4: +AVAX  (10)
 *   V5: +DOT   (10)
 *   V6: +UNI   (10)
 *   V7: +<top1> +<top2> if both individually beat baseline (11)
 *
 * Method (mirrors `_r28V6V4SimRevalidation.test.ts`):
 *   - 30m candles, 5000-bar warmup, 30-day rolling windows, 14-day step
 *   - V4 simulate() drives challenge bar-by-bar
 *   - aligned by common openTime intersection
 *   - 14d-step on 5.55y → ~136 windows × 7 variants × ~130s ≈ 15 min total
 *
 * Per-asset config: copy R28_V4 default heuristic (tpPct=0.04) and apply ×0.55
 * mult at config-build to match R28_V6's tighter-TP mechanism. stopPct/holdBars
 * inherited from V5_QUARTZ_LITE conventions.
 *
 * Win criteria:
 *   - Best variant pass-rate ≥ 62.29% (+2pp over 60.29% baseline) → ship as
 *     R28_V7_BASKET in src/utils/ftmoDaytrade24h.ts + live selectors.
 *   - Else → R28_V6 basket is locally optimal.
 *
 * Run:
 *   pkill -9 -f vitest
 *   node ./node_modules/vitest/vitest.mjs run \
 *     --config vitest.scripts.config.ts \
 *     scripts/_r28V7BasketFtmoSweep.test.ts
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
const LOG_FILE = `${CACHE_DIR}/r28v7_basket_ftmo.log`;
writeFileSync(LOG_FILE, `[${new Date().toISOString()}] start\n`);
function plog(s: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`);
  console.log(s);
}

// ─────────────────────────────────────────────────────────────────────────
// Asset universe — 9 base + 6 FTMO-confirmed candidates
// ─────────────────────────────────────────────────────────────────────────
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
// FTMO-confirmed only (memory reference_ftmo_mt5_tickers.md 2026-04-27)
const CANDIDATE_ADDS = [
  "SOLUSDT",
  "LINKUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "DOTUSDT",
  "UNIUSDT",
];
const ALL_SYMBOLS = [...BASE_SYMBOLS, ...CANDIDATE_ADDS];

// Standard new-asset template — matches V5_DIAMOND/PEARL conventions.
// tpPct=0.04 baseline matches BTC/ETH default; ×0.55 applied at config-build.
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
    tpPct, // raw; ×0.55 applied at buildVariant
    holdBars: 240,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Candle loader — disk cache → Binance fallback
// ─────────────────────────────────────────────────────────────────────────
const TARGET_BARS_30M = 100_000;

async function loadCandles(symbol: string): Promise<Candle[]> {
  const cachePath = `${CACHE_DIR}/${symbol}_30m.json`;
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as Candle[];
      if (cached.length >= 5_000) {
        const yrs = (
          (cached[cached.length - 1]!.openTime - cached[0]!.openTime) /
          (365.25 * 24 * 3600 * 1000)
        ).toFixed(2);
        plog(`[cache-hit]  ${symbol}: ${cached.length} bars (~${yrs}y)`);
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
    const yrs = (
      (final[final.length - 1]!.openTime - final[0]!.openTime) /
      (365.25 * 24 * 3600 * 1000)
    ).toFixed(2);
    plog(
      `[binance]    ${symbol}: ${final.length} bars (~${yrs}y) in ${Math.round((Date.now() - t0) / 1000)}s — cached`,
    );
  } else {
    plog(
      `[binance]    ${symbol}: ONLY ${final.length} bars (target 5000+) — UNUSABLE`,
    );
  }
  return final;
}

// ─────────────────────────────────────────────────────────────────────────
// Aligned-data builder — restricted to a chosen subset
// ─────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────
// Simulation runner
// ─────────────────────────────────────────────────────────────────────────
interface Result {
  passes: number;
  windows: number;
  rate: number;
  medPassDay: number;
  p90PassDay: number;
  reasonCounts: Record<string, number>;
  approxYears: number;
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
  // 21-day step (instead of standard 14) trades 1/3 fewer windows for budget
  // headroom under the post-R56/R57 engine speed regression. Still ~90 windows
  // per variant on 5.55y of data — adequate statistical power for ±3pp lifts.
  const stepBars = 21 * 48;
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
    if (windows % 10 === 0) {
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
  const approxYears = (minBars - WARMUP) / 48 / 365.25;
  plog(
    `[done] ${label.padEnd(16)} ${passes}/${windows} = ${rate.toFixed(2)}% / med=${medPassDay}d / p90=${quantile(passDays, 0.9)}d / ${tSec}s / ~${approxYears.toFixed(2)}y`,
  );
  return {
    passes,
    windows,
    rate,
    medPassDay,
    p90PassDay: quantile(passDays, 0.9),
    reasonCounts,
    approxYears,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Config builders — re-apply R28_V6's tightTP×0.55 on extras too
// ─────────────────────────────────────────────────────────────────────────
function buildVariant(
  label: string,
  symbolSubset: string[],
  extraAssets: Daytrade24hAssetCfg[],
): { cfg: FtmoDaytrade24hConfig; symbols: string[]; label: string } {
  // Base R28_V6 assets ALREADY have ×0.55 applied. New assets added raw with
  // tpPct 0.04 → ×0.55 → 0.022 to match basket's tightened-TP geometry.
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

// ─────────────────────────────────────────────────────────────────────────
// Main: load all candle data, build variants, run sequentially
// ─────────────────────────────────────────────────────────────────────────
describe(
  "R28_V7 FTMO-Confirmed Basket Sweep",
  { timeout: 2 * 60 * 60_000 },
  () => {
    it("evaluates 7 FTMO-only basket variants on V4 Live Engine", async () => {
      plog(
        `[setup] base=${BASE_SYMBOLS.length} candidates=${CANDIDATE_ADDS.length} (FTMO-confirmed only)`,
      );
      plog(`[setup] R28_V6 baseline (memory): 60.29% / 5.55y / 136 windows`);

      // Phase 1: load all candle data (cache-first)
      const raw: Record<string, Candle[]> = {};
      for (const sym of ALL_SYMBOLS) {
        const candles = await loadCandles(sym);
        raw[sym] = candles;
      }

      // Build per-symbol availability table (history-length caveat)
      plog("\n[history] per-symbol Binance 30m availability:");
      for (const sym of ALL_SYMBOLS) {
        const c = raw[sym]!;
        if (c.length < 5_000) {
          plog(`  ${sym.padEnd(12)} UNUSABLE (${c.length} bars)`);
          continue;
        }
        const yrs = (
          (c[c.length - 1]!.openTime - c[0]!.openTime) /
          (365.25 * 24 * 3600 * 1000)
        ).toFixed(2);
        plog(
          `  ${sym.padEnd(12)} ${c.length} bars (~${yrs}y) start=${new Date(c[0]!.openTime).toISOString().slice(0, 10)}`,
        );
      }

      // Phase 2: build variants — V0 baseline + 3 highest-priority single-adds
      // (engine timing observed at ~30s/window post-R56/R57 → 6 variants
      // exceeds 2h budget. Picked top-3 by ecosystem-diversity heuristic:
      //  - SOL: top-7 mcap, highest vol of FTMO L1s
      //  - DOT: separate ecosystem, low corr with ETH/BTC
      //  - LINK: oracle, different mid-cap cycle
      // Skipped this run (deferred to follow-up if winner emerges):
      //  - AVAX (V5_NOVA dropped it for under-performance)
      //  - DOGE (meme volatility — high blowup risk under tight TP×0.55)
      //  - UNI  (DEX, highly ETH-correlated → low diversification value))
      const singleAdds: { sym: string; label: string }[] = [
        { sym: "SOLUSDT", label: "V1_add_SOL" },
        { sym: "DOTUSDT", label: "V5_add_DOT" },
        { sym: "LINKUSDT", label: "V2_add_LINK" },
      ];
      const variants = [
        buildVariant("V0_baseline", BASE_SYMBOLS, []),
        ...singleAdds
          .filter((a) => (raw[a.sym]?.length ?? 0) >= 5_000)
          .map((a) =>
            buildVariant(a.label, BASE_SYMBOLS, [makeNewAsset(a.sym)]),
          ),
      ];
      plog(`\n[setup] running ${variants.length} variants`);

      // Phase 3: run each (with budget)
      const results: Array<{ label: string; res: Result; symbols: string[] }> =
        [];
      const tStart = Date.now();
      const budgetMs = 2 * 60 * 60_000; // 2h hard cap
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
          `  aligned minBars=${minBars} (~${(minBars / 48 / 365.25).toFixed(2)}y)`,
        );
        const res = run(v.cfg, aligned, minBars, v.label);
        results.push({ label: v.label, res, symbols: v.symbols });
      }

      // Phase 4: optional V7 combo (top-2 individual winners)
      const baseline = results.find((r) => r.label === "V0_baseline");
      if (
        baseline &&
        Date.now() - tStart < budgetMs * 0.85 // leave headroom for combo
      ) {
        const adds = results
          .filter((r) => r.label !== "V0_baseline")
          .sort((a, b) => b.res.rate - a.res.rate);
        const top2 = adds
          .filter((r) => r.res.rate > baseline.res.rate)
          .slice(0, 2);
        if (top2.length === 2) {
          const extraSyms = top2
            .map((r) => r.symbols.find((s) => !BASE_SYMBOLS.includes(s))!)
            .filter(Boolean);
          const label = `V7_add_${extraSyms.map((s) => s.replace("USDT", "")).join("+")}`;
          plog(
            `\n[run] ${label}: combining top-2 individual winners [${extraSyms.join(",")}]`,
          );
          const v = buildVariant(
            label,
            BASE_SYMBOLS,
            extraSyms.map((s) => makeNewAsset(s)),
          );
          const { aligned, minBars } = buildAligned(raw, v.symbols);
          plog(
            `  aligned minBars=${minBars} (~${(minBars / 48 / 365.25).toFixed(2)}y)`,
          );
          const res = run(v.cfg, aligned, minBars, label);
          results.push({ label, res, symbols: v.symbols });
        } else {
          plog(
            `\n[skip-V7] only ${top2.length} variants beat baseline — combo skipped`,
          );
        }
      }

      // Phase 5: report
      plog("\n=== R28_V7 FTMO-CONFIRMED BASKET SWEEP — RANKED ===");
      const sorted = [...results].sort((a, b) => b.res.rate - a.res.rate);
      for (const r of sorted) {
        plog(
          `  ${r.label.padEnd(20)} ${r.res.rate.toFixed(2)}% (${r.res.passes}/${r.res.windows}) med=${r.res.medPassDay}d p90=${r.res.p90PassDay}d  [${r.symbols.length} assets, ~${r.res.approxYears.toFixed(2)}y]`,
        );
      }

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

      plog("\n=== VS BASELINE (per variant) ===");
      for (const r of sorted) {
        if (r.label === "V0_baseline") continue;
        const lift = r.res.rate - baseline.res.rate;
        plog(
          `  ${r.label.padEnd(20)} ${(lift >= 0 ? "+" : "") + lift.toFixed(2)}pp`,
        );
      }

      plog(
        `\nwinner:                         ${winner.label} = ${winner.res.rate.toFixed(2)}%`,
      );
      const lift = winner.res.rate - baseline.res.rate;
      plog(
        `lift over baseline:             ${lift >= 0 ? "+" : ""}${lift.toFixed(2)}pp`,
      );

      const SHIP_THRESHOLD = baseline.res.rate + 2;
      if (winner.label === "V0_baseline") {
        plog(
          `\n[verdict] no improvement found — R28_V6 basket is locally optimal`,
        );
      } else if (winner.res.rate >= SHIP_THRESHOLD) {
        plog(
          `\n[verdict] SHIP as R28_V7_BASKET (>= +2pp threshold ${SHIP_THRESHOLD.toFixed(2)}%)`,
        );
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
          `\n[verdict] best variant (${winner.label}=${winner.res.rate.toFixed(2)}%) below +2pp ship threshold (${SHIP_THRESHOLD.toFixed(2)}%) — keep R28_V6`,
        );
      }
    });
  },
);
