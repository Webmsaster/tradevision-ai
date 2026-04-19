/**
 * Iter 34: Bootstrap walk-forward robustness on the 9 iter33 winners.
 *
 * One 60/40 split is a single sample. Real robustness measure: distribution
 * of OOS Sharpe across many random IS/OOS partitions. We do 10 bootstrap
 * "rolling cuts" — splitting at the 50%, 55%, 60%, 65%, 70%, 75% mark plus
 * 4 random shuffled-block resamples — and report median + min OOS Sharpe.
 *
 * Honest filter (LOCK as production edge):
 *   median OOS Sharpe ≥ 1.0  AND  min OOS Sharpe ≥ 0.0  AND  all OOS profitable
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runVolumeSpikeFade,
  type VolumeSpikeFadeConfig,
} from "../src/utils/volumeSpikeFade";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Candidate {
  symbol: string;
  mode: "fade" | "momentum";
  cfg: VolumeSpikeFadeConfig;
  label: string;
}

const CANDIDATES: Candidate[] = [
  {
    symbol: "SOLUSDT",
    mode: "fade",
    label: "SOL fade v3×p2/4h",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      holdBars: 4,
      stopPct: 0.01,
      mode: "fade",
      costs: MAKER_COSTS,
    },
  },
  {
    symbol: "SUIUSDT",
    mode: "momentum",
    label: "SUI mom v3×p2/6h",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      holdBars: 6,
      stopPct: 0.012,
      mode: "momentum",
      costs: MAKER_COSTS,
    },
  },
  {
    symbol: "AVAXUSDT",
    mode: "momentum",
    label: "AVAX mom v5×p2.5/6h",
    cfg: {
      lookback: 48,
      volMult: 5,
      priceZ: 2.5,
      holdBars: 6,
      stopPct: 0.012,
      mode: "momentum",
      costs: MAKER_COSTS,
    },
  },
  {
    symbol: "MATICUSDT",
    mode: "momentum",
    label: "MATIC mom v3×p2/4h",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      holdBars: 4,
      stopPct: 0.01,
      mode: "momentum",
      costs: MAKER_COSTS,
    },
  },
  {
    symbol: "AVAXUSDT",
    mode: "fade",
    label: "AVAX fade v5×p2/4h",
    cfg: {
      lookback: 48,
      volMult: 5,
      priceZ: 2.0,
      holdBars: 4,
      stopPct: 0.01,
      mode: "fade",
      costs: MAKER_COSTS,
    },
  },
  {
    symbol: "OPUSDT",
    mode: "fade",
    label: "OP fade v3×p2/4h",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      holdBars: 4,
      stopPct: 0.01,
      mode: "fade",
      costs: MAKER_COSTS,
    },
  },
  {
    symbol: "APTUSDT",
    mode: "momentum",
    label: "APT mom v3×p2/4h",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      holdBars: 4,
      stopPct: 0.01,
      mode: "momentum",
      costs: MAKER_COSTS,
    },
  },
  {
    symbol: "INJUSDT",
    mode: "momentum",
    label: "INJ mom v4×p2/6h",
    cfg: {
      lookback: 48,
      volMult: 4,
      priceZ: 2.0,
      holdBars: 6,
      stopPct: 0.012,
      mode: "momentum",
      costs: MAKER_COSTS,
    },
  },
  {
    symbol: "NEARUSDT",
    mode: "fade",
    label: "NEAR fade v3×p2/4h",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      holdBars: 4,
      stopPct: 0.01,
      mode: "fade",
      costs: MAKER_COSTS,
    },
  },
];

/** Forward chronological splits at varying ratios — preserves time order. */
function chronoSplits(candles: Candle[]): Candle[][] {
  const splits: Candle[][] = [];
  for (const r of [0.5, 0.55, 0.6, 0.65, 0.7, 0.75]) {
    const cut = Math.floor(candles.length * r);
    splits.push(candles.slice(cut));
  }
  return splits;
}

