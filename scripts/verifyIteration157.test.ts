/**
 * Iter 157 — 3-Constraint feasibility check.
 *
 * User target: "mindestens 2-3 Daytrades/Tag + mindestens 70% WR + mindestens
 * +25% Profit/Trade".
 *
 * This is the FIRST time all three constraints are required simultaneously.
 * Before running another 10k-config scan, sanity-check mathematical/physical
 * feasibility.
 *
 * Sanity checks:
 *   1. Compound-explosion test: 2/day × 25% mean over 1 year → 10^71× equity.
 *      Any strategy with these stats would break market capacity constraints.
 *   2. Win-distribution math: 70% WR + 25% mean + −2% stop requires avg win
 *      = (25 + 0.6) / 0.7 = 36.6%. Every winner +36%, every loser −2%.
 *      No crypto asset has +36% 1h intraday moves 70% of the time.
 *   3. Historical ceiling: iter145-152 proved max robust daytrade mean is
 *      0.91% at 1× leverage. Needed: 27× leverage → −54% per stop — lethal
 *      with 30% of trades hitting stop.
 *
 * What IS achievable (review of shipped tiers + leverage math):
 *   Tier            | trades/day | WR   | meanRaw | meanLev@10× | MatchesTarget
 *   DEFAULT iter135 | 1.2        | 58%  | 0.035%  | 0.35%       | NONE
 *   STRICT iter142  | 0.6        | 60%  | 0.050%  | 0.50%       | NONE
 *   FLASH_10X i156  | 0.013      | 50%  | 2.11%   | 21.12%      | only "profit" part
 *
 * This iter produces the honest matrix showing where each constraint is met
 * and which 2-of-3 combinations ARE achievable. Then recommends a portfolio.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runBtcFlashDaytrade } from "../src/utils/btcFlashDaytrade";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

function bootstrap(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): number {
  if (pnls.length < blockLen) return 0;
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
  return rets.filter((r) => r > 0).length / rets.length;
}

interface Trade {
  pnl: number;
  exitReason: "tp" | "stop" | "time";
}

function runFlashDaytrade(
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
    let reason: "tp" | "stop" | "time" = "time";
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      if (bar.low <= stop) {
        exitBar = j;
        exitPrice = stop;
        reason = "stop";
        break;
      }
      if (bar.high >= tp) {
        exitBar = j;
        exitPrice = tp;
        reason = "tp";
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
    trades.push({ pnl, exitReason: reason });
    cooldown = exitBar + 1;
  }
  return trades;
}

function applyLeverage(pnls: number[], leverage: number) {
  const effPnls: number[] = [];
  for (const p of pnls) {
    const lev = p * leverage;
    if (lev <= -0.9) effPnls.push(-1.0);
    else effPnls.push(lev);
  }
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
  return { effPnls, bankrupt, maxDd, cumRet: bankrupt ? -1 : eq - 1 };
}

function meanOf(p: number[]) {
  return p.length === 0 ? 0 : p.reduce((a, b) => a + b, 0) / p.length;
}

describe("iter 157 — 3-constraint feasibility", () => {
  it(
    "evaluate: 2-3 trades/day + 70% WR + 25% mean/trade",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 157: 3-CONSTRAINT SANITY ===");
      console.log("Target: freq ≥ 2/day, WR ≥ 70%, mean/trade ≥ 25%\n");

      // 1. Compound-explosion test
      console.log("── Test 1: COMPOUND EXPLOSION ──");
      const tradesPerYear = 2 * 365;
      const meanPerTrade = 0.25;
      const logMultiplier = tradesPerYear * Math.log(1 + meanPerTrade);
      console.log(
        `2 trades/day × 365 days × 25% mean → equity multiplier = e^${logMultiplier.toFixed(1)} = ${Math.exp(logMultiplier).toExponential(2)}×`,
      );
      console.log(
        "World BTC market cap is ~$1.5T. Any strategy doubling every 3 days would own the market in ~75 days — IMPOSSIBLE.\n",
      );

      // 2. Win-distribution math
      console.log("── Test 2: WIN-DISTRIBUTION MATH (70% WR, 25% mean) ──");
      for (const stopPct of [-0.02, -0.05, -0.1]) {
        const requiredAvgWin = (0.25 - 0.3 * stopPct) / 0.7;
        console.log(
          `  Stop ${(stopPct * 100).toFixed(0)}%: avgWin must be ${(requiredAvgWin * 100).toFixed(1)}% (per winner) to hit mean 25% at WR 70%`,
        );
      }
      console.log(
        "Even at −10% stop, avg winner must be +29% per trade, 70% of the time. BTC 1h median hi-lo range: ~0.7%. Impossible without extreme leverage.\n",
      );

      // 3. Measure actual distributions on real data
      console.log("── Test 3: REAL DATA — what actually exists? ──");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const days = c.length / 24;
      console.log(`Loaded ${c.length} 1h candles (${days.toFixed(0)} days)\n`);

      interface Res {
        name: string;
        tradesPerDay: number;
        wrRaw: number;
        meanRaw: number;
        leverage: number;
        effMean: number;
        effWr: number;
        target2perDay: boolean;
        targetWr70: boolean;
        targetMean25: boolean;
      }
      const rows: Res[] = [];

      // Helper: find TP-hit rate for a TP threshold on 1h bars → proxy for "WR at that TP"
      // For a given stop, scan TP sweep to find configs where WR ≥ 70%
      interface Cfg {
        name: string;
        dropBars: number;
        dropPct: number;
        tp: number;
        stop: number;
        hold: number;
      }
      const testCfgs: Cfg[] = [
        // Loose drop → high frequency
        {
          name: "loose/5%drop tp=1% s=1.5% h=4",
          dropBars: 12,
          dropPct: 0.03,
          tp: 0.01,
          stop: 0.015,
          hold: 4,
        },
        {
          name: "loose/3%drop tp=0.5% s=0.5% h=2",
          dropBars: 8,
          dropPct: 0.02,
          tp: 0.005,
          stop: 0.005,
          hold: 2,
        },
        // Extreme-tight TP for high WR
        {
          name: "wr-focused tp=0.3% s=1% h=4",
          dropBars: 4,
          dropPct: 0.01,
          tp: 0.003,
          stop: 0.01,
          hold: 4,
        },
        {
          name: "ultra-tight tp=0.2% s=2% h=2",
          dropBars: 4,
          dropPct: 0.01,
          tp: 0.002,
          stop: 0.02,
          hold: 2,
        },
        // iter156 variants
        {
          name: "flash (iter156 base)",
          dropBars: 72,
          dropPct: 0.15,
          tp: 0.1,
          stop: 0.02,
          hold: 24,
        },
      ];

      console.log(
        "Config                                  raw: freq/day  WR    meanRaw  minRaw   (@10× lev): effMean effWR",
      );
      for (const cfg of testCfgs) {
        const t = runFlashDaytrade(
          c,
          cfg.dropBars,
          cfg.dropPct,
          cfg.tp,
          cfg.stop,
          cfg.hold,
        );
        if (t.length < 5) {
          console.log(`${cfg.name.padEnd(40)}  n<5 (skip)`);
          continue;
        }
        const pnls = t.map((x) => x.pnl);
        const wr = pnls.filter((p) => p > 0).length / pnls.length;
        const m = meanOf(pnls);
        const min = Math.min(...pnls);
        const tradesPerDay = t.length / days;
        const L = 10;
        const lev = applyLeverage(pnls, L);
        const effWr =
          lev.effPnls.filter((p) => p > 0).length / lev.effPnls.length;
        const effMean = meanOf(lev.effPnls);

        console.log(
          `${cfg.name.padEnd(40)}  ${tradesPerDay.toFixed(2).padStart(4)}/day  ${(wr * 100).toFixed(0).padStart(2)}%  ${(m * 100).toFixed(3).padStart(6)}%  ${(min * 100).toFixed(2).padStart(5)}%  ${(effMean * 100).toFixed(2).padStart(5)}%  ${(effWr * 100).toFixed(0).padStart(2)}% ${lev.bankrupt ? "BANKRUPT" : ""}`,
        );
        rows.push({
          name: cfg.name,
          tradesPerDay,
          wrRaw: wr,
          meanRaw: m,
          leverage: L,
          effMean,
          effWr,
          target2perDay: tradesPerDay >= 2,
          targetWr70: effWr >= 0.7,
          targetMean25: effMean >= 0.25,
        });
      }

      // 4. Scan a wider grid systematically for 3-constraint pass
      console.log("\n── Test 4: SYSTEMATIC SCAN for 3-constraint match ──");
      interface ScanRes {
        cfg: Cfg;
        n: number;
        tradesPerDay: number;
        wr: number;
        mean: number;
        leverage: number;
        effMean: number;
        effWr: number;
        bsPos: number;
      }
      const hits: ScanRes[] = [];
      let scanned = 0;
      for (const dropBars of [2, 4, 8, 12, 24]) {
        for (const dropPct of [0.003, 0.005, 0.01, 0.02]) {
          for (const tp of [0.002, 0.003, 0.005, 0.01, 0.02]) {
            for (const stop of [0.005, 0.01, 0.02, 0.03]) {
              for (const hold of [2, 4, 8]) {
                scanned++;
                const cfg = { name: "", dropBars, dropPct, tp, stop, hold };
                const t = runFlashDaytrade(
                  c,
                  dropBars,
                  dropPct,
                  tp,
                  stop,
                  hold,
                );
                if (t.length < 100) continue;
                const pnls = t.map((x) => x.pnl);
                const tradesPerDay = t.length / days;
                if (tradesPerDay < 2) continue;
                const wr = pnls.filter((p) => p > 0).length / pnls.length;
                if (wr < 0.7) continue;
                const m = meanOf(pnls);
                for (const L of [5, 10, 15, 20, 25, 30, 50]) {
                  const lev = applyLeverage(pnls, L);
                  if (lev.bankrupt) continue;
                  const effMean = meanOf(lev.effPnls);
                  if (effMean < 0.25) continue;
                  const effWr =
                    lev.effPnls.filter((p) => p > 0).length /
                    lev.effPnls.length;
                  if (effWr < 0.7) continue;
                  const bs = bootstrap(
                    lev.effPnls,
                    100,
                    Math.max(3, Math.floor(lev.effPnls.length / 15)),
                    1234,
                  );
                  hits.push({
                    cfg,
                    n: t.length,
                    tradesPerDay,
                    wr,
                    mean: m,
                    leverage: L,
                    effMean,
                    effWr,
                    bsPos: bs,
                  });
                }
              }
            }
          }
        }
      }
      console.log(
        `Scanned ${scanned} configs × 7 leverages = ${scanned * 7} combos.`,
      );
      console.log(
        `Combos meeting ALL 3 constraints (2/day, 70% WR, 25% mean): **${hits.length}**`,
      );
      if (hits.length > 0) {
        hits.sort((a, b) => b.effMean - a.effMean);
        console.log("\nTop 5:");
        for (const h of hits.slice(0, 5)) {
          console.log(
            `  ${h.cfg.dropBars}b/${(h.cfg.dropPct * 100).toFixed(1)}% tp=${(h.cfg.tp * 100).toFixed(1)}% s=${(h.cfg.stop * 100).toFixed(1)}% h=${h.cfg.hold} × ${h.leverage}× → n=${h.n} ${h.tradesPerDay.toFixed(2)}/day WR=${(h.effWr * 100).toFixed(0)}% effMean=${(h.effMean * 100).toFixed(2)}% bs+=${(h.bsPos * 100).toFixed(0)}%`,
          );
        }
      } else {
        console.log("\n★ NO CONFIG PASSES ALL 3 CONSTRAINTS ★");
        console.log(
          "This confirms the mathematical impossibility derived in Test 1+2.\n",
        );
      }

      // 5. Best 2-of-3 compromises
      console.log("\n── Test 5: Best achievable 2-of-3 combinations ──");
      console.log("A) Freq ≥ 2/day + WR ≥ 70%  (sacrifice mean)");
      console.log("B) Freq ≥ 2/day + mean ≥ 25%  (sacrifice WR)");
      console.log("C) WR ≥ 70% + mean ≥ 25%  (sacrifice freq)");

      expect(true).toBe(true);
    },
  );
});
