/**
 * R28_V7 News-Blackout Test — measure pass-rate delta when blocking
 * entries around high-impact USD events (FOMC/CPI/NFP/PPI/GDP).
 *
 * Baseline: R28_V6 = 56.62% post-R56 (5.55y / 136 windows / 30m / 14d step).
 * Memory R47: "News-Pause = Zero Effect on V5". This test verifies whether
 * that lesson generalizes to R28_V6's tightTP×0.55 + ptp 0.012 geometry.
 *
 * Method (mirrors `_r28V6V4SimRevalidation.test.ts` exactly):
 *   - 9 cryptos on 30m candles from `scripts/cache_bakeoff/`
 *   - 30-day rolling windows, 14-day step, 5000-bar warmup
 *   - V4 simulate() drives the challenge bar-by-bar
 *
 * Two runs:
 *   V0 = baseline R28_V6 (no blackout)             — sanity vs known 56.62%
 *   V1 = R28_V6 + cfg.newsBlackoutSet              — entry blocked on
 *        any 30m-bar whose openTime falls within
 *        [event - 30min, event + 60min].
 *
 * Caveat: HIGH_IMPACT_EVENTS_2026 is 2026-only. The 5.55y dataset
 * (~Aug 2020 – mid 2026) has hundreds of pre-2026 FOMC/CPI/NFP releases
 * that this test does NOT block. Reported delta is therefore a LOWER
 * BOUND on the news-blackout benefit (a full pre-2026 event list would
 * filter strictly more entries).
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run \
 *     --config vitest.scripts.config.ts \
 *     scripts/_r28V7NewsBlackoutTest.test.ts
 */
import { describe, it } from "vitest";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = `${CACHE_DIR}/r28v7_news_blackout.log`;
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

// ────────────────────────────────────────────────────────────────────────
// HIGH_IMPACT_EVENTS_2026 (mirrors tools/news_blackout.py)
// ────────────────────────────────────────────────────────────────────────
// ISO UTC string + label. Times are official BLS / Fed release moments.
const HIGH_IMPACT_EVENTS_2026: Array<[string, string]> = [
  // FOMC rate decisions (8/year, 18:00 UTC except Jan/Dec at 19:00)
  ["2026-01-28T19:00:00Z", "FOMC"],
  ["2026-03-18T18:00:00Z", "FOMC"],
  ["2026-04-29T18:00:00Z", "FOMC"],
  ["2026-06-17T18:00:00Z", "FOMC"],
  ["2026-07-29T18:00:00Z", "FOMC"],
  ["2026-09-16T18:00:00Z", "FOMC"],
  ["2026-10-28T18:00:00Z", "FOMC"],
  ["2026-12-09T19:00:00Z", "FOMC"],
  // CPI (monthly mid-month, 12:30 or 13:30 UTC)
  ["2026-01-13T13:30:00Z", "CPI"],
  ["2026-02-12T13:30:00Z", "CPI"],
  ["2026-03-12T12:30:00Z", "CPI"],
  ["2026-04-14T12:30:00Z", "CPI"],
  ["2026-05-13T12:30:00Z", "CPI"],
  ["2026-06-11T12:30:00Z", "CPI"],
  ["2026-07-15T12:30:00Z", "CPI"],
  ["2026-08-12T12:30:00Z", "CPI"],
  ["2026-09-11T12:30:00Z", "CPI"],
  ["2026-10-14T12:30:00Z", "CPI"],
  ["2026-11-12T13:30:00Z", "CPI"],
  ["2026-12-10T13:30:00Z", "CPI"],
  // NFP (first Friday of month)
  ["2026-01-02T13:30:00Z", "NFP"],
  ["2026-02-06T13:30:00Z", "NFP"],
  ["2026-03-06T13:30:00Z", "NFP"],
  ["2026-04-03T12:30:00Z", "NFP"],
  ["2026-05-01T12:30:00Z", "NFP"],
  ["2026-06-05T12:30:00Z", "NFP"],
  ["2026-07-03T12:30:00Z", "NFP"],
  ["2026-08-07T12:30:00Z", "NFP"],
  ["2026-09-04T12:30:00Z", "NFP"],
  ["2026-10-02T12:30:00Z", "NFP"],
  ["2026-11-06T13:30:00Z", "NFP"],
  ["2026-12-04T13:30:00Z", "NFP"],
  // PPI (monthly ~13-14th)
  ["2026-01-14T13:30:00Z", "PPI"],
  ["2026-02-13T13:30:00Z", "PPI"],
  ["2026-03-13T12:30:00Z", "PPI"],
  ["2026-04-15T12:30:00Z", "PPI"],
  ["2026-05-14T12:30:00Z", "PPI"],
  ["2026-06-12T12:30:00Z", "PPI"],
  ["2026-07-16T12:30:00Z", "PPI"],
  ["2026-08-13T12:30:00Z", "PPI"],
  ["2026-09-10T12:30:00Z", "PPI"],
  ["2026-10-15T12:30:00Z", "PPI"],
  ["2026-11-13T13:30:00Z", "PPI"],
  ["2026-12-11T13:30:00Z", "PPI"],
  // GDP advance (quarterly)
  ["2026-01-29T13:30:00Z", "GDP"],
  ["2026-04-29T12:30:00Z", "GDP"],
  ["2026-07-30T12:30:00Z", "GDP"],
  ["2026-10-29T12:30:00Z", "GDP"],
];

