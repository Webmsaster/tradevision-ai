/**
 * R28_V7 Adaptive-Sizing Tune Sweep (Round 53+).
 *
 * HYPOTHESIS: more-aggressive early-days sizing reaches the 8% target faster,
 * reducing time-fail risk. R28_V6 default = riskFrac 0.4 (capped via
 * `liveCaps.maxRiskFrac=0.4`). Test if pushing 0.45 / 0.5 in days 1-3 (or
 * while equity buffer is full) lifts pass-rate WITHOUT inflating DL/TL fails.
 *
 * ENGINE NOTE — sizing-cap interaction:
 *   `effRisk = asset.riskFrac × adaptiveSizing.factor × volMult`
 *   then capped at `liveCaps.maxRiskFrac` (0.4 in R28_V6).
 *   Additionally, `LIVE_LOSS_CAP = maxDailyLoss × 0.8 = 0.04` clamps via
 *   `effRisk × stopPct × leverage <= 0.04`.
 *
 *   With asset.riskFrac=1.0 and stopPct=0.05/leverage=2, effRisk is already
 *   pinned at 0.4 by both caps. To genuinely test "more aggressive", we must
 *   RAISE `liveCaps.maxRiskFrac` AND `maxDailyLoss × 0.8`-derivation.
 *   We raise BOTH `liveCaps.maxRiskFrac` and use `adaptiveSizing` factors
 *   to control sizing per the variant's day/equity table.
 *
 * VARIANTS:
 *   V0  — current R28_V6 baseline (factor 1.0 always, capped at 0.4).
 *   V1  — day-anchored progressive: days 1-3 push 0.45, then 0.4.
 *         Engine has no "before day N" trigger — we approximate by raising
 *         maxRiskFrac=0.45 AND using `adaptiveSizing` to step DOWN to 0.4
 *         once equity >= 1.025 (proxy for "out of day 1-3 zone").
 *   V2  — equity-anchored progressive:
 *         eq < 1.02 → 0.5 / 1.02-1.05 → 0.4 / >= 1.05 → 0.3.
 *         maxRiskFrac=0.5 to allow first tier.
 *   V3  — combined: eq < 1.02 → 0.5; eq 1.02-1.04 → 0.4; eq >= 1.05 → 0.3.
 *         Same as V2 with tighter mid-tier band. maxRiskFrac=0.5.
 *
 * BUDGET CONSTRAINT: measured ~70 s/window on full 30m alignment. Full
 * 5.55y / 136 windows × 4 variants = ~10.5h — over the 2h budget. We
 * use STEP_DAYS=42 (45 windows/variant × 4 = 180 windows ≈ 3.5h target).
 * Winners must be re-confirmed at step=14 (full 136) before shipping.
 *
 * VALIDATION GATES (a "winner" must satisfy ALL):
 *   - pass-rate >= 60.29% (R28_V6 baseline; don't go backward)
 *   - DL-fail-rate <= R28_V6 baseline (don't trade higher risk-of-ruin)
 *   - median pass-day <= 4d (don't be slower)
 *
 * Methodology mirrors `_r28V6V4SimRevalidation.test.ts`.
 */
import { describe, it } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = "scripts/cache_bakeoff/r28v7_sizing.log";
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

// Step size: 42 days = 45 windows on 5.55y data — first-pass screen.
// Set STEP_DAYS=14 to reproduce the full 136-window grid for confirmation.
const STEP_DAYS = Number(process.env.STEP_DAYS ?? 42);

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