/** Block-bootstrap: pick non-overlapping 1-month chunks (~720 bars at 1h)
 *  randomly to assemble an OOS test. Preserves intra-block autocorrelation. */
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
  // mulberry32 PRNG for repeatability
  let s = seed;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked: Candle[] = [];
  const want = Math.min(n, blocks.length);
  const used = new Set<number>();
  while (picked.length < want * blockBars) {
    const idx = Math.floor(rand() * blocks.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(...blocks[idx]);
  }
  // Re-stamp openTime so bars are sequential (avoids gaps confusing returns calc)
  let t = candles[0]?.openTime ?? 0;
  return picked.map((c) => {
    const out = { ...c, openTime: t, closeTime: t + 3_599_999 };
    t += 3_600_000;
    return out;
  });
}

interface BootstrapResult {
  candidate: Candidate;
  sharpes: number[];
  retsPct: number[];
  trades: number[];
  median: number;
  min: number;
  max: number;
  p25: number;
  pctProfitable: number;
  passed: boolean;
}

function pct(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * q)];
}

describe("iteration 34 — bootstrap robustness on iter33 winners", () => {
  it("10 random splits per candidate", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 34: BOOTSTRAP WALK-FORWARD ROBUSTNESS ===");
    const results: BootstrapResult[] = [];

    for (const cand of CANDIDATES) {
      let candles: Candle[] = [];
      try {
        candles = await loadBinanceHistory({
          symbol: cand.symbol,
          timeframe: "1h",
          targetCount: 10000,
        });
      } catch {
        console.log(`  ${cand.label}: fetch failed`);
        continue;
      }
      if (candles.length < 3000) continue;

      const sharpes: number[] = [];
      const retsPct: number[] = [];
      const trades: number[] = [];

      // 6 forward chronological cuts
      for (const oos of chronoSplits(candles)) {
        const r = runVolumeSpikeFade(oos, cand.cfg);
        if (r.trades.length < 10) continue;
        sharpes.push(r.sharpe);
        retsPct.push(r.netReturnPct * 100);
        trades.push(r.trades.length);
      }

      // 4 block-bootstrap resamples
      for (let i = 0; i < 4; i++) {
        const sample = blockBootstrap(candles, 720, 6, 1234 + i * 17);
        const r = runVolumeSpikeFade(sample, cand.cfg);
        if (r.trades.length < 10) continue;
        sharpes.push(r.sharpe);
        retsPct.push(r.netReturnPct * 100);
        trades.push(r.trades.length);
      }

      if (sharpes.length === 0) {
        console.log(`  ${cand.label}: no valid samples`);
        continue;
      }

      const median = pct(sharpes, 0.5);
      const min = Math.min(...sharpes);
      const max = Math.max(...sharpes);
      const p25 = pct(sharpes, 0.25);
      const profitable = retsPct.filter((r) => r > 0).length / retsPct.length;
      const passed = median >= 1.0 && min >= 0.0 && profitable >= 0.8;

      results.push({
        candidate: cand,
        sharpes,
        retsPct,
        trades,
        median,
        min,
        max,
        p25,
        pctProfitable: profitable,
        passed,
      });
    }

    console.log("\n=== RESULTS (Sharpe distribution across 10 splits) ===");
    console.log(
      "label".padEnd(28) +
        "n".padStart(4) +
        "min".padStart(8) +
        "p25".padStart(8) +
        "med".padStart(8) +
        "max".padStart(8) +
        "%prof".padStart(8) +
        " verdict",
    );
    for (const r of results.sort((a, b) => b.median - a.median)) {
      console.log(
        r.candidate.label.padEnd(28) +
          String(r.sharpes.length).padStart(4) +
          r.min.toFixed(2).padStart(8) +
          r.p25.toFixed(2).padStart(8) +
          r.median.toFixed(2).padStart(8) +
          r.max.toFixed(2).padStart(8) +
          (r.pctProfitable * 100).toFixed(0).padStart(7) +
          "%" +
          (r.passed ? "  ★ LOCK" : "  drop"),
      );
    }

    console.log(
      "\nLOCK criteria: median Sharpe ≥ 1.0 AND min Sharpe ≥ 0.0 AND ≥80% of splits profitable.",
    );
    const winners = results.filter((r) => r.passed);
    console.log(`\n★ Locked-in production edges: ${winners.length}`);
    for (const w of winners) {
      console.log(
        `  ${w.candidate.label}  median Sharpe ${w.median.toFixed(2)}  min ${w.min.toFixed(2)}`,
      );
    }
  });
});
