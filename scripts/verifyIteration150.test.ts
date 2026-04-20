/**
 * Iter 150 — Flash-crash mean-reversion (the final honest daytrade try).
 *
 * Hypothesis: after a steep drop in ≤ Nbars, BTC tends to mean-revert
 * within 24-48h. A contrarian long entry on the first green bar after
 * such a drop has asymmetric payoff — small stop (−3-5%) vs. decent
 * bounce (+5-10%).
 *
 * This is the ONLY remaining architecture that could physically deliver
 * ≥ 5% mean/trade within a strict 24h daytrade hold.
 *
 * Trigger: close[i] / close[i-dropBars] − 1 ≤ −dropPct (big drop)
 *           AND close[i] > close[i-1] (green rebound bar)
 * Entry: next bar open
 * Exit: TP 5-10% OR stop 3-5% OR time (≤ 24 bars on 1h = 24h)
 *
 * Scan grid:
 *   dropPct ∈ {−5, −7, −10, −12, −15%}
 *   dropBars ∈ {4, 8, 12, 24 bars on 1h}
 *   tpPct ∈ {3, 5, 7, 10%}
 *   stopPct ∈ {2, 3, 5%}
 *   hold ∈ {12, 24 bars}
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

function sharpeOf(pnls: number[]): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(365 * 24);
}
function bootstrap(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): { pctPositive: number; p5: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, p5: 0 };
  let s = seed;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const rets: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sampled: number[] = [];
    const nBlocks = Math.ceil(pnls.length / blockLen);
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * Math.max(1, pnls.length - blockLen));
      for (let k = 0; k < blockLen; k++) sampled.push(pnls[start + k]);
    }
    const ret = sampled.reduce((a, p) => a * (1 + p), 1) - 1;
    rets.push(ret);
  }
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    pctPositive: rets.filter((r) => r > 0).length / rets.length,
    p5: sorted[Math.floor(sorted.length * 0.05)],
  };
}

interface Trade {
  pnl: number;
  openBar: number;
}

function runFlashCrash(
  candles: Candle[],
  dropBars: number,
  dropPct: number,
  tpPct: number,
  stopPct: number,
  hold: number,
): { trades: Trade[]; tpHits: number } {
  const trades: Trade[] = [];
  let tpHits = 0;
  let cooldown = -1;
  for (let i = Math.max(dropBars + 1, 1); i < candles.length - 1; i++) {
    if (i < cooldown) continue;
    const prev = candles[i - dropBars].close;
    const cur = candles[i].close;
    if (prev <= 0) continue;
    const drop = (cur - prev) / prev;
    if (drop > -dropPct) continue; // not enough drop
    // Rebound bar: current close > previous close
    if (cur <= candles[i - 1].close) continue;
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 + tpPct);
    const stop = entry * (1 - stopPct);
    const mx = Math.min(i + 1 + hold, candles.length - 1);
    let exitBar = mx;
    let exitPrice = candles[mx].close;
    let hitTp = false;
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      if (bar.low <= stop) {
        exitBar = j;
        exitPrice = stop;
        break;
      }
      if (bar.high >= tp) {
        exitBar = j;
        exitPrice = tp;
        hitTp = true;
        break;
      }
    }
    const pnl = applyCosts({
      entry,
      exit: exitPrice,
      direction: "long",
      holdingHours: exitBar - (i + 1),
      config: MAKER_COSTS,
    }).netPnlPct;
    trades.push({ pnl, openBar: i });
    if (hitTp) tpHits++;
    cooldown = exitBar + 1;
  }
  return { trades, tpHits };
}

describe("iter 150 — flash-crash daytrade", () => {
  it(
    "scan flash-crash mean-reversion configs for ≥ 5% mean",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 150: flash-crash daytrade ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const days = c.length / 24;
      console.log(`loaded ${c.length} 1h candles (${days.toFixed(0)} days)`);

      interface Row {
        dropBars: number;
        dropPct: number;
        tp: number;
        stop: number;
        hold: number;
        n: number;
        wr: number;
        mean: number;
        sh: number;
        bsPos: number;
        tpHitRate: number;
      }
      const results: Row[] = [];
      for (const dropBars of [4, 8, 12, 24]) {
        for (const dropPct of [0.05, 0.07, 0.1, 0.12, 0.15]) {
          for (const tp of [0.03, 0.05, 0.07, 0.1]) {
            for (const stop of [0.02, 0.03, 0.05]) {
              for (const hold of [12, 24]) {
                const { trades, tpHits } = runFlashCrash(
                  c,
                  dropBars,
                  dropPct,
                  tp,
                  stop,
                  hold,
                );
                if (trades.length < 20) continue;
                const pnls = trades.map((t) => t.pnl);
                const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
                const wr = pnls.filter((p) => p > 0).length / pnls.length;
                const sh = sharpeOf(pnls);
                const bs = bootstrap(
                  pnls,
                  30,
                  Math.max(3, Math.floor(pnls.length / 15)),
                  Math.round(
                    dropBars * 100 + dropPct * 100 + tp * 10 + stop + hold,
                  ),
                );
                results.push({
                  dropBars,
                  dropPct,
                  tp,
                  stop,
                  hold,
                  n: trades.length,
                  wr,
                  mean,
                  sh,
                  bsPos: bs.pctPositive,
                  tpHitRate: tpHits / trades.length,
                });
              }
            }
          }
        }
      }

      console.log(`\ntotal configs with n ≥ 20: ${results.length}`);

      // Highest mean
      const top = [...results].sort((a, b) => b.mean - a.mean).slice(0, 20);
      console.log("\n── Top 20 by mean (all configs, incl. low-n) ──");
      console.log(
        "drop(bars,%)    tp    stop  hold   n   WR     mean%   Sharpe  bs+    tpHit%",
      );
      for (const r of top) {
        const robust = r.bsPos >= 0.9 && r.n >= 30 ? "★" : " ";
        const at5 = r.mean >= 0.05 && r.bsPos >= 0.9 && r.n >= 30 ? " 5%!" : "";
        console.log(
          `${r.dropBars.toString().padStart(2)}b/${(r.dropPct * 100).toFixed(0).padStart(2)}%    ${(r.tp * 100).toFixed(0).padStart(2)}%   ${(r.stop * 100).toFixed(0).padStart(2)}%  ${r.hold.toString().padStart(3)}h  ${r.n.toString().padStart(3)} ${(r.wr * 100).toFixed(1).padStart(5)}% ${(r.mean * 100).toFixed(2).padStart(6)}% ${r.sh.toFixed(2).padStart(6)} ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(r.tpHitRate * 100).toFixed(1).padStart(5)}% ${robust}${at5}`,
        );
      }

      const fiveTarget = results.filter(
        (r) => r.mean >= 0.05 && r.bsPos >= 0.9 && r.n >= 30,
      );
      console.log(
        `\nConfigs meeting mean ≥ 5% AND bs+ ≥ 90% AND n ≥ 30: **${fiveTarget.length}**`,
      );
      if (fiveTarget.length > 0) {
        const best = fiveTarget.sort((a, b) => b.sh - a.sh)[0];
        console.log(
          `Best Sharpe: drop=${best.dropBars}b/${(best.dropPct * 100).toFixed(0)}% tp=${(best.tp * 100).toFixed(0)}% s=${(best.stop * 100).toFixed(0)}% h=${best.hold}h → n=${best.n} WR=${(best.wr * 100).toFixed(1)}% mean=${(best.mean * 100).toFixed(2)}% Shp=${best.sh.toFixed(2)}`,
        );
      } else {
        const best = results
          .filter((r) => r.bsPos >= 0.9 && r.n >= 30)
          .sort((a, b) => b.mean - a.mean)[0];
        if (best) {
          console.log(
            `No 5% config. Max robust mean: drop=${best.dropBars}b/${(best.dropPct * 100).toFixed(0)}% tp=${(best.tp * 100).toFixed(0)}% → mean=${(best.mean * 100).toFixed(2)}% Shp=${best.sh.toFixed(2)} n=${best.n}`,
          );
        }
      }
    },
  );
});