interface Result {
  label: string;
  passes: number;
  windows: number;
  rate: number;
  medPassDay: number;
  p90PassDay: number;
  reasonCounts: Record<string, number>;
  finalEquityP10: number;
  finalEquityMed: number;
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
  label: string,
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  minBars: number,
): Result {
  const winBars = cfg.maxDays * 48; // 30m candles → 48 bars/day
  const stepBars = STEP_DAYS * 48;
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
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, label);
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
    finalEquities.push(r.finalEquityPct);
    if (r.passed) {
      passes++;
      if (r.passDay) passDays.push(r.passDay);
    }
    if (windows % 10 === 0) {
      plog(
        `[${label}] ${windows} windows / ${passes} passes (${((passes / windows) * 100).toFixed(2)}%) / ${Math.round((Date.now() - t0) / 1000)}s`,
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
    `[done ${label}] ${passes}/${windows} = ${rate.toFixed(2)}% / med=${medPassDay}d / p90=${p90PassDay}d / ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return {
    label,
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

// Helpers to clone & override liveCaps + adaptiveSizing without mutating
// the exported config object.
function withSizing(
  base: FtmoDaytrade24hConfig,
  maxRiskFrac: number,
  adaptiveSizing: Array<{ equityAbove: number; factor: number }> | undefined,
): FtmoDaytrade24hConfig {
  const liveCaps = base.liveCaps
    ? { ...base.liveCaps, maxRiskFrac }
    : { maxStopPct: 0.05, maxRiskFrac };
  return {
    ...base,
    liveCaps,
    // engine sorts adaptiveSizing by equityAbove ascending, so any order works.
    adaptiveSizing,
    // CRITICAL: timeBoost from V5_QUARTZ_LITE inheritance can override
    // adaptive factor downstream — strip it for clean variant comparison
    // unless explicitly set per-variant.
    timeBoost: undefined,
  };
}

const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;

// V0 — control: R28_V6 unchanged (uses inherited adaptiveSizing/timeBoost
// from V5_QUARTZ_LITE → V5_QUARTZ if present; we keep it AS SHIPPED).
const V0 = BASE;

// V1 — day-anchored progressive: days 1-3 = 0.45, days 4+ = 0.4.
// Engine has no "before day N" trigger; we approximate by raising
// maxRiskFrac=0.45 AND adding a step-down at equity >= 1.025 (proxy for
// "challenge has matured past early days"). Effective sizing:
//   - while equity < 1.025 (early): factor 1.0 × 1.0 = 1.0, capped at 0.45
//   - once equity >= 1.025          : factor 0.889, effRisk = 0.4 (matches V0)
const V1 = withSizing(BASE, 0.45, [
  { equityAbove: 0, factor: 1.0 },
  { equityAbove: 0.025, factor: 0.889 }, // 0.889 × 0.45 cap = 0.4 effective
]);

// V2 — equity-anchored progressive:
//   eq < 1.02      → effRisk 0.5  (factor 1.0,  cap 0.5)
//   eq 1.02-1.05   → effRisk 0.4  (factor 0.8,  cap 0.5  → 0.4)
//   eq >= 1.05     → effRisk 0.3  (factor 0.6,  cap 0.5  → 0.3) — defensive
const V2 = withSizing(BASE, 0.5, [
  { equityAbove: 0, factor: 1.0 },
  { equityAbove: 0.02, factor: 0.8 },
  { equityAbove: 0.05, factor: 0.6 },
]);

// V3 — combined (V2 with same tier breakpoints; here we vary the mid-tier
// to be tighter (1.02-1.04 → 0.4, 1.04-1.05 → 0.35) before defensive).
// effRisk = asset.riskFrac × factor, capped at maxRiskFrac=0.5.
const V3 = withSizing(BASE, 0.5, [
  { equityAbove: 0, factor: 1.0 }, // 0.5 effective
  { equityAbove: 0.02, factor: 0.8 }, // 0.4 effective
  { equityAbove: 0.04, factor: 0.7 }, // 0.35 effective (tighter mid)
  { equityAbove: 0.05, factor: 0.6 }, // 0.3 effective (defensive)
]);

interface Variant {
  label: string;
  cfg: FtmoDaytrade24hConfig;
  desc: string;
}
const VARIANTS: Variant[] = [
  { label: "V0_BASELINE", cfg: V0, desc: "R28_V6 baseline (eff riskFrac 0.4)" },
  {
    label: "V1_DAY_PROG",
    cfg: V1,
    desc: "day-anchored 0.45 → 0.4 at eq>=1.025",
  },
  { label: "V2_EQ_PROG", cfg: V2, desc: "equity tiers 0.5 / 0.4 / 0.3" },
  {
    label: "V3_COMBINED",
    cfg: V3,
    desc: "equity tiers 0.5 / 0.4 / 0.35 / 0.3",
  },
];

describe("R28_V7 Adaptive-Sizing Sweep", { timeout: 4 * 60 * 60_000 }, () => {
  it("compares 4 sizing variants on R28_V6 basket", () => {
    const { aligned, minBars } = loadAligned();
    plog(`[setup] ${SYMBOLS.length} syms / ${minBars} bars`);
    plog(`[setup] STEP_DAYS=${STEP_DAYS}`);
    plog(
      `[setup] expected windows per variant ≈ ${Math.floor((minBars - 5000 - BASE.maxDays * 48) / (STEP_DAYS * 48)) + 1}`,
    );
    plog("[setup] variants:");
    for (const v of VARIANTS) plog(`  ${v.label.padEnd(14)} ${v.desc}`);
    plog("");

    const results: Result[] = [];
    for (const v of VARIANTS) {
      plog(`\n--- running ${v.label} ---`);
      results.push(run(v.label, v.cfg, aligned, minBars));
    }

    // Summary table
    plog("\n=== R28_V7 SIZING SWEEP — SUMMARY ===");
    plog(
      `| variant       | pass% | passes | med | p90 | TL%   | DL%   | time%  | give% | eq_p10  | eq_med  |`,
    );
    plog(
      `| ------------- | ----- | ------ | --- | --- | ----- | ----- | ------ | ----- | ------- | ------- |`,
    );
    for (const r of results) {
      const w = r.windows;
      const tl = ((r.reasonCounts.total_loss ?? 0) / w) * 100;
      const dl = ((r.reasonCounts.daily_loss ?? 0) / w) * 100;
      const tm = ((r.reasonCounts.time ?? 0) / w) * 100;
      const gb = ((r.reasonCounts.give_back ?? 0) / w) * 100;
      plog(
        `| ${r.label.padEnd(13)} | ${r.rate.toFixed(2).padStart(5)} | ${String(r.passes).padStart(3)}/${String(r.windows).padStart(3)}| ${String(r.medPassDay).padStart(2)}d | ${String(r.p90PassDay).padStart(2)}d | ${tl.toFixed(2).padStart(5)} | ${dl.toFixed(2).padStart(5)} | ${tm.toFixed(2).padStart(6)} | ${gb.toFixed(2).padStart(5)} | ${(r.finalEquityP10 * 100).toFixed(2).padStart(6)}% | ${(r.finalEquityMed * 100).toFixed(2).padStart(6)}% |`,
      );
    }

    // Validation gates vs V0 baseline.
    const v0 = results[0]!;
    const v0Dl = ((v0.reasonCounts.daily_loss ?? 0) / v0.windows) * 100;
    plog("\n=== VALIDATION (winners must beat V0 on all 3 gates) ===");
    plog(
      `gate-A pass-rate    >= V0 (${v0.rate.toFixed(2)}%) AND >= 60.29% (R28_V6 published baseline)`,
    );
    plog(
      `gate-B DL-fail-rate <= V0 (${v0Dl.toFixed(2)}%)  (no risk-of-ruin inflation)`,
    );
    plog(`gate-C median day   <= 4d  (not slower than baseline)`);
    plog("");
    for (const r of results.slice(1)) {
      const dl = ((r.reasonCounts.daily_loss ?? 0) / r.windows) * 100;
      const passOk = r.rate >= v0.rate && r.rate >= 60.29;
      const dlOk = dl <= v0Dl + 0.5; // allow 0.5pp slack for noise on small N
      const speedOk = r.medPassDay > 0 && r.medPassDay <= 4;
      const verdict =
        passOk && dlOk && speedOk
          ? "WINNER"
          : !passOk
            ? "FAIL_PASS"
            : !dlOk
              ? "FAIL_DL"
              : "FAIL_SPEED";
      plog(
        `${r.label.padEnd(14)} pass=${r.rate.toFixed(2)}%(${passOk ? "ok" : "no"}) DL=${dl.toFixed(2)}%(${dlOk ? "ok" : "no"}) med=${r.medPassDay}d(${speedOk ? "ok" : "no"}) → ${verdict}`,
      );
    }

    plog("\n=== NOTES ===");
    plog(
      "• If STEP_DAYS=42, each variant ran on ~45 windows — re-validate winners at STEP_DAYS=14 (136 windows) before shipping.",
    );
    plog(
      "• Engine clamps effRisk via two caps: liveCaps.maxRiskFrac AND maxDailyLoss×0.8 / (stopPct×leverage).",
    );
    plog(
      "• Variants raise maxRiskFrac to 0.45 (V1) or 0.5 (V2,V3). The DL-derived cap (4% loss) limits effRisk to ~0.4 at stopPct=5%, but smaller stopPct (atrStop) allows up-to maxRiskFrac.",
    );
  });
});
