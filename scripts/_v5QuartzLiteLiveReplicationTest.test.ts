/**
 * V5_QUARTZ_LITE Live Replication Test — does live execution match the backtest?
 *
 * Motivation (R12 audit, 2026-04-29):
 *   Backtest engine (ftmoDaytrade24h.runFtmoDaytrade24h) and live detector
 *   (ftmoLiveSignalV231.detectLiveSignalsV231) historically diverged on:
 *     1. entryPrice  — live uses last.close, backtest uses eb.open (0.1-0.5% drift)
 *     2. LSC threshold — different state book-keeping after stops
 *     3. chandelier ATR — backtest rolling vs live snapshot at signal time
 *     4. 8 features missing in live: volTargeting, drawdownShield,
 *        peakDDThrottle, correlationFilter, momentumRanking,
 *        fundingRateFilter, volumeFilter, choppinessFilter, reEntryAfterStop
 *
 *   The QUARTZ_LITE family does NOT use most of those eight, but it DOES use
 *   atrStop / chandelierExit / breakEven / htfTrendFilter — the most-likely
 *   sources of drift for V5-family live deployment.
 *
 * What we measure:
 *   For each "decision point" (every closed 30m bar in the analysis window):
 *     - Slice candles[0..i] → call detectLiveSignalsV231 (filter to LITE assets)
 *     - On the SAME data, did the backtest engine open a trade with
 *       entryTime == candles[i+1].openTime (the bar AFTER the slice end)?
 *
 *   Then we cross-tabulate:
 *     bothEntered   — live emitted a signal AND backtest opened a trade
 *     liveOnly      — live emitted, backtest did NOT (false-positive in live)
 *     backtestOnly  — backtest opened, live did NOT (false-negative in live)
 *     bothQuiet     — neither emitted
 *
 *   Plus per-asset entry-price drift (live entryPrice vs backtest entryPrice)
 *   and stopPct drift.
 *
 * Output:
 *   Decision-match rate (% of bars where live agrees with backtest), the
 *   confusion matrix, top-K drift assets, and a verdict line.
 *
 * Run:
 *   FTMO_TF=2h-trend-v5-quartz \
 *   node ./node_modules/vitest/vitest.mjs run \
 *     --config vitest.scripts.config.ts \
 *     scripts/_v5QuartzLiteLiveReplicationTest.test.ts
 *
 * NOTE: live signal CFG is selected at module-import time via process.env.FTMO_TF.
 * QUARTZ_LITE has no dedicated env mapping, so we use 2h-trend-v5-quartz (parent)
 * and FILTER live signals to the 9 LITE assets in post-processing. Live and
 * backtest see identical engine semantics — only the asset-universe differs by
 * a fixed 6-asset set (INJ, SAND, ARB, RUNE, AVAX, DOGE) which we ignore.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import type {
  AccountState,
  LiveSignal,
  DetectionResult,
} from "../src/utils/ftmoLiveSignalV231";

const TF = "30m" as const;
const BARS_PER_DAY = 48;
const WARMUP_BARS = 250; // > max(htfTrendFilter.lookback, atrStop.period, chandelier.period)
const ANALYSIS_BARS = 1500; // ~31 days of 30m bars per pass; plenty of decision points

let originalTF: string | undefined;

/** Map a LITE asset config to the Binance symbol used both by live + backtest. */
function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}

/** Common-timestamp alignment so both engines see identical bars. */
function alignCommon(
  data: Record<string, Candle[]>,
  symbols: string[],
): Record<string, Candle[]> {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}

interface LiveDecision {
  /** openTime of the closing bar at the slice end (i.e. the signal bar). */
  signalBarOpenTime: number;
  /** openTime of the NEXT bar — what backtest's entryTime would equal. */
  expectedEntryTime: number;
  signals: LiveSignal[]; // post-filter to LITE assets
  skippedAssets: string[];
}

interface BacktestEntry {
  entryTime: number;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  trade: Daytrade24hTrade;
}

/**
 * Sweep one decision point per bar in [start, end). For each i, build a slice
 * containing candles[0..=i] (inclusive of i, simulating "we just closed bar i"),
 * call live detector, and record what live would emit.
 *
 * Returns one LiveDecision per signal bar.
 */
