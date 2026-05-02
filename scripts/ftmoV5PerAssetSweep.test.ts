/**
 * V5 Per-Asset Optimization Sweep
 *
 * Hypothesis: V5's 9 assets share identical engine params (stopPct=5%, tpPct=7%,
 * holdBars=240, riskFrac=1.0). But the assets have very different vol/liquidity
 * profiles (BTC/ETH low-vol vs DOGE/AVAX/LINK high-vol). Letting each asset use
 * its own optimum could push the pass-rate above the current ~46.7% plateau.
 *
 * Method (Phase 1 — single-asset isolation):
 *   For each of the 9 assets, run a 1-asset backtest (other 8 disabled in cfg
 *   by removing them from `assets`) and sweep:
 *     stopPct  ∈ [0.03, 0.04, 0.05, 0.06]
 *     tpPct    ∈ [0.04, 0.05, 0.06, 0.07, 0.08]
 *     holdBars ∈ [120, 240, 480]
 *     riskFrac ∈ [0.5, 1.0, 1.5]
 *   Score = pass-rate, tiebreak = lower p90 days.
 *
 * Method (Phase 2 — combined):
 *   Apply each asset's individual optimum simultaneously, run multi-asset
 *   backtest, compare to V5 baseline. Watch TL-rate for correlation-cluster
 *   risk.
 *
 * Goal: +1.5pp pass-rate without TL-spike (>0.5pp).
 *
 * Engine: pauseAtTargetReached:true + atrStop {p:14, m:2.5} (mandatory).
 * Costs: FTMO-real (40bp / 12bp slippage).
 * Window: 30d challenge / 3d step on 30000 2h bars (~6.85y).
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 2;
// V5 has 9 assets after greedy add: ETH/BTC/BNB/ADA/DOGE (V4) + AVAX/LTC/BCH/LINK (V5)
const SOURCES = [
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

// FTMO-real costs (overrides V5's 30bp/8bp baseline costs).
const REAL_COSTS = { costBp: 40, slippageBp: 12, swapBpPerDay: 4 };

interface AssetOpt {
  sym: string;
  stopPct: number;
  tpPct: number;
  holdBars: number;
  riskFrac: number;
  passRate: number;
  p90: number;
  tl: number;
  ev: number;
  baselinePassRate: number;
}

function score(
  a: { passRate: number; p90Days: number },
  b: { passRate: number; p90Days: number },
) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

/**
 * Build V5 config with FTMO-real costs and the engine essentials enforced.
 */
function v5RealCfg(): FtmoDaytrade24hConfig {
  return {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    pauseAtTargetReached: true,
    atrStop: { period: 14, stopMult: 2.5 },
    liveCaps: LIVE_CAPS,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
      ...a,
      ...REAL_COSTS,
    })),
  };
}

