/**
 * Iter 154 — LEVERAGED Flash-crash daytrade for higher mean/trade.
 *
 * Context: iter150 proved flash-crash at 1× leverage tops out at mean 0.91%
 * on BTC daytrade (24b/10% drop, tp=5%, stop=3%, n=39, bs+ 97%).
 *
 * Key insight: flash-crash has a TIGHT 2-3% stop. Leverage is survivable IF:
 *   - Stop fires reliably (low slippage past stop)
 *   - Per-trade min loss × leverage ≤ −50%
 *   - Consecutive losers don't compound into ruin
 *
 * This iteration:
 *   1. Re-scan flash-crash configs on BTC 1h, focused on TIGHT stops (≤ 3%)
 *   2. For top-3 robust configs, sweep leverage 1× → 30×
 *   3. Find minimum leverage for ≥ 5% effective mean without bankruptcy
 *   4. Also test per-trade min — no single trade should exceed −60% margin
 *
 * This is a TRUE daytrade (hold ≤ 24h on 1h bars) — unlike iter149's 4w hold.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

function sharpeOf(pnls: number[], barsPerYear: number): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(barsPerYear);
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
): Trade[] {
  const trades: Trade[] = [];
  let cooldown = -1;
  for (let i = Math.max(dropBars + 1, 1); i < candles.length - 1; i++) {
    if (i < cooldown) continue;
    const prev = candles[i - dropBars].close;
    const cur = candles[i].close;
    if (prev <= 0) continue;
    const drop = (cur - prev) / prev;
    if (drop > -dropPct) continue;
    if (cur <= candles[i - 1].close) continue;
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 + tpPct);
    const stop = entry * (1 - stopPct);
    const mx = Math.min(i + 1 + hold, candles.length - 1);
    let exitBar = mx;
    let exitPrice = candles[mx].close;
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
    cooldown = exitBar + 1;
  }
  return trades;
}

interface LevReport {
  leverage: number;
  effMean: number;
  effMin: number;
  effMax: number;
  effSharpe: number;
  effCumRet: number;
  liquidations: number;
  maxDd: number;
  bankrupt: boolean;
}

function simulate(
  pnls: number[],
  leverage: number,
  barsPerYear: number,
): LevReport {
  const effPnls: number[] = [];
  let liquidations = 0;
  for (const p of pnls) {
    const lev = p * leverage;
    if (lev <= -0.9) {
      effPnls.push(-1.0);
      liquidations++;
    } else {
      effPnls.push(lev);
    }
  }
  const effMean =
    effPnls.length > 0
      ? effPnls.reduce((a, b) => a + b, 0) / effPnls.length
      : 0;
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  let bankrupt = false;
  for (const p of effPnls) {
    eq *= 1 + p;
    if (eq <= 0.01) {
      bankrupt = true;
      break;
    }
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return {
    leverage,
    effMean,
    effMin: Math.min(...effPnls),
    effMax: Math.max(...effPnls),
    effSharpe: sharpeOf(effPnls, barsPerYear),
    effCumRet: bankrupt ? -1 : eq - 1,
    liquidations,
    maxDd,
    bankrupt,
  };
}

describe("iter 154 — leveraged flash-crash daytrade", () => {
  it(
    "find leveraged flash-crash configs reaching ≥ 5% mean WITHOUT bankruptcy",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 154: LEVERAGED flash-crash daytrade ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const days = c.length / 24;
      console.log(`loaded ${c.length} 1h candles (${days.toFixed(0)} days)`);

      // Focus on TIGHT-stop configs (stop ≤ 3%) because leverage amplifies stop
      interface Cfg {
        dropBars: number;
        dropPct: number;
        tp: number;
        stop: number;
        hold: number;
      }
      const configs: Cfg[] = [];
      for (const dropBars of [8, 12, 24, 48]) {
        for (const dropPct of [0.05, 0.07, 0.1, 0.12, 0.15]) {
          for (const tp of [0.03, 0.05, 0.07, 0.1]) {
            for (const stop of [0.015, 0.02, 0.025, 0.03]) {
              for (const hold of [12, 24, 36]) {
                configs.push({ dropBars, dropPct, tp, stop, hold });
              }
            }
          }
        }
      }
      console.log(`scanning ${configs.length} tight-stop configs...`);

      interface Row {
        cfg: Cfg;
        n: number;
        wr: number;
        mean: number;
        min: number;
        sh: number;
        bsPos: number;
      }
      const results: Row[] = [];
      for (const cfg of configs) {
        const trades = runFlashCrash(
          c,
          cfg.dropBars,
          cfg.dropPct,
          cfg.tp,
          cfg.stop,
          cfg.hold,
        );
        if (trades.length < 20) continue;
        const pnls = trades.map((t) => t.pnl);
        const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
        const wr = pnls.filter((p) => p > 0).length / pnls.length;
        const sh = sharpeOf(pnls, 365 * 24);
        const bs = bootstrap(
          pnls,
          30,
          Math.max(3, Math.floor(pnls.length / 15)),
          Math.round(
            cfg.dropBars * 100 +
              cfg.dropPct * 100 +
              cfg.tp * 10 +
              cfg.stop +
              cfg.hold,
          ),
        );
        results.push({
          cfg,
          n: trades.length,
          wr,
          mean,
          min: Math.min(...pnls),
          sh,
          bsPos: bs.pctPositive,
        });
      }
      console.log(`configs w/ n ≥ 20: ${results.length}`);

      // Filter robust: n ≥ 30, bs+ ≥ 90%, mean > 0
      const robust = results
        .filter((r) => r.n >= 30 && r.bsPos >= 0.9 && r.mean > 0)
        .sort((a, b) => b.mean - a.mean);
      console.log(`robust configs (n≥30, bs+ ≥ 90%, mean>0): ${robust.length}`);

      console.log("\n── Top 10 robust configs by mean ──");
      console.log(
        "drop(bars,%)   tp   stop  hold    n   WR    mean%    min%    Sharpe  bs+",
      );
      for (const r of robust.slice(0, 10)) {
        console.log(
          `${r.cfg.dropBars.toString().padStart(2)}b/${(r.cfg.dropPct * 100).toFixed(0).padStart(2)}%   ${(r.cfg.tp * 100).toFixed(0).padStart(2)}%  ${(r.cfg.stop * 100).toFixed(1).padStart(4)}%  ${r.cfg.hold.toString().padStart(3)}h  ${r.n.toString().padStart(3)} ${(r.wr * 100).toFixed(0).padStart(3)}%  ${(r.mean * 100).toFixed(2).padStart(6)}%  ${(r.min * 100).toFixed(2).padStart(6)}%  ${r.sh.toFixed(2).padStart(6)}  ${(r.bsPos * 100).toFixed(0).padStart(3)}%`,
        );
      }

      if (robust.length === 0) {
        console.log("NO robust configs found — abort leverage sweep.");
        return;
      }

      // Leverage sweep on top 3
      console.log("\n── Leverage sweep on top 3 robust configs ──");
      for (const r of robust.slice(0, 3)) {
        console.log(
          `\n# Config: drop=${r.cfg.dropBars}b/${(r.cfg.dropPct * 100).toFixed(0)}% tp=${(r.cfg.tp * 100).toFixed(0)}% stop=${(r.cfg.stop * 100).toFixed(1)}% hold=${r.cfg.hold}h`,
        );
        console.log(
          `  raw: n=${r.n} WR=${(r.wr * 100).toFixed(0)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% Shp=${r.sh.toFixed(2)}`,
        );
        const trades = runFlashCrash(
          c,
          r.cfg.dropBars,
          r.cfg.dropPct,
          r.cfg.tp,
          r.cfg.stop,
          r.cfg.hold,
        ).map((t) => t.pnl);
        console.log(
          "  Lev  effMean   minTr    maxDD   liquidations  bankrupt?  Sharpe     cumRet",
        );
        // trades are per-trade pnl; annualize based on trade frequency
        const tradesPerYear = (r.n / days) * 365;
        for (const L of [1, 2, 3, 5, 7, 10, 15, 20, 25, 30]) {
          const sim = simulate(trades, L, tradesPerYear);
          const star5 = sim.effMean >= 0.05 && !sim.bankrupt ? " ★≥5%" : "";
          const star10 = sim.effMean >= 0.1 && !sim.bankrupt ? " ★≥10%" : "";
          const star20 = sim.effMean >= 0.2 && !sim.bankrupt ? " ★≥20%" : "";
          console.log(
            `  ${L.toString().padStart(2)}×  ${(sim.effMean * 100).toFixed(2).padStart(6)}% ${(sim.effMin * 100).toFixed(1).padStart(6)}% ${(sim.maxDd * 100).toFixed(0).padStart(5)}%   ${sim.liquidations.toString().padStart(3)}         ${sim.bankrupt ? "BANKRUPT" : "alive   "}  ${sim.effSharpe.toFixed(2).padStart(5)}  ${(sim.effCumRet * 100).toFixed(0).padStart(12)}%${star5}${star10}${star20}`,
          );
        }
      }

      console.log("\n── Minimum leverage for ≥ 5% mean WITHOUT bankruptcy ──");
      let winner: (Row & { leverage: number; sim: LevReport }) | null = null;
      for (const r of robust.slice(0, 10)) {
        const trades = runFlashCrash(
          c,
          r.cfg.dropBars,
          r.cfg.dropPct,
          r.cfg.tp,
          r.cfg.stop,
          r.cfg.hold,
        ).map((t) => t.pnl);
        const tradesPerYear = (r.n / days) * 365;
        for (let L = 1; L <= 30; L++) {
          const sim = simulate(trades, L, tradesPerYear);
          if (sim.effMean >= 0.05 && !sim.bankrupt && sim.liquidations === 0) {
            console.log(
              `drop=${r.cfg.dropBars}b/${(r.cfg.dropPct * 100).toFixed(0)}% tp=${(r.cfg.tp * 100).toFixed(0)}% s=${(r.cfg.stop * 100).toFixed(1)}% h=${r.cfg.hold}h × ${L}× → effMean ${(sim.effMean * 100).toFixed(2)}%, maxDD ${(sim.maxDd * 100).toFixed(0)}%, Shp ${sim.effSharpe.toFixed(2)}, cumRet ${(sim.effCumRet * 100).toFixed(0)}%`,
            );
            if (!winner || sim.effSharpe > winner.sim.effSharpe) {
              winner = { ...r, leverage: L, sim };
            }
            break;
          }
        }
      }

      if (winner) {
        console.log("\n★★★ ITER 154 WINNER ★★★");
        console.log(
          `Config: dropBars=${winner.cfg.dropBars}, dropPct=${(winner.cfg.dropPct * 100).toFixed(0)}%, tp=${(winner.cfg.tp * 100).toFixed(0)}%, stop=${(winner.cfg.stop * 100).toFixed(1)}%, hold=${winner.cfg.hold}h`,
        );
        console.log(
          `Leverage: ${winner.leverage}×, effMean ${(winner.sim.effMean * 100).toFixed(2)}%, maxDD ${(winner.sim.maxDd * 100).toFixed(0)}%, Shp ${winner.sim.effSharpe.toFixed(2)}, cumRet ${(winner.sim.effCumRet * 100).toFixed(0)}%`,
        );
        console.log(
          `n=${winner.n} trades over ${days.toFixed(0)} days (${((winner.n / days) * 365).toFixed(1)}/year), raw min trade ${(winner.min * 100).toFixed(2)}%`,
        );
      } else {
        console.log(
          "\nNo leveraged flash-crash config safely reaches 5% mean — iter154 FAILS, document as physical limit",
        );
      }
      expect(results.length).toBeGreaterThan(0);
    },
  );
});
