/**
 * V5 Asset Expansion — test 12 additional FTMO-deployable cryptos against V5
 * baseline (9 assets) and find which ones improve pass-rate.
 *
 * Setup: V5 (ETH, BTC, BNB, ADA, DOGE, AVAX, LTC, BCH, LINK) is current
 * production. FTMO MT5 has 22 crypto symbols total — these 12 candidates
 * are the remaining symbols available on FTMO that V5 does NOT trade yet.
 *
 * Methodology (matches Marathon5 + R47 conventions):
 *   - 2h timeframe, targetCount 30000, maxPages 40
 *   - Min-aligned window across all loaded assets
 *   - Walk-forward: 30d window / 3d step
 *   - V5 asset config pattern: costBp 30, slipBp 8, swap 4, riskFrac 1.0,
 *     triggerBars 1, invertDirection true, disableShort true,
 *     stopPct 0.05, tpPct 0.07, holdBars 240
 *   - Live caps: maxStopPct 0.05, maxRiskFrac 0.4
 *
 * Pipeline:
 *   1. Baseline (V5 9 assets)
 *   2. Per-Asset add (Baseline + 1 of 12 = 12 trials)
 *   3. Top-3 combo (3 best ADD candidates together)
 *   4. Top-5/6 combo (5 or 6 best ADD candidates together)
 *
 * Each test reports: ΔPassRate, ΔTL, Δmedian, recommendation ADD/SKIP/NEUTRAL.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runWalkForward,
  fmt,
  LIVE_CAPS,
  type BatchResult,
} from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const TF_HOURS = 2;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_ASSET_EXP_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const V5_SYMS = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];

// 12 candidates from FTMO MT5 list (Binance spot equivalents)
const CANDIDATES = [
  "XRPUSDT", // Ripple
  "DOTUSDT", // Polkadot
  "DASHUSDT", // Dash
  "ETCUSDT", // Ethereum Classic
  "XMRUSDT", // Monero
  "XLMUSDT", // Stellar
  "UNIUSDT", // Uniswap
  "AAVEUSDT", // Aave
  "ALGOUSDT", // Algorand
  "ATOMUSDT", // Cosmos
  "ICPUSDT", // Internet Computer
  "VETUSDT", // VeChain
];

function trendAsset(s: string): Daytrade24hAssetCfg {
  return {
    symbol: `${s.replace("USDT", "")}-TREND`,
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: true,
    stopPct: 0.05,
    tpPct: 0.07,
    holdBars: 240,
  };
}

interface AssetEval {
  symbol: string;
  available: boolean;
  bars: number;
  result: BatchResult | null;
  dPass: number;
  dTL: number;
  dMed: number;
  recommendation: "ADD" | "SKIP" | "NEUTRAL" | "N/A";
}

describe(
  "V5 Asset Expansion — 12 new cryptos vs V5 baseline",
  { timeout: 24 * 3600_000 },
  () => {
    it("evaluates per-asset adds + top combos", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `V5_ASSET_EXP START ${new Date().toISOString()}\n`,
      );

      // ------------------------------------------------------------------
      // 1. Load all assets (V5 base + 12 candidates). Skip un-loadable ones.
      // ------------------------------------------------------------------
      log(
        `\n--- Loading ${V5_SYMS.length} V5 base + ${CANDIDATES.length} candidate symbols ---`,
      );
      const data: Record<string, Candle[]> = {};
      const availableCandidates: string[] = [];
      const skipped: string[] = [];

      for (const s of V5_SYMS) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "2h",
            targetCount: 30000,
            maxPages: 40,
          });
          log(`  base ${s}: ${data[s].length} bars`);
        } catch (e) {
          log(
            `  ERROR base ${s}: ${(e as Error).message} — aborting (V5 base must load)`,
          );
          throw e;
        }
      }
      for (const s of CANDIDATES) {
        try {
          const c = await loadBinanceHistory({
            symbol: s,
            timeframe: "2h",
            targetCount: 30000,
            maxPages: 40,
          });
          if (c.length < 1000) {
            log(`  skip ${s}: only ${c.length} bars (<1000)`);
            skipped.push(s);
            continue;
          }
          data[s] = c;
          availableCandidates.push(s);
          log(`  cand ${s}: ${c.length} bars`);
        } catch (e) {
          log(`  skip ${s}: ${(e as Error).message}`);
          skipped.push(s);
        }
      }

      // Align to min-length across the BASE assets only (so candidates that
      // start later don't shrink the base window).
      const baseMin = Math.min(...V5_SYMS.map((s) => data[s].length));
      log(
        `\nBase-asset min window: ${baseMin} bars (~${(baseMin / 12 / 365).toFixed(2)}y at 2h)`,
      );
      for (const s of V5_SYMS) data[s] = data[s].slice(-baseMin);

      // ------------------------------------------------------------------
      // 2. Baseline: V5 with 9 assets
      // ------------------------------------------------------------------
      log(`\n========== BASELINE: V5 (9 assets) ==========`);
      const baseCfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        liveCaps: LIVE_CAPS,
      };
      const baseData: Record<string, Candle[]> = {};
      for (const s of V5_SYMS) baseData[s] = data[s];
      const baseR = runWalkForward(baseData, baseCfg, TF_HOURS);
      log(fmt("V5 BASELINE", baseR));

      // ------------------------------------------------------------------
      // 3. Per-Asset evaluation: Baseline + 1 candidate (12 tests)
      // ------------------------------------------------------------------
      log(`\n========== PER-ASSET ADD TESTS ==========`);
      const evals: AssetEval[] = [];

      for (const sym of CANDIDATES) {
        if (!availableCandidates.includes(sym)) {
          log(`  ${sym}: SKIPPED (not available)`);
          evals.push({
            symbol: sym,
            available: false,
            bars: 0,
            result: null,
            dPass: 0,
            dTL: 0,
            dMed: 0,
            recommendation: "N/A",
          });
          continue;
        }

        // Re-align: the new candidate may have fewer bars than baseMin.
        // Use the min between baseMin and the candidate's length.
        const candLen = data[sym].length;
        const winLen = Math.min(baseMin, candLen);
        const trialData: Record<string, Candle[]> = {};
        for (const s of V5_SYMS) trialData[s] = data[s].slice(-winLen);
        trialData[sym] = data[sym].slice(-winLen);

        // If the candidate truncates significantly, the BASELINE for comparison
        // must also be on the same window (otherwise unfair comparison). Recompute.
        let cmpBase = baseR;
        if (winLen < baseMin) {
          const baseTrunc: Record<string, Candle[]> = {};
          for (const s of V5_SYMS) baseTrunc[s] = data[s].slice(-winLen);
          cmpBase = runWalkForward(baseTrunc, baseCfg, TF_HOURS);
        }

        const trialCfg: FtmoDaytrade24hConfig = {
          ...baseCfg,
          assets: [...baseCfg.assets, trendAsset(sym)],
        };
        const r = runWalkForward(trialData, trialCfg, TF_HOURS);

        const dPass = r.passRate - cmpBase.passRate;
        const dTL = r.tlBreaches - cmpBase.tlBreaches;
        const dMed = r.medianDays - cmpBase.medianDays;

        // Recommendation:
        //  ADD     if dPass >= +0.5pp AND dTL <= +3
        //  SKIP    if dPass < -0.3pp OR dTL > +5
        //  NEUTRAL otherwise
        let rec: "ADD" | "SKIP" | "NEUTRAL";
        if (dPass >= 0.005 && dTL <= 3) rec = "ADD";
        else if (dPass < -0.003 || dTL > 5) rec = "SKIP";
        else rec = "NEUTRAL";

        log(
          fmt(`  +${sym}`, r) +
            `  Δpass=${dPass * 100 >= 0 ? "+" : ""}${(dPass * 100).toFixed(2)}pp ΔTL=${dTL >= 0 ? "+" : ""}${dTL} Δmed=${dMed >= 0 ? "+" : ""}${dMed}d  ${rec}` +
            (winLen < baseMin ? `  (truncated to ${winLen} bars)` : ""),
        );

        evals.push({
          symbol: sym,
          available: true,
          bars: candLen,
          result: r,
          dPass,
          dTL,
          dMed,
          recommendation: rec,
        });
      }

      // ------------------------------------------------------------------
      // 4. Tabular summary
      // ------------------------------------------------------------------
      log(`\n========== PER-ASSET TABLE ==========`);
      log(`Symbol     | ΔPass     | ΔTL  | Δmed | Status  | Bars`);
      log(`-----------+-----------+------+------+---------+------`);
      for (const e of evals) {
        const sym = e.symbol.padEnd(10);
        if (!e.available) {
          log(`${sym}|   N/A     |  N/A |  N/A | N/A     | -`);
          continue;
        }
        const dp =
          (e.dPass * 100 >= 0 ? "+" : "") + (e.dPass * 100).toFixed(2) + "pp";
        const dtl = (e.dTL >= 0 ? "+" : "") + e.dTL;
        const dmed = (e.dMed >= 0 ? "+" : "") + e.dMed + "d";
        log(
          `${sym}| ${dp.padStart(9)} | ${dtl.padStart(4)} | ${dmed.padStart(4)} | ${e.recommendation.padEnd(7)} | ${e.bars}`,
        );
      }

      // ------------------------------------------------------------------
      // 5. Top-3 combo: take the 3 highest dPass adds, run them together
      // ------------------------------------------------------------------
      const ranked = evals
        .filter((e) => e.available && e.recommendation !== "SKIP")
        .sort((a, b) => b.dPass - a.dPass);
      const adders = ranked.filter((e) => e.recommendation === "ADD");

      log(`\n========== COMBO TESTS ==========`);
      log(
        `Single-add ADD candidates (sorted by ΔPass): ${adders.map((e) => `${e.symbol}(+${(e.dPass * 100).toFixed(2)}pp)`).join(", ") || "none"}`,
      );
      log(
        `Top-N ranked (incl. NEUTRAL, sorted ΔPass): ${ranked
          .slice(0, 8)
          .map(
            (e) =>
              `${e.symbol}(${e.dPass * 100 >= 0 ? "+" : ""}${(e.dPass * 100).toFixed(2)}pp)`,
          )
          .join(", ")}`,
      );

      // For the combos, the truncation is determined by the SHORTEST candidate
      // included.
      function comboRun(label: string, syms: string[]) {
        if (syms.length === 0) {
          log(`  ${label}: no candidates`);
          return;
        }
        const minLen = Math.min(baseMin, ...syms.map((s) => data[s].length));
        const td: Record<string, Candle[]> = {};
        for (const s of V5_SYMS) td[s] = data[s].slice(-minLen);
        for (const s of syms) td[s] = data[s].slice(-minLen);

        const baseTrunc: Record<string, Candle[]> = {};
        for (const s of V5_SYMS) baseTrunc[s] = data[s].slice(-minLen);
        const bRef = runWalkForward(baseTrunc, baseCfg, TF_HOURS);

        const cfg: FtmoDaytrade24hConfig = {
          ...baseCfg,
          assets: [...baseCfg.assets, ...syms.map(trendAsset)],
        };
        const r = runWalkForward(td, cfg, TF_HOURS);
        const dPass = r.passRate - bRef.passRate;
        const dTL = r.tlBreaches - bRef.tlBreaches;
        log(`  ${label}: +[${syms.join(", ")}] (winLen=${minLen})`);
        log(
          `    base-on-window: ${(bRef.passRate * 100).toFixed(2)}% TL=${bRef.tlBreaches}`,
        );
        log(
          fmt(`    combo`, r) +
            `  Δpass=${dPass * 100 >= 0 ? "+" : ""}${(dPass * 100).toFixed(2)}pp ΔTL=${dTL >= 0 ? "+" : ""}${dTL}`,
        );
        return { result: r, dPass, dTL, baseRef: bRef, syms };
      }

      // Always test top-3 of `ranked` (best ΔPass — even if mixed ADD/NEUTRAL).
      const top3 = ranked.slice(0, 3).map((e) => e.symbol);
      const top5 = ranked.slice(0, 5).map((e) => e.symbol);
      const top6 = ranked.slice(0, 6).map((e) => e.symbol);
      const onlyAdders = adders.map((e) => e.symbol);

      log(`\n--- Top-3 by ΔPass ---`);
      const r3 = comboRun("Top-3", top3);

      log(`\n--- Top-5 by ΔPass ---`);
      const r5 = comboRun("Top-5", top5);

      log(`\n--- Top-6 by ΔPass ---`);
      const r6 = comboRun("Top-6", top6);

      if (onlyAdders.length > 0 && onlyAdders.length !== top3.length) {
        log(`\n--- ADD-only (${onlyAdders.length}) ---`);
        comboRun("ADD-only", onlyAdders);
      }

      // ------------------------------------------------------------------
      // 6. Final recommendation
      // ------------------------------------------------------------------
      log(`\n========== FINAL RECOMMENDATION ==========`);
      log(`Skipped/unavailable: ${skipped.join(", ") || "none"}`);
      log(
        `V5 baseline:         ${(baseR.passRate * 100).toFixed(2)}% / med ${baseR.medianDays}d / TL ${baseR.tlBreaches}`,
      );

      const candidates: Array<{
        label: string;
        r: BatchResult;
        dPass: number;
        syms: string[];
      }> = [];
      if (r3)
        candidates.push({
          label: "Top-3",
          r: r3.result,
          dPass: r3.dPass,
          syms: r3.syms,
        });
      if (r5)
        candidates.push({
          label: "Top-5",
          r: r5.result,
          dPass: r5.dPass,
          syms: r5.syms,
        });
      if (r6)
        candidates.push({
          label: "Top-6",
          r: r6.result,
          dPass: r6.dPass,
          syms: r6.syms,
        });

      if (candidates.length === 0) {
        log(`No combo passed — sticking with V5 (9 assets).`);
      } else {
        candidates.sort((a, b) => b.dPass - a.dPass);
        const winner = candidates[0];
        log(
          `\nBest combo:    ${winner.label} (+${(winner.dPass * 100).toFixed(2)}pp)`,
        );
        log(`Adds:          ${winner.syms.join(", ")}`);
        log(
          `Pass-rate:     ${(winner.r.passRate * 100).toFixed(2)}% (med ${winner.r.medianDays}d / TL ${winner.r.tlBreaches})`,
        );

        if (winner.dPass >= 0.005) {
          log(
            `\nRECOMMENDATION: ADD ${winner.syms.join(" + ")} → V5_EXTENDED config.`,
          );
        } else if (winner.dPass >= 0) {
          log(
            `\nRECOMMENDATION: NEUTRAL — gain too small (<0.5pp). Keep V5 (9 assets).`,
          );
        } else {
          log(
            `\nRECOMMENDATION: SKIP — combo regresses vs baseline. Keep V5 (9 assets).`,
          );
        }
      }

      // Persist a JSON snapshot
      writeFileSync(
        `${LOG_DIR}/V5_ASSET_EXP_RESULT.json`,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            baseline: baseR,
            perAsset: evals,
            combos: candidates,
            skipped,
          },
          null,
          2,
        ),
      );

      log(`\nDone — log: ${LOG_FILE}`);
      expect(baseR.windows).toBeGreaterThan(50);
    });
  },
);