async function collectLiveDecisions(
  aligned: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  start: number,
  end: number,
  liteAssetSymbols: Set<string>,
): Promise<LiveDecision[]> {
  // Dynamic import after FTMO_TF env is set — module-level CFG resolves now.
  const live = await import("../src/utils/ftmoLiveSignalV231");
  const out: LiveDecision[] = [];

  const ethKey = "ETHUSDT";
  const btcKey = "BTCUSDT";
  // QUARTZ_LITE has no SOL — pass an empty placeholder to satisfy the API.
  // If SOL data exists in `aligned` use it; else synthesize zero-volume candles
  // at the same timestamps so detector's empty-array guard does not short-circuit.
  const solKey = "SOLUSDT";
  const hasSol = !!aligned[solKey];

  for (let i = start; i < end; i++) {
    const sliceETH = aligned[ethKey].slice(0, i + 1);
    const sliceBTC = aligned[btcKey].slice(0, i + 1);
    const sliceSOL = hasSol
      ? aligned[solKey].slice(0, i + 1)
      : sliceETH.slice(0, 3); // dummy stub — detector only needs >=3 bars
    const extra: Record<string, Candle[]> = {};
    for (const sym of Object.keys(aligned)) {
      if (sym === ethKey || sym === btcKey || sym === solKey) continue;
      extra[sym] = aligned[sym].slice(0, i + 1);
    }
    // Account state — kept neutral so sizing/Kelly/timeBoost don't skew the
    // *signal* decision. We compare WHAT bars trigger, not the size.
    const account: AccountState = {
      equity: 1.0,
      day: 0,
      recentPnls: [],
      equityAtDayStart: 1.0,
    };
    const result: DetectionResult = live.detectLiveSignalsV231(
      sliceETH,
      sliceBTC,
      sliceSOL,
      account,
      [],
      extra,
    );
    // Filter live signals to LITE assets only (we want apples-to-apples).
    const liteSignals = result.signals.filter((s) =>
      liteAssetSymbols.has(s.assetSymbol),
    );
    const sigBar = aligned[ethKey][i];
    const nextBar = aligned[ethKey][i + 1];
    out.push({
      signalBarOpenTime: sigBar.openTime,
      expectedEntryTime: nextBar?.openTime ?? sigBar.openTime + 30 * 60_000,
      signals: liteSignals,
      skippedAssets: result.skipped
        .map((s) => s.asset)
        .filter((a) => liteAssetSymbols.has(a)),
    });
  }
  return out;
}

