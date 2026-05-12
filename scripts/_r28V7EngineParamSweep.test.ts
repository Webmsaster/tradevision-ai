/**
 * R28_V7 Engine-Parameter Sweep — Round 56+ post-fix re-tuning.
 *
 * Goal: find R28_V7 improvement via engine-parameter combinations that
 * may have a different optimum AFTER the R56-58 V4-engine bug fixes.
 *
 * R28_V6 currently 56.62% post-fix (per task brief). Pre-fix optimum
 * was tpMult=0.55 + DPT 0.012 + PTP {0.012,0.7} + pDD {0.03,0.15}.
 *
 * Phases (run sequentially, smart prioritization):
 *   1. DPT trailDistance ∈ {0.008, 0.010, 0.012, 0.015, 0.018, 0.020}
 *   2. PTP triggerPct ∈ {0.010, 0.012, 0.015, 0.018, 0.020}
 *      × closeFraction ∈ {0.5, 0.6, 0.7, 0.8}
 *   3. BreakEven threshold ∈ {disabled, 0.010, 0.015, 0.020}
 *   4. Chandelier period ∈ {disabled, 22, 56, 100} × mult ∈ {1.5, 2.5, 3.0}
 *   5. Combined top-3 (only if any phase yielded ≥+1pp)
 *
 * Each variant ~120s on 136 windows (5.55y / 30m / 9-asset basket).
 * Total budget: ~85min for all 42 variants.
 *
 * Win criteria: ≥60% → ship as R28_V7_ENGINE_TUNED, 58-60% marginal,
 * <58% no winner.
 *
 * Speed trick: per-window trim-and-simulate (matches _r28V6Run.ts) — runs
 * each variant in ~2min instead of ~25min by re-using cached candle slices.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = `${CACHE_DIR}/r28v7_engine_param.log`;
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

function loadAligned(): {
  aligned: Record<string, Candle[]>;
  minBars: number;
} {
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

interface VariantResult {
  label: string;
  passes: number;
  windows: number;
  rate: number;
  medPassDay: number;
  elapsedSec: number;
}

function runVariant(
  label: string,
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  minBars: number,
): VariantResult {
  const winBars = cfg.maxDays * 48;
  const stepBars = 14 * 48;
  const WARMUP = 5000;
  let passes = 0;
  let windows = 0;
  const passDays: number[] = [];
  const t0 = Date.now();
  for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
    windows++;
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned))
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, label);
    if (r.passed) {
      passes++;
      if (r.passDay) passDays.push(r.passDay);
    }
  }
  passDays.sort((a, b) => a - b);
  const medPassDay =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const rate = (passes / windows) * 100;
  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  plog(
    `[done] ${label.padEnd(40)} ${passes}/${windows} = ${rate.toFixed(2)}% / med=${medPassDay}d / ${elapsedSec}s`,
  );
  return { label, passes, windows, rate, medPassDay, elapsedSec };
}

function deltaTag(rate: number, baseline: number): string {
  const d = rate - baseline;
  const sign = d >= 0 ? "+" : "";
  const star = d >= 1.0 ? " ★ candidate" : d >= 0.5 ? " (marginal)" : "";
  return `Δ ${sign}${d.toFixed(2)}pp${star}`;
}

describe("R28_V7 Engine-Parameter Sweep", () => {
  it(
    "runs phase 1-5 and reports the winner",
    async () => {
      const { aligned, minBars } = loadAligned();
      plog(`[setup] ${SYMBOLS.length} syms, ${minBars} bars`);
      plog(
        `[setup] base = R28_V6 (DPT 0.012, PTP {0.012, 0.7}, pDD {0.03, 0.15}, tpMult ×0.55)`,
      );
      plog(`[setup] post-R56/57/58 R28_V6 baseline = 56.62% (task brief)`);
      plog("");

      // Establish on-engine baseline (run vanilla R28_V6 first to compare against)
      plog("=== Phase 0 — R28_V6 baseline confirmation ===");
      const base = runVariant(
        "R28_V6_baseline",
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
        aligned,
        minBars,
      );
      const BASELINE = base.rate;
      plog(`[baseline] ${BASELINE.toFixed(2)}% (used as Δ-anchor)\n`);

      // ============================================================
      // Phase 1 — DPT trailDistance
      // ============================================================
      plog("=== Phase 1 — DPT (dailyPeakTrailingStop) ===");
      const dptValues = [0.008, 0.01, 0.012, 0.015, 0.018, 0.02];
      const phase1Results: VariantResult[] = [];
      for (const v of dptValues) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
          dailyPeakTrailingStop: { trailDistance: v },
        };
        const r = runVariant(`dpt_${v.toFixed(3)}`, cfg, aligned, minBars);
        plog(`         ${deltaTag(r.rate, BASELINE)}`);
        phase1Results.push(r);
      }
      const phase1Best = phase1Results.reduce((a, b) =>
        b.rate > a.rate ? b : a,
      );
      const phase1BestDelta = phase1Best.rate - BASELINE;
      plog(
        `\n[phase 1 best] ${phase1Best.label} → ${phase1Best.rate.toFixed(2)}% (Δ ${phase1BestDelta >= 0 ? "+" : ""}${phase1BestDelta.toFixed(2)}pp)\n`,
      );

      // ============================================================
      // Phase 2 — PTP grid (5 × 4 = 20 variants)
      // ============================================================
      plog("=== Phase 2 — PTP (partialTakeProfit) grid ===");
      const ptpTriggers = [0.01, 0.012, 0.015, 0.018, 0.02];
      const ptpFractions = [0.5, 0.6, 0.7, 0.8];
      const phase2Results: VariantResult[] = [];
      for (const tp of ptpTriggers) {
        for (const cf of ptpFractions) {
          const cfg: FtmoDaytrade24hConfig = {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
            partialTakeProfit: { triggerPct: tp, closeFraction: cf },
          };
          const r = runVariant(
            `ptp_t${tp.toFixed(3)}_f${cf.toFixed(1)}`,
            cfg,
            aligned,
            minBars,
          );
          plog(`         ${deltaTag(r.rate, BASELINE)}`);
          phase2Results.push(r);
        }
      }
      const phase2Best = phase2Results.reduce((a, b) =>
        b.rate > a.rate ? b : a,
      );
      const phase2BestDelta = phase2Best.rate - BASELINE;
      plog(
        `\n[phase 2 best] ${phase2Best.label} → ${phase2Best.rate.toFixed(2)}% (Δ ${phase2BestDelta >= 0 ? "+" : ""}${phase2BestDelta.toFixed(2)}pp)\n`,
      );

      // Phase 3+4 only if Phase 1+2 produced any +1pp signal (smart prioritization).
      const haveEarlyWinner = phase1BestDelta >= 1.0 || phase2BestDelta >= 1.0;

      // ============================================================
      // Phase 3 — BreakEven threshold
      // ============================================================
      plog("=== Phase 3 — BreakEven threshold ===");
      const beValues: Array<number | null> = [null, 0.01, 0.015, 0.02];
      const phase3Results: VariantResult[] = [];
      for (const v of beValues) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
          breakEven: v == null ? undefined : { threshold: v },
        };
        const lbl = v == null ? "be_disabled" : `be_${v.toFixed(3)}`;
        const r = runVariant(lbl, cfg, aligned, minBars);
        plog(`         ${deltaTag(r.rate, BASELINE)}`);
        phase3Results.push(r);
      }
      const phase3Best = phase3Results.reduce((a, b) =>
        b.rate > a.rate ? b : a,
      );
      const phase3BestDelta = phase3Best.rate - BASELINE;
      plog(
        `\n[phase 3 best] ${phase3Best.label} → ${phase3Best.rate.toFixed(2)}% (Δ ${phase3BestDelta >= 0 ? "+" : ""}${phase3BestDelta.toFixed(2)}pp)\n`,
      );

      // ============================================================
      // Phase 4 — Chandelier (period × mult)
      // ============================================================
      plog("=== Phase 4 — Chandelier (period × ATR mult) ===");
      const chandPeriods: Array<number | null> = [null, 22, 56, 100];
      const chandMults = [1.5, 2.5, 3.0];
      const phase4Results: VariantResult[] = [];
      for (const p of chandPeriods) {
        if (p == null) {
          // disabled = baseline (no chandelier already)
          const cfg: FtmoDaytrade24hConfig = {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
          };
          // R28_V6 already has no chandelierExit, so this just confirms.
          const r = runVariant("chand_disabled", cfg, aligned, minBars);
          plog(`         ${deltaTag(r.rate, BASELINE)}`);
          phase4Results.push(r);
        } else {
          for (const m of chandMults) {
            const cfg: FtmoDaytrade24hConfig = {
              ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
              chandelierExit: { period: p, mult: m, minMoveR: 0.5 },
            };
            const r = runVariant(
              `chand_p${p}_m${m.toFixed(1)}`,
              cfg,
              aligned,
              minBars,
            );
            plog(`         ${deltaTag(r.rate, BASELINE)}`);
            phase4Results.push(r);
          }
        }
      }
      const phase4Best = phase4Results.reduce((a, b) =>
        b.rate > a.rate ? b : a,
      );
      const phase4BestDelta = phase4Best.rate - BASELINE;
      plog(
        `\n[phase 4 best] ${phase4Best.label} → ${phase4Best.rate.toFixed(2)}% (Δ ${phase4BestDelta >= 0 ? "+" : ""}${phase4BestDelta.toFixed(2)}pp)\n`,
      );

      // ============================================================
      // Phase 5 — Combined top-3 (only if any phase yielded ≥+1pp)
      // ============================================================
      const allPhaseWinners = [
        { phase: 1, best: phase1Best, delta: phase1BestDelta },
        { phase: 2, best: phase2Best, delta: phase2BestDelta },
        { phase: 3, best: phase3Best, delta: phase3BestDelta },
        { phase: 4, best: phase4Best, delta: phase4BestDelta },
      ];
      const winners = allPhaseWinners.filter((w) => w.delta >= 1.0);

      if (winners.length >= 2) {
        plog("=== Phase 5 — Combined Top Phase Winners ===");
        // Build combined config: apply each phase winner's tweak.
        const combined: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
        };
        const tags: string[] = [];

        // Phase 1 winner — DPT
        if (phase1BestDelta >= 1.0) {
          const v = parseFloat(phase1Best.label.replace("dpt_", ""));
          combined.dailyPeakTrailingStop = { trailDistance: v };
          tags.push(`DPT=${v}`);
        }
        // Phase 2 winner — PTP
        if (phase2BestDelta >= 1.0) {
          // ptp_t0.012_f0.7
          const m = phase2Best.label.match(/ptp_t([\d.]+)_f([\d.]+)/);
          if (m) {
            const tp = parseFloat(m[1]!);
            const cf = parseFloat(m[2]!);
            combined.partialTakeProfit = { triggerPct: tp, closeFraction: cf };
            tags.push(`PTP=${tp}/${cf}`);
          }
        }
        // Phase 3 winner — BE
        if (phase3BestDelta >= 1.0 && phase3Best.label !== "be_disabled") {
          const v = parseFloat(phase3Best.label.replace("be_", ""));
          combined.breakEven = { threshold: v };
          tags.push(`BE=${v}`);
        }
        // Phase 4 winner — Chandelier
        if (phase4BestDelta >= 1.0 && phase4Best.label !== "chand_disabled") {
          const m = phase4Best.label.match(/chand_p(\d+)_m([\d.]+)/);
          if (m) {
            const p = parseInt(m[1]!, 10);
            const mult = parseFloat(m[2]!);
            combined.chandelierExit = { period: p, mult, minMoveR: 0.5 };
            tags.push(`Chand=${p}/${mult}`);
          }
        }

        const r = runVariant(
          `combined[${tags.join("+")}]`,
          combined,
          aligned,
          minBars,
        );
        plog(`         ${deltaTag(r.rate, BASELINE)}`);
        const bestSingle = Math.max(
          phase1BestDelta,
          phase2BestDelta,
          phase3BestDelta,
          phase4BestDelta,
        );
        plog(
          `\n[phase 5 combined] ${r.rate.toFixed(2)}% vs best-single ${(BASELINE + bestSingle).toFixed(2)}% (${r.rate >= BASELINE + bestSingle ? "ADDITIVE" : "redundant"})`,
        );
      } else {
        plog(
          `=== Phase 5 SKIPPED — only ${winners.length} phase(s) hit ≥+1pp threshold ===`,
        );
        if (haveEarlyWinner) {
          plog(`[note] Early-phase winner exists; no need to combine.`);
        }
      }

      // ============================================================
      // Final ranking + winner verdict
      // ============================================================
      plog("\n=== FINAL RANKING (top 10) ===");
      const all = [
        ...phase1Results,
        ...phase2Results,
        ...phase3Results,
        ...phase4Results,
      ];
      all.sort((a, b) => b.rate - a.rate);
      for (const r of all.slice(0, 10)) {
        plog(
          `  ${r.label.padEnd(40)} ${r.rate.toFixed(2)}% / med=${r.medPassDay}d  ${deltaTag(r.rate, BASELINE)}`,
        );
      }

      const overallBest = all[0]!;
      plog(
        `\n=== WINNER: ${overallBest.label} → ${overallBest.rate.toFixed(2)}% / med=${overallBest.medPassDay}d ===`,
      );
      plog(`baseline R28_V6:    ${BASELINE.toFixed(2)}%`);
      plog(
        `delta:              ${overallBest.rate - BASELINE >= 0 ? "+" : ""}${(overallBest.rate - BASELINE).toFixed(2)}pp`,
      );
      if (overallBest.rate >= 60) {
        plog(`verdict:            SHIP as R28_V7_ENGINE_TUNED (≥60%)`);
      } else if (overallBest.rate >= 58) {
        plog(`verdict:            MARGINAL (58-60%) — document, do not ship`);
      } else {
        plog(`verdict:            NO WINNER (<58%) — keep R28_V6`);
      }

      expect(all.length).toBeGreaterThan(0);
    },
    24 * 3600 * 1000, // 24h timeout cap
  );
});