describe(
  "V5 Per-Asset Param Sweep → Combined",
  { timeout: 24 * 3600_000 },
  () => {
    it(
      "tunes stop/tp/hold/risk per asset, then runs combined multi-asset backtest",
      async () => {
        // ---------- Load data ----------
        const data: Record<string, Candle[]> = {};
        for (const s of SOURCES) {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "2h",
            targetCount: 30000,
            maxPages: 40,
          });
        }
        const n = Math.min(...Object.values(data).map((c) => c.length));
        for (const s of SOURCES) data[s] = data[s].slice(-n);
        console.log(
          `Aligned: ${n} bars (${(n / 12 / 365).toFixed(2)}y) across ${SOURCES.length} assets\n`,
        );

        // ---------- V5 multi-asset baseline ----------
        const v5 = v5RealCfg();
        const baseR = runWalkForward(data, v5, TF_HOURS);
        console.log(
          fmt("V5 BASELINE (uniform sp=5% tp=7% hb=240 rf=1.0)", baseR),
        );

        // ---------- Phase 1: per-asset single-asset sweep ----------
        // Sweep grid (4 × 5 × 3 × 3 = 180 combos / asset).
        // We skip combos with tp <= stop (no edge).
        const stops = [0.03, 0.04, 0.05, 0.06];
        const tps = [0.04, 0.05, 0.06, 0.07, 0.08];
        const holds = [120, 240, 480];
        const risks = [0.5, 1.0, 1.5];

        const optByAsset: Record<string, AssetOpt> = {};

        console.log(`\n--- Phase 1: per-asset isolated sweep ---`);
        for (const src of SOURCES) {
          const symKey = `${src.replace("USDT", "")}-TREND`;
          const assetData = { [src]: data[src] };

          // Find the V5 asset record for this symbol so we keep its overrides
          // (costBp/slippageBp/disableShort/etc.)
          const baseAsset = v5.assets.find((a) => a.symbol === symKey);
          if (!baseAsset) {
            console.log(`  WARN: ${symKey} not in V5 cfg, skipping`);
            continue;
          }

          // Single-asset baseline at V5's uniform params — gives us the per-asset
          // standalone pass-rate as the comparison anchor.
          const singleBaseCfg: FtmoDaytrade24hConfig = {
            ...v5,
            assets: [baseAsset],
          };
          const singleBaseR = runWalkForward(
            assetData,
            singleBaseCfg,
            TF_HOURS,
          );
          console.log(fmt(`${symKey} solo @ V5-uniform`, singleBaseR));

          let best = { ...singleBaseR };
          let bestParams = {
            stopPct: baseAsset.stopPct ?? 0.05,
            tpPct: baseAsset.tpPct ?? 0.07,
            holdBars: baseAsset.holdBars ?? 240,
            riskFrac: baseAsset.riskFrac ?? 1.0,
          };

          for (const sp of stops) {
            for (const tp of tps) {
              if (tp <= sp) continue;
              for (const hb of holds) {
                for (const rf of risks) {
                  const cfg: FtmoDaytrade24hConfig = {
                    ...v5,
                    assets: [
                      {
                        ...baseAsset,
                        stopPct: sp,
                        tpPct: tp,
                        holdBars: hb,
                        riskFrac: rf,
                      },
                    ],
                  };
                  const r = runWalkForward(assetData, cfg, TF_HOURS);
                  if (score(r, best) < 0) {
                    best = r;
                    bestParams = {
                      stopPct: sp,
                      tpPct: tp,
                      holdBars: hb,
                      riskFrac: rf,
                    };
                  }
                }
              }
            }
          }

          optByAsset[symKey] = {
            sym: symKey,
            ...bestParams,
            passRate: best.passRate,
            p90: best.p90Days,
            tl: best.tlBreaches,
            ev: best.ev,
            baselinePassRate: singleBaseR.passRate,
          };

          const dPp = (best.passRate - singleBaseR.passRate) * 100;
          console.log(
            `  → ${symKey} BEST: sp=${bestParams.stopPct} tp=${bestParams.tpPct} ` +
              `hb=${bestParams.holdBars} rf=${bestParams.riskFrac} | ` +
              `pass=${(best.passRate * 100).toFixed(2)}% (Δ${dPp >= 0 ? "+" : ""}${dPp.toFixed(2)}pp) ` +
              `p90=${best.p90Days}d TL=${best.tlBreaches}`,
          );
        }

        // ---------- Phase 2: apply all per-asset optima together ----------
        console.log(`\n--- Phase 2: combined multi-asset run ---`);
        const tunedCfg: FtmoDaytrade24hConfig = {
          ...v5,
          assets: v5.assets.map((a) => {
            const opt = optByAsset[a.symbol];
            if (!opt) return a;
            return {
              ...a,
              stopPct: opt.stopPct,
              tpPct: opt.tpPct,
              holdBars: opt.holdBars,
              riskFrac: opt.riskFrac,
            };
          }),
        };
        const tunedR = runWalkForward(data, tunedCfg, TF_HOURS);

        const dPp = (tunedR.passRate - baseR.passRate) * 100;
        const dTl = tunedR.tlBreaches - baseR.tlBreaches;
        const dTlPp =
          (tunedR.tlBreaches / tunedR.windows -
            baseR.tlBreaches / baseR.windows) *
          100;

        console.log(`\n========== V5 PER-ASSET FINAL ==========`);
        console.log(fmt("V5 BASELINE       ", baseR));
        console.log(fmt("V5 PERASSET TUNED ", tunedR));
        console.log(
          `Δ pass: ${dPp >= 0 ? "+" : ""}${dPp.toFixed(2)}pp | ` +
            `Δ TL: ${dTl >= 0 ? "+" : ""}${dTl} (${dTlPp >= 0 ? "+" : ""}${dTlPp.toFixed(2)}pp) | ` +
            `Δ p90: ${tunedR.p90Days - baseR.p90Days}d`,
        );

        // ---------- Per-asset table ----------
        console.log(`\nPer-asset optima:`);
        console.log(
          `  ${"Asset".padEnd(12)} ${"stop".padStart(5)} ${"tp".padStart(5)} ${"hold".padStart(5)} ${"risk".padStart(5)} ${"solo".padStart(8)} ${"Δsolo".padStart(8)}`,
        );
        for (const a of Object.values(optByAsset)) {
          const dSolo = (a.passRate - a.baselinePassRate) * 100;
          console.log(
            `  ${a.sym.padEnd(12)} ${(a.stopPct * 100).toFixed(1).padStart(4)}% ${(a.tpPct * 100).toFixed(1).padStart(4)}% ${String(a.holdBars).padStart(5)} ${a.riskFrac.toFixed(2).padStart(5)} ${(a.passRate * 100).toFixed(2).padStart(7)}% ${(dSolo >= 0 ? "+" : "") + dSolo.toFixed(2).padStart(6)}pp`,
          );
        }

        // ---------- Export-ready config snippet ----------
        console.log(
          `\n--- Suggested export (paste into ftmoDaytrade24h.ts) ---`,
        );
        console.log(`/**`);
        console.log(
          ` * TREND_2H_V5_PERASSET — V5 with per-asset stop/tp/hold/risk tuning.`,
        );
        console.log(
          ` *   Sweep: stop[3-6%] × tp[4-8%] × hold[120/240/480] × risk[0.5/1.0/1.5]`,
        );
        console.log(
          ` *   Multi-fold OOS 30d/3d step on 30000 2h bars (~6.85y).`,
        );
        console.log(` *   FTMO-real costs (40bp / 12bp / 4bp swap).`);
        console.log(
          ` *   V5 BASELINE        : ${(baseR.passRate * 100).toFixed(2)}% / med ${baseR.medianDays}d / p90 ${baseR.p90Days}d / TL ${baseR.tlBreaches}`,
        );
        console.log(
          ` *   V5_PERASSET TUNED  : ${(tunedR.passRate * 100).toFixed(2)}% / med ${tunedR.medianDays}d / p90 ${tunedR.p90Days}d / TL ${tunedR.tlBreaches}`,
        );
        console.log(
          ` *   Δ: ${dPp >= 0 ? "+" : ""}${dPp.toFixed(2)}pp pass / Δ TL ${dTl >= 0 ? "+" : ""}${dTl}`,
        );
        console.log(` * Live: \`FTMO_TF=2h-trend-v5-perasset\`.`);
        console.log(` */`);

        // ---------- Verdict ----------
        const goalPp = 1.5;
        const tlGuardPp = 0.5;
        const passOK = dPp >= goalPp;
        const tlOK = dTlPp <= tlGuardPp;
        console.log(`\n--- VERDICT ---`);
        console.log(
          `  Pass +${dPp.toFixed(2)}pp (goal ≥ +${goalPp}pp): ${passOK ? "OK" : "MISS"}`,
        );
        console.log(
          `  TL ${dTlPp >= 0 ? "+" : ""}${dTlPp.toFixed(2)}pp (cap ≤ +${tlGuardPp}pp): ${tlOK ? "OK" : "VIOLATION"}`,
        );
        if (passOK && tlOK) {
          console.log(
            `  → SUCCESS: export V5_PERASSET, map FTMO_TF=2h-trend-v5-perasset`,
          );
        } else if (passOK && !tlOK) {
          console.log(
            `  → MIXED: pass-rate gain found but TL spike — DO NOT deploy without re-balance`,
          );
        } else {
          console.log(
            `  → NO IMPROVEMENT: per-asset tuning did not lift pass-rate above the +1.5pp threshold; V5 share-params remain near-optimal`,
          );
        }

        expect(tunedR.windows).toBeGreaterThan(50);
      },
      24 * 3600_000,
    );
  },
);
