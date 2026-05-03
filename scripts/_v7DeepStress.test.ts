/**
 * V7_1H_OPT deep-stress audit: prove or break the 87.76% organic claim.
 *
 * Suspicions:
 *   1. crossAssetFilter (BTC EMA 8/16 mom=0.04) doing the heavy lifting → cherry-picks signals
 *   2. small asset pool (ETH/BTC/SOL only) → survivorship
 *   3. step=3d windowing → small N → high variance (luck)
 *   4. recency bias — last 1y might be 99% pass, earlier years lower
 *   5. lossStreakCooldown 96 bars hides drawdowns
 *
 * We test:
 *   A. V7 baseline (sanity-check: 87% repro?)
 *   B. V7 step=1d (more windows = tighter CI)
 *   C. V7 without crossAssetFilter
 *   D. V7 without lossStreakCooldown
 *   E. V7 without htfTrendFilter
 *   F. V7 split by year (recency check)
 *   G. V7 with step=1d block-bootstrap CI (250 resamples)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY_1H = 24;

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

function evaluate(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  stepDays = 3,
  startBar = 0,
  endBar?: number,
) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = endBar ?? Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (n === 0) return null;
  const winBars = cfg.maxDays * BARS_PER_DAY_1H;
  const stepBars = stepDays * BARS_PER_DAY_1H;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0;
  const days: number[] = [];
  for (let start = startBar; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (res.passed) {
      passes++;
      if (res.passDay && res.passDay > 0) days.push(res.passDay);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
  }
  days.sort((a, b) => a - b);
  return {
    windows,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
  };
}

describe("V7_1H_OPT deep stress", { timeout: 60 * 60_000 }, () => {
  it("multi-dimensional audit", async () => {
    const V7 = FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT;
    const symbols = syms(V7);
    console.log(`\nV7_1H_OPT symbols: ${symbols.join(", ")}`);
    console.log(`Loading 1h data for ${symbols.length} symbols...`);
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const r = await loadBinanceHistory({
        symbol: s,
        timeframe: "1h",
        targetCount: 100000,
        maxPages: 120,
      });
      data[s] = r.filter((c) => c.isFinal);
      console.log(
        `  ${s}: ${data[s].length} bars (${new Date(data[s][0].openTime).toISOString().slice(0, 10)} → ${new Date(data[s][data[s].length - 1].openTime).toISOString().slice(0, 10)})`,
      );
    }

    // --- A. baseline: V7 step=3d both pause modes ---
    console.log("\n=== A. BASELINE step=3d ===");
    const aPause = evaluate({ ...V7, pauseAtTargetReached: true }, data, 3);
    const aNoPause = evaluate({ ...V7, pauseAtTargetReached: false }, data, 3);
    console.log(
      `V7 PAUSE     n=${aPause?.windows} pass=${((aPause?.passRate ?? 0) * 100).toFixed(2)}% TL=${((aPause?.tlPct ?? 0) * 100).toFixed(2)}% DL=${((aPause?.dlPct ?? 0) * 100).toFixed(2)}% med=${aPause?.med}d p90=${aPause?.p90}d`,
    );
    console.log(
      `V7 NO-PAUSE  n=${aNoPause?.windows} pass=${((aNoPause?.passRate ?? 0) * 100).toFixed(2)}% TL=${((aNoPause?.tlPct ?? 0) * 100).toFixed(2)}% DL=${((aNoPause?.dlPct ?? 0) * 100).toFixed(2)}% med=${aNoPause?.med}d p90=${aNoPause?.p90}d`,
    );

    // --- B. step=1d (more windows = tighter CI) ---
    console.log("\n=== B. step=1d (more windows = lower variance) ===");
    const bPause = evaluate({ ...V7, pauseAtTargetReached: true }, data, 1);
    const bNoPause = evaluate({ ...V7, pauseAtTargetReached: false }, data, 1);
    console.log(
      `V7 PAUSE     n=${bPause?.windows} pass=${((bPause?.passRate ?? 0) * 100).toFixed(2)}%`,
    );
    console.log(
      `V7 NO-PAUSE  n=${bNoPause?.windows} pass=${((bNoPause?.passRate ?? 0) * 100).toFixed(2)}%`,
    );

    // --- C. ablations: drop critical filters ---
    console.log("\n=== C. ABLATIONS (NO-PAUSE, step=3d) ===");
    const noCAF = {
      ...V7,
      pauseAtTargetReached: false,
      crossAssetFilter: undefined,
    };
    const noLSC = {
      ...V7,
      pauseAtTargetReached: false,
      lossStreakCooldown: undefined,
    };
    const noHTF = {
      ...V7,
      pauseAtTargetReached: false,
      htfTrendFilter: undefined,
    };
    const noChand = {
      ...V7,
      pauseAtTargetReached: false,
      chandelierExit: undefined,
    };
    const cCAF = evaluate(noCAF, data, 3);
    const cLSC = evaluate(noLSC, data, 3);
    const cHTF = evaluate(noHTF, data, 3);
    const cChand = evaluate(noChand, data, 3);
    console.log(
      `baseline NO-PAUSE pass=${((aNoPause?.passRate ?? 0) * 100).toFixed(2)}%`,
    );
    console.log(
      `  no crossAssetFilter:    pass=${((cCAF?.passRate ?? 0) * 100).toFixed(2)}% Δ=${(((cCAF?.passRate ?? 0) - (aNoPause?.passRate ?? 0)) * 100).toFixed(2)}pp`,
    );
    console.log(
      `  no lossStreakCooldown:  pass=${((cLSC?.passRate ?? 0) * 100).toFixed(2)}% Δ=${(((cLSC?.passRate ?? 0) - (aNoPause?.passRate ?? 0)) * 100).toFixed(2)}pp`,
    );
    console.log(
      `  no htfTrendFilter:      pass=${((cHTF?.passRate ?? 0) * 100).toFixed(2)}% Δ=${(((cHTF?.passRate ?? 0) - (aNoPause?.passRate ?? 0)) * 100).toFixed(2)}pp`,
    );
    console.log(
      `  no chandelierExit:      pass=${((cChand?.passRate ?? 0) * 100).toFixed(2)}% Δ=${(((cChand?.passRate ?? 0) - (aNoPause?.passRate ?? 0)) * 100).toFixed(2)}pp`,
    );

    // --- D. recency split: split data into halves ---
    console.log("\n=== D. RECENCY SPLIT (NO-PAUSE, step=3d) ===");
    const symbols0 = syms(V7);
    const aligned = alignCommon(data, symbols0);
    const totalBars = Math.min(...symbols0.map((s) => aligned[s]?.length ?? 0));
    const midBar = Math.floor(totalBars / 2);
    const noPauseV7 = { ...V7, pauseAtTargetReached: false };
    const dEarly = evaluate(noPauseV7, aligned, 3, 0, midBar);
    const dLate = evaluate(noPauseV7, aligned, 3, midBar);
    console.log(
      `early-half (older 2.85y):  pass=${((dEarly?.passRate ?? 0) * 100).toFixed(2)}% n=${dEarly?.windows}`,
    );
    console.log(
      `late-half  (newer 2.85y):  pass=${((dLate?.passRate ?? 0) * 100).toFixed(2)}% n=${dLate?.windows}`,
    );
    const recencyDelta = (dLate?.passRate ?? 0) - (dEarly?.passRate ?? 0);
    console.log(
      `recency Δ: ${(recencyDelta * 100).toFixed(2)}pp ${recencyDelta > 0.1 ? "⚠️ recency-bias" : "✓"}`,
    );

    // --- E. yearly slices ---
    console.log("\n=== E. YEARLY SLICES (NO-PAUSE, step=3d) ===");
    const barsPerYear = 365 * 24;
    const numYears = Math.floor(totalBars / barsPerYear);
    for (let y = 0; y < numYears; y++) {
      const startBar = y * barsPerYear;
      const endBar = Math.min((y + 1) * barsPerYear, totalBars);
      const r = evaluate(noPauseV7, aligned, 3, startBar, endBar);
      if (r && r.windows > 0) {
        const startDate = new Date(aligned[symbols0[0]][startBar].openTime)
          .toISOString()
          .slice(0, 7);
        console.log(
          `year ${y + 1} (${startDate}): pass=${(r.passRate * 100).toFixed(2)}% n=${r.windows} TL=${(r.tlPct * 100).toFixed(1)}% DL=${(r.dlPct * 100).toFixed(1)}%`,
        );
      }
    }

    // --- F. block-bootstrap CI ---
    console.log(
      "\n=== F. BLOCK-BOOTSTRAP CI (NO-PAUSE, step=1d, 200 resamples) ===",
    );
    const winBars = V7.maxDays * BARS_PER_DAY_1H;
    const allWindows: Array<{ start: number; passed: boolean }> = [];
    for (
      let start = 0;
      start + winBars <= totalBars;
      start += BARS_PER_DAY_1H
    ) {
      const slice: Record<string, Candle[]> = {};
      for (const s of symbols0)
        slice[s] = aligned[s].slice(start, start + winBars);
      const res = runFtmoDaytrade24h(slice, noPauseV7);
      allWindows.push({ start, passed: res.passed });
    }
    console.log(`total windows: ${allWindows.length}`);
    // block bootstrap with block size = 30 windows (~1 month)
    const blockSize = 30;
    const numBlocks = Math.ceil(allWindows.length / blockSize);
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
      let resampled: typeof allWindows = [];
      for (let i = 0; i < numBlocks; i++) {
        const startBlock = Math.floor(r() * (allWindows.length - blockSize));
        resampled = resampled.concat(
          allWindows.slice(startBlock, startBlock + blockSize),
        );
      }
      const passes = resampled.filter((w) => w.passed).length;
      passRates.push(passes / resampled.length);
    }
    passRates.sort((a, b) => a - b);
    const ci95Lo = passRates[Math.floor(passRates.length * 0.025)];
    const ci95Hi = passRates[Math.floor(passRates.length * 0.975)];
    const mean = passRates.reduce((a, b) => a + b, 0) / passRates.length;
    console.log(
      `bootstrap mean: ${(mean * 100).toFixed(2)}% / 95% CI [${(ci95Lo * 100).toFixed(2)}%, ${(ci95Hi * 100).toFixed(2)}%]`,
    );
    const widthPp = (ci95Hi - ci95Lo) * 100;
    console.log(
      `CI width: ${widthPp.toFixed(2)}pp ${widthPp > 10 ? "⚠️ high variance" : "✓"}`,
    );

    expect(true).toBe(true);
  });
});