describe(
  "V5_QUARTZ_LITE Live ↔ Backtest Replication",
  { timeout: 60 * 60_000 },
  () => {
    beforeAll(() => {
      originalTF = process.env.FTMO_TF;
      // QUARTZ has no dedicated lite mapping in live signal; use the parent.
      // Live emits for all 15 QUARTZ assets — we filter to the 9 LITE assets
      // in post-processing.
      process.env.FTMO_TF = "2h-trend-v5-quartz";
    });
    afterAll(() => {
      if (originalTF === undefined) delete process.env.FTMO_TF;
      else process.env.FTMO_TF = originalTF;
    });

    it("decision-by-decision diff: live-vs-backtest on identical 30m candles", async () => {
      const CFG = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;
      const liteAssetSymbols = new Set(CFG.assets.map((a) => a.symbol));
      const symbols = syms(CFG);
      console.log(
        `\nLITE config assets (${liteAssetSymbols.size}): ${[...liteAssetSymbols].join(", ")}`,
      );
      console.log(`Loading ${symbols.length} symbols (${TF})...`);

      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: TF,
            targetCount: ANALYSIS_BARS + WARMUP_BARS + 100,
            maxPages: 30,
          });
          data[s] = r.filter((c) => c.isFinal);
          console.log(
            `  ${s}: ${data[s].length} bars (${new Date(data[s][0].openTime).toISOString().slice(0, 10)} → ${new Date(data[s][data[s].length - 1].openTime).toISOString().slice(0, 10)})`,
          );
        } catch (err) {
          console.warn(`  ${s}: load failed — ${(err as Error).message}`);
        }
      }

      const aligned = alignCommon(data, symbols);
      const totalBars = aligned[symbols[0]].length;
      console.log(`\nAligned bars: ${totalBars}`);

      const liveCfg: FtmoDaytrade24hConfig = {
        ...CFG,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      };

      // --- 1. backtest pass: run engine over the full aligned series, record
      //        every executed entry by (asset, entryTime).
      console.log("\n=== STEP 1: BACKTEST RUN (full series) ===");
      const btResult = runFtmoDaytrade24h(aligned, liveCfg);
      console.log(
        `Backtest result: passed=${btResult.passed} reason=${btResult.reason} trades=${btResult.trades.length}`,
      );
      // Index by entryTime → asset symbol for O(1) lookup.
      const backtestEntries = new Map<string, BacktestEntry>();
      for (const t of btResult.trades) {
        const key = `${t.symbol}@${t.entryTime}`;
        backtestEntries.set(key, {
          entryTime: t.entryTime,
          symbol: t.symbol,
          direction: t.direction,
          entryPrice: t.entryPrice,
          trade: t,
        });
      }
      console.log(`Indexed ${backtestEntries.size} backtest entries.`);

      // --- 2. live polling pass: walk bar-by-bar in the analysis window,
      //        slice candles[0..i] each time, call detector, record signals.
      const start = WARMUP_BARS;
      const end = Math.min(start + ANALYSIS_BARS, totalBars - 1);
      console.log(
        `\n=== STEP 2: LIVE POLLING PASS (${end - start} decision bars) ===`,
      );
      console.log(
        `From ${new Date(aligned[symbols[0]][start].openTime).toISOString()} to ${new Date(aligned[symbols[0]][end].openTime).toISOString()}`,
      );
      const liveDecisions = await collectLiveDecisions(
        aligned,
        liveCfg,
        start,
        end,
        liteAssetSymbols,
      );

      // --- 3. cross-tabulate confusion matrix per-asset and overall.
      console.log("\n=== STEP 3: CONFUSION MATRIX ===");
      let bothEntered = 0;
      let liveOnly = 0;
      let backtestOnly = 0;
      let bothQuiet = 0;
      // Mirror back to backtest entries we've matched, so we can find leftovers.
      const matchedBacktestKeys = new Set<string>();

      // Per-asset stats.
      const perAsset = new Map<
        string,
        {
          both: number;
          liveOnly: number;
          btOnly: number;
          quiet: number;
          entryDriftBp: number[]; // (live - bt) / bt × 10000
          stopPctDriftBp: number[]; // live.stopPct - bt-implied stopPct, × 10000
          dirMismatch: number;
        }
      >();
      const stat = (s: string) => {
        if (!perAsset.has(s))
          perAsset.set(s, {
            both: 0,
            liveOnly: 0,
            btOnly: 0,
            quiet: 0,
            entryDriftBp: [],
            stopPctDriftBp: [],
            dirMismatch: 0,
          });
        return perAsset.get(s)!;
      };

      for (const dec of liveDecisions) {
        // For each LITE asset, what does each side say at this bar?
        for (const assetSym of liteAssetSymbols) {
          const liveSig = dec.signals.find((s) => s.assetSymbol === assetSym);
          const btKey = `${assetSym}@${dec.expectedEntryTime}`;
          const btEntry = backtestEntries.get(btKey);
          if (btEntry) matchedBacktestKeys.add(btKey);

          const a = stat(assetSym);
          if (liveSig && btEntry) {
            bothEntered++;
            a.both++;
            // Drift metrics
            const eDrift =
              ((liveSig.entryPrice - btEntry.entryPrice) / btEntry.entryPrice) *
              10000;
            a.entryDriftBp.push(eDrift);
            const btStopPct =
              Math.abs(btEntry.entryPrice - btEntry.trade.exitPrice) /
              btEntry.entryPrice;
            // Backtest exit price isn't directly stopPct, but for stops it
            // approximates. Coarse-only — flag big differences (>50 bp).
            if (btEntry.trade.exitReason === "stop") {
              a.stopPctDriftBp.push((liveSig.stopPct - btStopPct) * 10000);
            }
            if (liveSig.direction !== btEntry.direction) {
              a.dirMismatch++;
            }
          } else if (liveSig && !btEntry) {
            liveOnly++;
            a.liveOnly++;
          } else if (!liveSig && btEntry) {
            backtestOnly++;
            a.btOnly++;
          } else {
            bothQuiet++;
            a.quiet++;
          }
        }
      }

      const totalDecisions = bothEntered + liveOnly + backtestOnly + bothQuiet;
      const matchRate =
        totalDecisions > 0
          ? ((bothEntered + bothQuiet) / totalDecisions) * 100
          : 0;
      const decisionsWithEntry = bothEntered + liveOnly + backtestOnly;
      const entryAgreement =
        decisionsWithEntry > 0 ? (bothEntered / decisionsWithEntry) * 100 : 100;

      console.log(`\n--- OVERALL ---`);
      console.log(`Total decisions: ${totalDecisions}`);
      console.log(
        `bothEntered:   ${bothEntered} (${((bothEntered / totalDecisions) * 100).toFixed(3)}%)`,
      );
      console.log(
        `liveOnly:      ${liveOnly} (${((liveOnly / totalDecisions) * 100).toFixed(3)}%)  ← live false-positives`,
      );
      console.log(
        `backtestOnly:  ${backtestOnly} (${((backtestOnly / totalDecisions) * 100).toFixed(3)}%)  ← live false-negatives`,
      );
      console.log(
        `bothQuiet:     ${bothQuiet} (${((bothQuiet / totalDecisions) * 100).toFixed(3)}%)`,
      );
      console.log(`MATCH RATE: ${matchRate.toFixed(3)}%`);
      console.log(
        `ENTRY-AGREEMENT (only bars where ≥1 side fired): ${entryAgreement.toFixed(2)}%`,
      );

      // --- 4. per-asset breakdown ---
      console.log(`\n--- PER-ASSET ---`);
      console.log(
        `asset            both  liveOnly  btOnly  dirMismatch  meanEntryDrift(bp)  p95EntryDrift(bp)`,
      );
      for (const [sym, a] of [...perAsset.entries()].sort()) {
        a.entryDriftBp.sort((x, y) => x - y);
        const meanDrift =
          a.entryDriftBp.length > 0
            ? a.entryDriftBp.reduce((s, x) => s + x, 0) / a.entryDriftBp.length
            : 0;
        const p95Drift =
          a.entryDriftBp.length > 0
            ? a.entryDriftBp[Math.floor(a.entryDriftBp.length * 0.95)]
            : 0;
        console.log(
          `${sym.padEnd(15)}  ${String(a.both).padStart(4)}  ${String(a.liveOnly).padStart(8)}  ${String(a.btOnly).padStart(6)}  ${String(a.dirMismatch).padStart(11)}  ${meanDrift.toFixed(2).padStart(18)}  ${p95Drift.toFixed(2).padStart(17)}`,
        );
      }

      // --- 5. unmatched backtest entries (entries the live polling NEVER saw)
      console.log(`\n--- UNMATCHED BACKTEST ENTRIES ---`);
      const unmatched: BacktestEntry[] = [];
      for (const [key, e] of backtestEntries) {
        if (!matchedBacktestKeys.has(key)) unmatched.push(e);
      }
      // Filter: only those whose entryTime falls inside our analysis window.
      const winStartTime = aligned[symbols[0]][start + 1].openTime;
      const winEndTime = aligned[symbols[0]][end].openTime;
      const inWindow = unmatched.filter(
        (e) => e.entryTime >= winStartTime && e.entryTime <= winEndTime,
      );
      console.log(
        `Total backtest entries in analysis window NOT seen live: ${inWindow.length}`,
      );
      for (const e of inWindow.slice(0, 10)) {
        console.log(
          `  ${e.symbol} ${e.direction} ${new Date(e.entryTime).toISOString()} entry=$${e.entryPrice.toFixed(4)}`,
        );
      }
      if (inWindow.length > 10)
        console.log(`  ... and ${inWindow.length - 10} more`);

      // --- 6. verdict ---
      console.log(`\n=== VERDICT ===`);
      if (entryAgreement >= 99.0) {
        console.log(
          `✅ LIVE ≈ BACKTEST: ${entryAgreement.toFixed(2)}% entry-agreement — production-ready`,
        );
      } else if (entryAgreement >= 95.0) {
        console.log(
          `⚠️  MINOR DRIFT: ${entryAgreement.toFixed(2)}% — investigate per-asset table`,
        );
      } else {
        console.log(
          `🔴 SIGNIFICANT DRIFT: ${entryAgreement.toFixed(2)}% — DO NOT live-deploy until fixed`,
        );
      }

      // Soft assertion — the test always reports; we never block CI on this
      // because match-rate depends on data + R12 fixes. Adjust target after
      // first run baselines emerge.
      expect(totalDecisions).toBeGreaterThan(0);
    });
  },
);
