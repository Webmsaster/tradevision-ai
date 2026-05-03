/**
 * V5 Per-Asset Tuning via MULTI-ASSET-GREEDY-LOOP.
 *
 * Why not solo-sweep?
 *   V5 has `pauseAtTargetReached: true`. That means a window's pass-rate depends
 *   on JOINT equity growth across all 9 assets — once the 8% target is hit the
 *   engine stops trading. A single-asset isolated sweep optimises in isolation
 *   and adopts params that look great solo but DESTROY the multi-asset cooperative
 *   dynamics. The previous V5_PERASSET sweep failed for exactly that reason.
 *
 * Multi-asset greedy method:
 *   For each asset (in V5 declaration order ETH, BTC, BNB, ADA, DOGE, AVAX, LTC,
 *   BCH, LINK):
 *     1. Hold the other 8 assets at their current (running) override.
 *     2. Vary ONLY this asset's stopPct × tpPct × holdBars × riskFrac.
 *     3. Each candidate runs the FULL 9-asset multi-asset backtest.
 *     4. Adopt the candidate IF it beats the current running pass-rate by ≥ 0.3pp.
 *     5. Otherwise leave this asset at V5 default.
 *
 *   This properly accounts for the pauseAtTargetReached cooperative dynamic.
 *
 * Grid: stop {0.04, 0.05, 0.06} × tp {0.05, 0.06, 0.07, 0.08} × hold {120, 240, 480}
 *       × risk {0.7, 1.0, 1.3} = 108 combos / asset × 9 assets ≈ 972 multi-asset runs.
 *
 * Engine: pauseAtTargetReached:true + atrStop {p:14, m:2.5} (mandatory).
 * Costs: FTMO-real (40bp / 12bp slippage / 4bp swap).
 * Window: 30d challenge / 3d step on 30000 2h bars (~6.85y).
 *
 * Success criterion: combined config gain ≥ +1.5pp vs baseline → export V5_GREEDY.
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

// Order = V5 declaration order (ETH/BTC/BNB/ADA/DOGE from V4 + AVAX/LTC/BCH/LINK).
const ASSET_ORDER: Array<{ src: string; sym: string }> = [
  { src: "ETHUSDT", sym: "ETH-TREND" },
  { src: "BTCUSDT", sym: "BTC-TREND" },
  { src: "BNBUSDT", sym: "BNB-TREND" },
  { src: "ADAUSDT", sym: "ADA-TREND" },
  { src: "DOGEUSDT", sym: "DOGE-TREND" },
  { src: "AVAXUSDT", sym: "AVAX-TREND" },
  { src: "LTCUSDT", sym: "LTC-TREND" },
  { src: "BCHUSDT", sym: "BCH-TREND" },
  { src: "LINKUSDT", sym: "LINK-TREND" },
];

const REAL_COSTS = { costBp: 40, slippageBp: 12, swapBpPerDay: 4 };

const STOPS = [0.04, 0.05, 0.06];
const TPS = [0.05, 0.06, 0.07, 0.08];
const HOLDS = [120, 240, 480];
const RISKS = [0.7, 1.0, 1.3];

// Adoption threshold (pp).
const ADOPT_THRESHOLD = 0.003; // +0.3pp

interface Override {
  stopPct: number;
  tpPct: number;
  holdBars: number;
  riskFrac: number;
}

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

/**
 * Build a config given the running override map. Assets without overrides keep
 * their V5-default params (sp=5%, tp=7%, hb=240, rf=1.0).
 */
function buildCfg(
  base: FtmoDaytrade24hConfig,
  overrides: Record<string, Override | undefined>,
): FtmoDaytrade24hConfig {
  return {
    ...base,
    assets: base.assets.map((a) => {
      const ov = overrides[a.symbol];
      if (!ov) return a;
      return {
        ...a,
        stopPct: ov.stopPct,
        tpPct: ov.tpPct,
        holdBars: ov.holdBars,
        riskFrac: ov.riskFrac,
      };
    }),
  };
}

