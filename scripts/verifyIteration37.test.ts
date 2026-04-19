/**
 * Iter 37: Bootstrap robustness validation of ALL 13 legacy strategies.
 *
 * Same methodology as iter34: 6 chronological cuts at 0.50/0.55/0.60/0.65/0.70/0.75
 * + 4 block-bootstrap resamples (720-bar blocks). Per strategy report median +
 * min Sharpe and % profitable splits.
 *
 * LOCK criteria: median Sharpe ≥ 1.0 AND min Sharpe ≥ 0.0 AND ≥80% profitable.
 *
 * Strategies tested (those that have a runnable backtest function):
 *   1. HoD (Champion proxy) on BTC/ETH/SOL — runHourStrategyWalkForward
 *   2. FundingCarry on BTC/ETH/SOL — runFundingCarryBacktest
 *   3. FundingMinute on BTC/ETH/SOL — runFundingMinuteBacktest
 *   4. LeadLag BTC→ETH and BTC→SOL — runLeadLagBacktest
 *   5. CoinbasePremium-BTC — runPremiumBacktest
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runHourStrategyWalkForward } from "../src/utils/hourOfDayStrategy";
import { runFundingCarryBacktest } from "../src/utils/fundingCarry";
import { runFundingMinuteBacktest } from "../src/utils/fundingMinuteReversion";
import { runLeadLagBacktest } from "../src/utils/leadLagStrategy";
import { runPremiumBacktest } from "../src/utils/premiumBacktest";
import { fetchFundingHistory } from "../src/utils/fundingRate";
import { fetchCoinbaseLongHistory } from "../src/utils/coinbaseHistory";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";
import type { FundingEvent } from "../src/utils/fundingRate";

interface StrategyEval {
  label: string;
  /** Sharpe-style score; if undefined no usable result. */
  sharpe?: number;
  /** Net return % for "% profitable" tally. */
  retPct?: number;
}

interface BootstrapRow {
  label: string;
  sharpes: number[];
  retsPct: number[];
  median: number;
  min: number;
  max: number;
  pctProfitable: number;
  passed: boolean;
}

function chronoSplits(candles: Candle[]): Candle[][] {
  return [0.5, 0.55, 0.6, 0.65, 0.7, 0.75].map((r) =>
    candles.slice(Math.floor(candles.length * r)),
  );
}

function blockBootstrap(
  candles: Candle[],
  blockBars: number,
  n: number,
  seed: number,
): Candle[] {
  const blocks: Candle[][] = [];
  for (let i = 0; i + blockBars <= candles.length; i += blockBars) {
    blocks.push(candles.slice(i, i + blockBars));
  }
  let s = seed;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const used = new Set<number>();
  const want = Math.min(n, blocks.length);
  const out: Candle[] = [];
  while (out.length < want * blockBars) {
    const idx = Math.floor(rand() * blocks.length);
    if (used.has(idx)) continue;
    used.add(idx);
    out.push(...blocks[idx]);
  }
  let t = candles[0]?.openTime ?? 0;
  return out.map((c) => {
    const o = { ...c, openTime: t, closeTime: t + 3_599_999 };
    t += 3_600_000;
    return o;
  });
}

function pct(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * q)];
}

function bootstrapAcrossSlices(
  label: string,
  candles: Candle[],
  evalFn: (slice: Candle[]) => StrategyEval,
): BootstrapRow {
  const slices = chronoSplits(candles);
  for (let i = 0; i < 4; i++) {
    slices.push(blockBootstrap(candles, 720, 6, 1234 + i * 17));
  }
  const sharpes: number[] = [];
  const retsPct: number[] = [];
  for (const s of slices) {
    const r = evalFn(s);
    if (r.sharpe === undefined || !isFinite(r.sharpe)) continue;
    sharpes.push(r.sharpe);
    if (r.retPct !== undefined && isFinite(r.retPct)) retsPct.push(r.retPct);
  }
  if (sharpes.length === 0) {
    return {
      label,
      sharpes: [],
      retsPct: [],
      median: 0,
      min: 0,
      max: 0,
      pctProfitable: 0,
      passed: false,
    };
  }
  const median = pct(sharpes, 0.5);
  const min = Math.min(...sharpes);
  const max = Math.max(...sharpes);
  const profitable =
    retsPct.length > 0
      ? retsPct.filter((r) => r > 0).length / retsPct.length
      : 0;
  const passed = median >= 1.0 && min >= 0.0 && profitable >= 0.8;
  return {
    label,
    sharpes,
    retsPct,
    median,
    min,
    max,
    pctProfitable: profitable,
    passed,
  };
}

