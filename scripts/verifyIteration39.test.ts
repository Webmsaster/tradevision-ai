/**
 * Iter 39: Drawdown-Fade verification with bootstrap from start.
 *
 * Hypothesis: 4-8h cumulative drops/pumps are liquidation cascades that
 * mean-revert. Test on BTC/ETH/SOL/AVAX/SUI with multiple thresholds, then
 * bootstrap each candidate.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runDrawdownFade,
  type DrawdownFadeConfig,
} from "../src/utils/drawdownFade";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Variant {
  name: string;
  cfg: DrawdownFadeConfig;
}

function buildVariants(): Variant[] {
  const params: Array<
    Pick<
      DrawdownFadeConfig,
      | "windowBars"
      | "dropThresholdPct"
      | "pumpThresholdPct"
      | "holdBars"
      | "stopPct"
    >
  > = [
    {
      windowBars: 4,
      dropThresholdPct: 0.04,
      pumpThresholdPct: 0.04,
      holdBars: 4,
      stopPct: 0.02,
    },
    {
      windowBars: 4,
      dropThresholdPct: 0.04,
      pumpThresholdPct: 0.04,
      holdBars: 8,
      stopPct: 0.025,
    },
    {
      windowBars: 4,
      dropThresholdPct: 0.06,
      pumpThresholdPct: 0.06,
      holdBars: 8,
      stopPct: 0.025,
    },
    {
      windowBars: 8,
      dropThresholdPct: 0.06,
      pumpThresholdPct: 0.06,
      holdBars: 8,
      stopPct: 0.03,
    },
    {
      windowBars: 8,
      dropThresholdPct: 0.08,
      pumpThresholdPct: 0.08,
      holdBars: 8,
      stopPct: 0.03,
    },
    {
      windowBars: 4,
      dropThresholdPct: 0.05,
      pumpThresholdPct: 0.05,
      holdBars: 6,
      stopPct: 0.02,
    },
  ];
  return params.map((p) => ({
    name: `w${p.windowBars}/d${(p.dropThresholdPct * 100).toFixed(0)}/h${p.holdBars}`,
    cfg: { ...p, costs: MAKER_COSTS },
  }));
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
  for (let i = 0; i + blockBars <= candles.length; i += blockBars)
    blocks.push(candles.slice(i, i + blockBars));
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

describe("iteration 39 — drawdown fade with bootstrap", () => {
  it("multi-asset matrix + bootstrap", { timeout: 600_000 }, async () => {
    console.log("\n=== ITER 39: DRAWDOWN FADE (CASCADE REVERSAL) ===");
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT", "SUIUSDT"];
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "1h",
        targetCount: 10000,
      });
    }

    interface Row {
      sym: string;
      variant: string;
      isSh: number;
      oosSh: number;
      oosRet: number;
      oosTrades: number;
      oosDD: number;
      passed: boolean;
    }
    const winners: Row[] = [];
    for (const sym of symbols) {
      console.log(`\n${sym} (n=${data[sym].length})`);
      const { is, oos } = (() => {
        const cut = Math.floor(data[sym].length * 0.6);
        return { is: data[sym].slice(0, cut), oos: data[sym].slice(cut) };
      })();
      let best: {
        variant: string;
        cfg: DrawdownFadeConfig;
        isSh: number;
      } | null = null;
      for (const v of buildVariants()) {
        const r = runDrawdownFade(is, v.cfg);
        if (r.trades.length < 10) continue;
        if (!best || r.sharpe > best.isSh)
          best = { variant: v.name, cfg: v.cfg, isSh: r.sharpe };
      }
      if (!best) {
        console.log("  no qualifying");
        continue;
      }
      const oRep = runDrawdownFade(oos, best.cfg);
      const passed =
        oRep.sharpe >= 1.0 && oRep.trades.length >= 30 && best.isSh > 0;
      console.log(
        `  BEST=${best.variant.padEnd(14)}  IS=${best.isSh.toFixed(2)}  OOS=${oRep.sharpe.toFixed(2)}  ret=${(oRep.netReturnPct * 100).toFixed(1)}%  trades=${oRep.trades.length}  DD=${(oRep.maxDrawdownPct * 100).toFixed(1)}%${passed ? "  ★" : ""}`,
      );
      if (passed)
        winners.push({
          sym,
          variant: best.variant,
          isSh: best.isSh,
          oosSh: oRep.sharpe,
          oosRet: oRep.netReturnPct * 100,
          oosTrades: oRep.trades.length,
          oosDD: oRep.maxDrawdownPct * 100,
          passed,
        });

      // If passed walk-forward, run bootstrap
      if (passed) {
        const slices = chronoSplits(data[sym]);
        for (let i = 0; i < 4; i++)
          slices.push(blockBootstrap(data[sym], 720, 6, 1234 + i * 17));
        const sharpes: number[] = [];
        const rets: number[] = [];
        for (const sl of slices) {
          const r = runDrawdownFade(sl, best.cfg);
          if (r.trades.length < 5) continue;
          sharpes.push(r.sharpe);
          rets.push(r.netReturnPct * 100);
        }
        const median = sharpes.length
          ? [...sharpes].sort((a, b) => a - b)[Math.floor(sharpes.length / 2)]
          : 0;
        const min = sharpes.length ? Math.min(...sharpes) : 0;
        const profit = rets.length
          ? rets.filter((r) => r > 0).length / rets.length
          : 0;
        const lock = median >= 1.0 && min >= 0.0 && profit >= 0.8;
        console.log(
          `    bootstrap: median=${median.toFixed(2)}  min=${min.toFixed(2)}  %prof=${(profit * 100).toFixed(0)}%${lock ? "  ★ LOCK" : "  drop"}`,
        );
      }
    }
  });
});