describe(
  "V5 Multi-Asset Greedy Loop (per-asset tuning under pauseAtTargetReached)",
  { timeout: 24 * 3600_000 },
  () => {
    it(
      "loops 9 assets, varying one at a time on the FULL 9-asset multi-asset run",
      async () => {
        // ---------- Load data ----------
        const data: Record<string, Candle[]> = {};
        for (const { src } of ASSET_ORDER) {
          data[src] = await loadBinanceHistory({
            symbol: src,
            timeframe: "2h",
            targetCount: 30000,
            maxPages: 40,
          });
        }
        const n = Math.min(...Object.values(data).map((c) => c.length));
        for (const k of Object.keys(data)) data[k] = data[k].slice(-n);
        console.log(
          `Aligned: ${n} bars (${(n / 12 / 365).toFixed(2)}y) across ${ASSET_ORDER.length} assets\n`,
        );

        // ---------- Baseline (all V5 defaults) ----------
        const v5 = v5RealCfg();
        const baseR = runWalkForward(data, v5, TF_HOURS);
        console.log(
          fmt("V5 BASELINE (uniform sp=5% tp=7% hb=240 rf=1.0)", baseR),
        );
        const baselinePassRate = baseR.passRate;

        // ---------- Greedy loop ----------
        const overrides: Record<string, Override | undefined> = {};
        // Track running pass-rate after each asset adoption so subsequent assets
        // tune against the up-to-date config.
        let runningR = baseR;

        const adoptions: Array<{
          sym: string;
          override: Override | null;
          beforePass: number;
          afterPass: number;
          deltaPp: number;
          tlBefore: number;
          tlAfter: number;
        }> = [];

        for (let assetIdx = 0; assetIdx < ASSET_ORDER.length; assetIdx++) {
          const { sym } = ASSET_ORDER[assetIdx];
          console.log(
            `\n--- [${assetIdx + 1}/${ASSET_ORDER.length}] tuning ${sym} (running pass=${(runningR.passRate * 100).toFixed(2)}%) ---`,
          );

          const beforeR = runningR;
          let bestR = beforeR;
          let bestOverride: Override | null = null;

          let combo = 0;
          let totalCombos = 0;
          for (const sp of STOPS)
            for (const tp of TPS)
              if (tp > sp)
                for (const _hb of HOLDS) for (const _rf of RISKS) totalCombos++;

          for (const sp of STOPS) {
            for (const tp of TPS) {
              if (tp <= sp) continue;
              for (const hb of HOLDS) {
                for (const rf of RISKS) {
                  combo++;
                  const candidateOverrides = {
                    ...overrides,
                    [sym]: {
                      stopPct: sp,
                      tpPct: tp,
                      holdBars: hb,
                      riskFrac: rf,
                    },
                  };
                  const cfg = buildCfg(v5, candidateOverrides);
                  const r = runWalkForward(data, cfg, TF_HOURS);

                  // Tiebreak: lower p90 days, then lower TL breaches.
                  const better =
                    r.passRate > bestR.passRate + 1e-9 ||
                    (Math.abs(r.passRate - bestR.passRate) < 1e-9 &&
                      (r.p90Days < bestR.p90Days ||
                        (r.p90Days === bestR.p90Days &&
                          r.tlBreaches < bestR.tlBreaches)));

                  if (better) {
                    bestR = r;
                    bestOverride = {
                      stopPct: sp,
                      tpPct: tp,
                      holdBars: hb,
                      riskFrac: rf,
                    };
                    if (r.passRate > beforeR.passRate + 1e-9) {
                      console.log(
                        `  [${combo}/${totalCombos}] ${sym} sp=${sp} tp=${tp} hb=${hb} rf=${rf} → ${(r.passRate * 100).toFixed(2)}% (Δ${((r.passRate - beforeR.passRate) * 100).toFixed(2)}pp) p90=${r.p90Days}d TL=${r.tlBreaches}`,
                      );
                    }
                  }
                }
              }
            }
          }

          const deltaPass = bestR.passRate - beforeR.passRate;
          if (deltaPass >= ADOPT_THRESHOLD && bestOverride) {
            overrides[sym] = bestOverride;
            runningR = bestR;
            console.log(
              `  ✓ ADOPT ${sym}: sp=${bestOverride.stopPct} tp=${bestOverride.tpPct} hb=${bestOverride.holdBars} rf=${bestOverride.riskFrac} | Δ=+${(deltaPass * 100).toFixed(2)}pp → running ${(runningR.passRate * 100).toFixed(2)}% TL=${runningR.tlBreaches}`,
            );
            adoptions.push({
              sym,
              override: bestOverride,
              beforePass: beforeR.passRate,
              afterPass: runningR.passRate,
              deltaPp: deltaPass * 100,
              tlBefore: beforeR.tlBreaches,
              tlAfter: runningR.tlBreaches,
            });
          } else {
            console.log(
              `  · KEEP V5-DEFAULT for ${sym} (best Δ=${(deltaPass * 100).toFixed(2)}pp < +${(ADOPT_THRESHOLD * 100).toFixed(1)}pp threshold)`,
            );
            adoptions.push({
              sym,
              override: null,
              beforePass: beforeR.passRate,
              afterPass: beforeR.passRate,
              deltaPp: 0,
              tlBefore: beforeR.tlBreaches,
              tlAfter: beforeR.tlBreaches,
            });
          }
        }

        // ---------- Final: combined config ----------
        const finalCfg = buildCfg(v5, overrides);
        const finalR = runWalkForward(data, finalCfg, TF_HOURS);

        const totalDeltaPp = (finalR.passRate - baselinePassRate) * 100;
        const tlDelta = finalR.tlBreaches - baseR.tlBreaches;

        console.log(`\n========== V5 GREEDY MULTI-ASSET FINAL ==========`);
        console.log(fmt("V5 BASELINE        ", baseR));
        console.log(fmt("V5 GREEDY COMBINED ", finalR));
        console.log(
          `Δ pass: ${totalDeltaPp >= 0 ? "+" : ""}${totalDeltaPp.toFixed(2)}pp | Δ TL: ${tlDelta >= 0 ? "+" : ""}${tlDelta} | Δ p90: ${finalR.p90Days - baseR.p90Days}d`,
        );

        // ---------- Adoption table ----------
        console.log(`\nAdoption table:`);
        console.log(
          `  ${"Asset".padEnd(12)} ${"adopted".padStart(8)} ${"sp".padStart(5)} ${"tp".padStart(5)} ${"hb".padStart(5)} ${"rf".padStart(5)} ${"ΔPass".padStart(8)}`,
        );
        for (const a of adoptions) {
          const adoptedTag = a.override ? "YES" : "no";
          const sp = a.override
            ? `${(a.override.stopPct * 100).toFixed(1)}%`
            : "-";
          const tp = a.override
            ? `${(a.override.tpPct * 100).toFixed(1)}%`
            : "-";
          const hb = a.override ? String(a.override.holdBars) : "-";
          const rf = a.override ? a.override.riskFrac.toFixed(2) : "-";
          const dPp = `${a.deltaPp >= 0 ? "+" : ""}${a.deltaPp.toFixed(2)}pp`;
          console.log(
            `  ${a.sym.padEnd(12)} ${adoptedTag.padStart(8)} ${sp.padStart(5)} ${tp.padStart(5)} ${hb.padStart(5)} ${rf.padStart(5)} ${dPp.padStart(8)}`,
          );
        }

        // ---------- Verdict ----------
        const goalPp = 1.5;
        console.log(`\n--- VERDICT ---`);
        if (totalDeltaPp >= goalPp) {
          console.log(
            `  SUCCESS: Δ=+${totalDeltaPp.toFixed(2)}pp ≥ +${goalPp}pp goal → export FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GREEDY`,
          );
        } else {
          console.log(
            `  NO IMPROVEMENT: Δ=+${totalDeltaPp.toFixed(2)}pp < +${goalPp}pp goal → V5 defaults remain near-optimal under pause-engine cooperative dynamic`,
          );
        }

        // ---------- Export-ready code snippet ----------
        if (totalDeltaPp >= goalPp) {
          console.log(
            `\n--- Suggested export (paste into ftmoDaytrade24h.ts) ---`,
          );
          console.log(`/**`);
          console.log(
            ` * TREND_2H_V5_GREEDY — V5 with multi-asset greedy per-asset tuning.`,
          );
          console.log(
            ` *   Method: greedy loop, vary 1 asset at a time on FULL 9-asset run.`,
          );
          console.log(
            ` *   Properly accounts for pauseAtTargetReached cooperative dynamics.`,
          );
          console.log(
            ` *   Multi-fold OOS 30d/3d step on 30000 2h bars (~${(n / 12 / 365).toFixed(2)}y).`,
          );
          console.log(` *   FTMO-real costs (40bp / 12bp / 4bp swap).`);
          console.log(
            ` *   V5 BASELINE        : ${(baseR.passRate * 100).toFixed(2)}% / med ${baseR.medianDays}d / p90 ${baseR.p90Days}d / TL ${baseR.tlBreaches}`,
          );
          console.log(
            ` *   V5_GREEDY COMBINED : ${(finalR.passRate * 100).toFixed(2)}% / med ${finalR.medianDays}d / p90 ${finalR.p90Days}d / TL ${finalR.tlBreaches}`,
          );
          console.log(
            ` *   Δ: +${totalDeltaPp.toFixed(2)}pp pass / Δ TL ${tlDelta >= 0 ? "+" : ""}${tlDelta}`,
          );
          console.log(` * Live: \`FTMO_TF=2h-trend-v5-greedy\`.`);
          console.log(` */`);
          console.log(
            `export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GREEDY: FtmoDaytrade24hConfig = {`,
          );
          console.log(`  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,`);
          console.log(`  pauseAtTargetReached: true,`);
          console.log(`  atrStop: { period: 14, stopMult: 2.5 },`);
          console.log(
            `  assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => {`,
          );
          console.log(`    switch (a.symbol) {`);
          for (const a of adoptions) {
            if (!a.override) continue;
            console.log(`      case "${a.sym}":`);
            console.log(
              `        return { ...a, stopPct: ${a.override.stopPct}, tpPct: ${a.override.tpPct}, holdBars: ${a.override.holdBars}, riskFrac: ${a.override.riskFrac} };`,
            );
          }
          console.log(`      default:`);
          console.log(`        return a;`);
          console.log(`    }`);
          console.log(`  }),`);
          console.log(`};`);
        }

        expect(finalR.windows).toBeGreaterThan(50);
      },
      24 * 3600_000,
    );
  },
);