function bootstrapFunding(
  label: string,
  funding: FundingEvent[],
  evalFn: (slice: FundingEvent[]) => StrategyEval,
): BootstrapRow {
  // For funding-only strategies (Carry), bootstrap just the funding event series
  const slices: FundingEvent[][] = [];
  for (const r of [0.5, 0.55, 0.6, 0.65, 0.7, 0.75]) {
    slices.push(funding.slice(Math.floor(funding.length * r)));
  }
  // 4 block-bootstrap on 90-event blocks (~30 days at 8h cadence)
  for (let i = 0; i < 4; i++) {
    const blockSize = 90;
    const blocks: FundingEvent[][] = [];
    for (let j = 0; j + blockSize <= funding.length; j += blockSize)
      blocks.push(funding.slice(j, j + blockSize));
    let s = 1234 + i * 17;
    const rand = () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const used = new Set<number>();
    const want = Math.min(6, blocks.length);
    const sample: FundingEvent[] = [];
    while (sample.length < want * blockSize) {
      const idx = Math.floor(rand() * blocks.length);
      if (used.has(idx)) continue;
      used.add(idx);
      sample.push(...blocks[idx]);
    }
    // re-stamp time for sequential
    let t = funding[0]?.fundingTime ?? 0;
    slices.push(
      sample.map((e) => {
        const o = { ...e, fundingTime: t };
        t += 8 * 3600 * 1000;
        return o;
      }),
    );
  }
  const sharpes: number[] = [];
  const retsPct: number[] = [];
  for (const s of slices) {
    const r = evalFn(s);
    if (r.sharpe === undefined || !isFinite(r.sharpe)) continue;
    sharpes.push(r.sharpe);
    if (r.retPct !== undefined && isFinite(r.retPct)) retsPct.push(r.retPct);
  }
  if (sharpes.length === 0) {
    return {
      label,
      sharpes: [],
      retsPct: [],
      median: 0,
      min: 0,
      max: 0,
      pctProfitable: 0,
      passed: false,
    };
  }
  const median = pct(sharpes, 0.5);
  const min = Math.min(...sharpes);
  const max = Math.max(...sharpes);
  const profitable =
    retsPct.length > 0
      ? retsPct.filter((r) => r > 0).length / retsPct.length
      : 0;
  const passed = median >= 1.0 && min >= 0.0 && profitable >= 0.8;
  return {
    label,
    sharpes,
    retsPct,
    median,
    min,
    max,
    pctProfitable: profitable,
    passed,
  };
}

