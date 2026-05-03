/**
 * Direct-runner for R28_V6 V4-Sim revalidation.
 *
 * Bypasses vitest (which adds ~2× per-window overhead via jsdom env +
 * inspector hooks) so we can complete in ~30-40 min instead of 80 min.
 *
 * Mirrors `scripts/_r28V6V4SimRevalidation.test.ts` exactly. Outputs to
 * stdout AND `scripts/cache_bakeoff/r28v6_revalidation.log`.
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = "scripts/cache_bakeoff/r28v6_revalidation.log";
writeFileSync(LOG_FILE, `[${new Date().toISOString()}] start\n`);
function plog(s: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`);
  console.log(s);
}

const SYMBOLS = [
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

function loadAligned(): { aligned: Record<string, Candle[]>; minBars: number } {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
  }
  const sets = SYMBOLS.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  return {
    aligned,
    minBars: Math.min(...SYMBOLS.map((s) => aligned[s]!.length)),
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

function run(
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  minBars: number,
) {
  const winBars = cfg.maxDays * 48;
  const stepBars = 14 * 48;
  const WARMUP = 5000;
  let passes = 0;
  let windows = 0;
  const passDays: number[] = [];
  const reasonCounts: Record<string, number> = {};
  const finalEquities: number[] = [];
  const t0 = Date.now();
  for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
    windows++;
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned))
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, "R28_V6_REVAL");
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
    finalEquities.push(r.finalEquityPct);
    if (r.passed) {
      passes++;
      if (r.passDay) passDays.push(r.passDay);
    }
    if (windows % 5 === 0) {
      plog(
        `[progress] ${windows} windows / ${passes} passes (${((passes / windows) * 100).toFixed(2)}%) / ${Math.round((Date.now() - t0) / 1000)}s`,
      );
    }
  }
  passDays.sort((a, b) => a - b);
  finalEquities.sort((a, b) => a - b);
  const medPassDay =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const p90PassDay = quantile(passDays, 0.9);
  const rate = (passes / windows) * 100;
  plog(
    `[done] R28_V6: ${passes}/${windows} = ${rate.toFixed(2)}% / med=${medPassDay}d / p90=${p90PassDay}d / ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return {
    passes,
    windows,
    rate,
    medPassDay,
    p90PassDay,
    reasonCounts,
    finalEquityP10: quantile(finalEquities, 0.1),
    finalEquityMed: quantile(finalEquities, 0.5),
  };
}

const { aligned, minBars } = loadAligned();
plog(`[setup] ${SYMBOLS.length} syms, ${minBars} bars`);
plog(`[setup] config = R28_V6 (uniform tpMult=0.55, ptp triggerPct=0.012)`);
plog(
  `[setup] pre-R56 baseline (2026-05-02 r28v5_tp_finegrid.log): 60.29% / med 4d / 136 windows\n`,
);

const r = run(
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  aligned,
  minBars,
);

plog("\n=== R28_V6 V4-ENGINE RE-VALIDATION (post-R56/R57/R58) ===");
plog(`pass-rate:           ${r.rate.toFixed(2)}% (${r.passes}/${r.windows})`);
plog(`median pass-day:     ${r.medPassDay}d`);
plog(`p90 pass-day:        ${r.p90PassDay}d`);
plog(`final equity p10:    ${(r.finalEquityP10 * 100).toFixed(2)}%`);
plog(`final equity med:    ${(r.finalEquityMed * 100).toFixed(2)}%`);
plog("");
plog("Failure reasons:");
const totalReasons = Object.values(r.reasonCounts).reduce((a, b) => a + b, 0);
for (const [reason, count] of Object.entries(r.reasonCounts).sort(
  (a, b) => b[1] - a[1],
)) {
  plog(
    `  ${reason.padEnd(15)} ${String(count).padStart(4)}  (${((count / totalReasons) * 100).toFixed(2)}%)`,
  );
}

plog("\n=== DRIFT vs PRE-R56 BASELINE ===");
const baseline = 60.29;
const drift = r.rate - baseline;
plog(`pre-R56 baseline:    ${baseline.toFixed(2)}%`);
plog(`post-R56/R57/R58 rate:   ${r.rate.toFixed(2)}%`);
plog(`drift:               ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}pp`);