const BLACKOUT_BEFORE_MS = 30 * 60 * 1000;
const BLACKOUT_AFTER_MS = 60 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;

/**
 * Build a Set of 30m bar openTimes that fall in any blackout window
 * [event - 30min, event + 60min]. Restricted to bars whose openTime
 * is within minTs..maxTs (saves trivial allocations for non-2026 bars).
 */
function buildBlackoutSet(
  events: Array<[string, string]>,
  minTs: number,
  maxTs: number,
): { set: Set<number>; eventCount: number; barsBlocked: number } {
  const set = new Set<number>();
  let eventCount = 0;
  for (const [iso] of events) {
    const eventTs = Date.parse(iso);
    if (!Number.isFinite(eventTs)) continue;
    const winStart = eventTs - BLACKOUT_BEFORE_MS;
    const winEnd = eventTs + BLACKOUT_AFTER_MS;
    if (winEnd < minTs || winStart > maxTs) continue;
    eventCount++;
    // 30m grid: floor winStart to nearest 30m boundary, iterate up to winEnd.
    const firstBar = Math.floor(winStart / HALF_HOUR_MS) * HALF_HOUR_MS;
    for (let t = firstBar; t <= winEnd; t += HALF_HOUR_MS) {
      // Bar at openTime t covers [t, t + 30min). It overlaps the
      // blackout window iff t < winEnd && t + 30min > winStart.
      if (t < winEnd && t + HALF_HOUR_MS > winStart) {
        set.add(t);
      }
    }
  }
  return { set, eventCount, barsBlocked: set.size };
}

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
  passes: number;
  windows: number;
  rate: number;
  medPassDay: number;
  p90PassDay: number;
  totalTrades: number;
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
  let totalTrades = 0;
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
    totalTrades += r.trades.length;
    if (r.passed) {
      passes++;
      if (r.passDay) passDays.push(r.passDay);
    }
    // Progress every 5 windows — earlier feedback for slow runs.
    if (windows % 5 === 0) {
      plog(
        `  [${label}] ${windows} win / ${passes} pass (${((passes / windows) * 100).toFixed(2)}%) / ${Math.round((Date.now() - t0) / 1000)}s`,
      );
    }
  }
  passDays.sort((a, b) => a - b);
  const medPassDay =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const rate = (passes / windows) * 100;
  plog(
    `[done] ${label}: ${passes}/${windows} = ${rate.toFixed(2)}% / med=${medPassDay}d / p90=${quantile(passDays, 0.9)}d / trades=${totalTrades} / ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return {
    passes,
    windows,
    rate,
    medPassDay,
    p90PassDay: quantile(passDays, 0.9),
    totalTrades,
    reasonCounts,
  };
}

describe("R28_V7 News-Blackout Test", { timeout: 30 * 60_000 }, () => {
  it("measures R28_V6 pass-rate delta with FOMC/CPI/NFP blackout", () => {
    const { aligned, minBars } = loadAligned();
    const firstTs = aligned[SYMBOLS[0]!]![0]!.openTime;
    const lastTs = aligned[SYMBOLS[0]!]![minBars - 1]!.openTime;
    plog(`[setup] ${SYMBOLS.length} syms, ${minBars} bars`);
    plog(
      `[setup] data span: ${new Date(firstTs).toISOString()} → ${new Date(lastTs).toISOString()}`,
    );
    plog(`[setup] published R28_V6 baseline: 56.62% / med 4d / 136 windows`);

    const { set, eventCount, barsBlocked } = buildBlackoutSet(
      HIGH_IMPACT_EVENTS_2026,
      firstTs,
      lastTs,
    );
    plog(
      `[setup] news-blackout: ${eventCount}/${HIGH_IMPACT_EVENTS_2026.length} events in data span, ${barsBlocked} 30m-bars blocked`,
    );
    plog(
      `[setup] caveat: pre-2026 events (~5y of FOMC/CPI/NFP) NOT blocked → result is LOWER BOUND on benefit`,
    );

    plog("\n[run V0] baseline R28_V6 (no blackout)");
    const v0 = run(
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
      aligned,
      minBars,
      "V0",
    );

    const cfgV1: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
      newsBlackoutSet: set,
    };
    plog("\n[run V1] R28_V6 + news-blackout (FOMC/CPI/NFP/PPI/GDP, 2026)");
    const v1 = run(cfgV1, aligned, minBars, "V1");

    plog("\n=== R28_V7 NEWS-BLACKOUT RESULTS ===");
    plog(
      `V0 baseline:        ${v0.rate.toFixed(2)}% (${v0.passes}/${v0.windows}) med=${v0.medPassDay}d trades=${v0.totalTrades}`,
    );
    plog(
      `V1 with-blackout:   ${v1.rate.toFixed(2)}% (${v1.passes}/${v1.windows}) med=${v1.medPassDay}d trades=${v1.totalTrades}`,
    );
    const delta = v1.rate - v0.rate;
    const tradeDelta = v1.totalTrades - v0.totalTrades;
    plog(`\ndelta:              ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp`);
    plog(
      `trades affected:    ${tradeDelta} (${tradeDelta >= 0 ? "+" : ""}${((tradeDelta / Math.max(1, v0.totalTrades)) * 100).toFixed(2)}% vs V0)`,
    );

    plog("\n=== DRIFT vs PUBLISHED 56.62% ===");
    plog(`V0 drift:           ${(v0.rate - 56.62).toFixed(2)}pp`);
    if (Math.abs(v0.rate - 56.62) <= 0.74) {
      plog("V0 sanity:          within ±1 window noise — baseline reproduced");
    } else {
      plog(
        "V0 sanity:          drift > ±1 window — engine may have shifted since memory snapshot",
      );
    }

    plog("\n=== EVENT COVERAGE ===");
    plog(
      `events in 2026:     ${eventCount} (${((eventCount / HIGH_IMPACT_EVENTS_2026.length) * 100).toFixed(1)}% of 48-event list)`,
    );
    const yearsCovered = eventCount > 0 ? eventCount / 48 : 0;
    const dataYears = (lastTs - firstTs) / (365.25 * 86400_000);
    plog(
      `data years covered: ~${yearsCovered.toFixed(2)}y of ~${dataYears.toFixed(2)}y dataset (${((yearsCovered / dataYears) * 100).toFixed(1)}%)`,
    );

    plog("\n=== VERDICT ===");
    if (delta >= 1.0) {
      plog(
        `[ship]   +${delta.toFixed(2)}pp — ENABLE in production .env.ftmo (NEWS_BLACKOUT_ENABLED=true)`,
      );
      plog(
        `         Note: live executor already implements news_blackout.py — flipping the env-flag is sufficient.`,
      );
    } else if (delta >= -0.74 && delta <= 0.74) {
      plog(
        `[skip]   delta ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp within ±1 window noise — confirms R47 "no effect" lesson`,
      );
      plog(
        `         Recommendation: keep NEWS_BLACKOUT_ENABLED=false (default) for R28_V6.`,
      );
    } else if (delta < -0.74) {
      plog(
        `[harm]   ${delta.toFixed(2)}pp — news-blackout actively HURTS R28_V6. Do NOT enable.`,
      );
    } else {
      plog(
        `[weak]   +${delta.toFixed(2)}pp — sub-1pp lift, marginal. Keep disabled unless live re-validation confirms.`,
      );
    }
  });
});