describe("iteration 37 — bootstrap legacy 13 strategies", () => {
  it(
    "All legacy strategies under iter34 lock criteria",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 37: LEGACY-STRATEGY BOOTSTRAP ===");

      // Pre-fetch candles
      const data: Record<string, Candle[]> = {};
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        console.log(`Fetching ${sym} 1h (~10000)...`);
        data[sym] = await loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 10000,
        });
        console.log(`  ${sym}: ${data[sym].length}`);
      }

      // Pre-fetch funding (~3000 events ≈ 1000 days at 3/day)
      const funding: Record<string, FundingEvent[]> = {};
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        console.log(`Fetching funding ${sym}...`);
        funding[sym] = await fetchFundingHistory(sym, 3000);
        console.log(`  funding ${sym}: ${funding[sym].length}`);
      }

      const rows: BootstrapRow[] = [];

      // 1. HoD (Champion proxy: long-only, top-3 hours, SMA filter approximated by walk-forward)
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        const r = bootstrapAcrossSlices(`HoD ${sym}`, data[sym], (slice) => {
          if (slice.length < 1000) return {} as StrategyEval;
          const rep = runHourStrategyWalkForward(slice, 0.5, {
            longTopK: 3,
            shortBottomK: 0,
            requireSignificance: false,
            costs: MAKER_COSTS,
          });
          return {
            label: `HoD ${sym}`,
            sharpe: rep.sharpe,
            retPct: rep.netReturnPct * 100,
          };
        });
        rows.push(r);
      }

      // 2. FundingCarry on BTC/ETH/SOL
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        const r = bootstrapFunding(`Carry ${sym}`, funding[sym], (slice) => {
          if (slice.length < 100) return {} as StrategyEval;
          const rep = runFundingCarryBacktest(sym, slice);
          // Approximate Sharpe from equity curve (per 8h period)
          const eq = rep.equityCurve;
          const rets: number[] = [];
          for (let i = 1; i < eq.length; i++) {
            if (eq[i - 1] > 0) rets.push((eq[i] - eq[i - 1]) / eq[i - 1]);
          }
          if (rets.length < 20) return {} as StrategyEval;
          const m = rets.reduce((s, v) => s + v, 0) / rets.length;
          const v =
            rets.reduce((s, x) => s + (x - m) * (x - m), 0) / rets.length;
          const sd = Math.sqrt(v);
          const periodsPerYear = 365 * 3; // 3 funding events / day
          const sharpe = sd > 0 ? (m / sd) * Math.sqrt(periodsPerYear) : 0;
          return {
            label: `Carry ${sym}`,
            sharpe,
            retPct: rep.netCarryPct * 100,
          };
        });
        rows.push(r);
      }

      // 3. FundingMinute on BTC/ETH/SOL
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        const r = bootstrapAcrossSlices(
          `FundingMin ${sym}`,
          data[sym],
          (slice) => {
            if (slice.length < 500) return {} as StrategyEval;
            // Match funding events that overlap this slice's time range
            const tMin = slice[0].openTime;
            const tMax = slice[slice.length - 1].closeTime;
            const fSlice = funding[sym].filter(
              (e) => e.fundingTime >= tMin && e.fundingTime <= tMax,
            );
            if (fSlice.length < 10) return {} as StrategyEval;
            const rep = runFundingMinuteBacktest(slice, fSlice, {
              minFundingAbs: 0.0005,
              entryBarsBefore: 1,
              exitBarsAfter: 1,
              stopPct: 0.01,
              costs: MAKER_COSTS,
            });
            return {
              label: `FundingMin ${sym}`,
              sharpe: rep.sharpe,
              retPct: rep.netReturnPct * 100,
            };
          },
        );
        rows.push(r);
      }

      // 4. LeadLag BTC→ETH and BTC→SOL
      for (const altSym of ["ETHUSDT", "SOLUSDT"]) {
        const r = bootstrapAcrossSlices(
          `LeadLag BTC→${altSym}`,
          data["BTCUSDT"],
          (btcSlice) => {
            if (btcSlice.length < 500) return {} as StrategyEval;
            const tMin = btcSlice[0].openTime;
            const tMax = btcSlice[btcSlice.length - 1].closeTime;
            const altSlice = data[altSym].filter(
              (c) => c.openTime >= tMin && c.openTime <= tMax,
            );
            if (altSlice.length < 100) return {} as StrategyEval;
            const rep = runLeadLagBacktest(btcSlice, altSlice, altSym, {
              btcThresholdPct: 0.015,
              altMaxMovePct: 0.005,
              holdBarsMax: 3,
              targetRatioToBtc: 0.7,
              stopPctBtcReversal: 0.008,
              costs: MAKER_COSTS,
            });
            return {
              label: `LeadLag BTC→${altSym}`,
              sharpe: rep.sharpe,
              retPct: rep.netReturnPct * 100,
            };
          },
        );
        rows.push(r);
      }

      // 5. CoinbasePremium-BTC
      {
        console.log("Fetching Coinbase BTC-USD 1h history...");
        const cb = await fetchCoinbaseLongHistory("BTC-USD", 3600, 5000);
        console.log(`  Coinbase candles: ${cb.length}`);
        if (cb.length >= 1000) {
          const r = bootstrapAcrossSlices(
            "CoinbasePremium-BTC",
            cb,
            (cbSlice) => {
              if (cbSlice.length < 500) return {} as StrategyEval;
              const tMin = cbSlice[0].openTime;
              const tMax = cbSlice[cbSlice.length - 1].closeTime;
              const bnbSlice = data["BTCUSDT"].filter(
                (c) => c.openTime >= tMin && c.openTime <= tMax,
              );
              if (bnbSlice.length < 100) return {} as StrategyEval;
              const rep = runPremiumBacktest(cbSlice, bnbSlice, {
                minPremiumPct: 0.0015,
                consecutiveBars: 2,
                holdBars: 24,
                stopPct: 0.015,
                longOnly: false,
                costs: MAKER_COSTS,
              });
              return {
                label: "CoinbasePremium-BTC",
                sharpe: rep.sharpe,
                retPct: rep.netReturnPct * 100,
              };
            },
          );
          rows.push(r);
        } else {
          console.log("  Skipping CoinbasePremium (rate-limited).");
        }
      }

      console.log(
        "\n=== RESULTS ===\n" +
          "label".padEnd(28) +
          "n".padStart(4) +
          "min".padStart(8) +
          "med".padStart(8) +
          "max".padStart(8) +
          "%prof".padStart(8) +
          "  verdict",
      );
      for (const r of rows.sort((a, b) => b.median - a.median)) {
        console.log(
          r.label.padEnd(28) +
            String(r.sharpes.length).padStart(4) +
            r.min.toFixed(2).padStart(8) +
            r.median.toFixed(2).padStart(8) +
            r.max.toFixed(2).padStart(8) +
            (r.pctProfitable * 100).toFixed(0).padStart(7) +
            "%" +
            (r.passed ? "  ★ KEEP" : "  ✗ DROP"),
        );
      }
      const winners = rows.filter((r) => r.passed);
      console.log(
        `\n★ Survived bootstrap: ${winners.length} of ${rows.length}`,
      );
      for (const w of winners) console.log(`  - ${w.label}`);
    },
  );
});
