/**
 * 5m AGGRESSIVE multi-iteration sweep on max Binance history (5.71y).
 *
 * Runs the same axis-by-axis pipeline as 15m V1→V8 condensed into one big test:
 *   R1: atrStop fine-grain (period × mult)
 *   R2: LSC + HTF
 *   R3: chandelierExit
 *   R4: partialTakeProfit
 *   R5: timeBoost
 *   R6: greedy hour-drop
 *   R7: BTC mom + caf params
 *   R8: multi-asset (BNB, ADA)
 *   R9: drawdown protection (shield + peakDD)
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 5 / 60;

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

describe("5m Aggressive Sweep (max history)", { timeout: 1800_000 }, () => {
  it("V2 push", async () => {
    const targetCount = 700000;
    const maxPages = 700;
    console.log(`Loading max 5m history...`);
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "5m",
      targetCount,
      maxPages,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "5m",
      targetCount,
      maxPages,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "5m",
      targetCount,
      maxPages,
    });
    const bnb = await loadBinanceHistory({
      symbol: "BNBUSDT",
      timeframe: "5m",
      targetCount,
      maxPages,
    });
    const ada = await loadBinanceHistory({
      symbol: "ADAUSDT",
      timeframe: "5m",
      targetCount,
      maxPages,
    });
    const n = Math.min(
      eth.length,
      btc.length,
      sol.length,
      bnb.length,
      ada.length,
    );
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
      BNBUSDT: bnb.slice(-n),
      ADAUSDT: ada.slice(-n),
    };
    const yrs = (n / 288 / 365).toFixed(2);
    console.log(`Aligned: ${n} bars (${yrs}y)\n`);

    let cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1,
      liveCaps: LIVE_CAPS,
    };
    let curR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V1 BASELINE", curR));

    // R1: atrStop fine grain
    console.log(`\n--- R1: atrStop fine grain ---`);
    let r1Best = { cfg: cur, r: curR };
    for (const p of [7, 14, 28, 42, 56, 84]) {
      for (const m of [2, 2.5, 3, 3.5, 4, 4.5, 5, 6]) {
        const cfg = { ...cur, atrStop: { period: p, stopMult: m } };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r1Best.r) < 0) {
          r1Best = { cfg, r };
          console.log(fmt(`  atr p${p} m${m}`, r));
        }
      }
    }
    cur = r1Best.cfg;
    console.log(fmt("R1 winner", r1Best.r));

    // R2: LSC + HTF combined
    console.log(`\n--- R2: LSC ---`);
    let r2Best = { cfg: cur, r: r1Best.r };
    for (const after of [2, 3]) {
      for (const cd of [200, 400, 600, 900, 1200, 1800]) {
        const cfg = {
          ...cur,
          lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r2Best.r) < 0) {
          r2Best = { cfg, r };
          console.log(fmt(`  LSC ${after}/${cd}`, r));
        }
      }
    }
    cur = r2Best.cfg;
    console.log(fmt("R2 winner", r2Best.r));

    console.log(`\n--- R2b: HTF ---`);
    let r2bBest = { cfg: cur, r: r2Best.r };
    for (const lb of [200, 400, 800, 1200, 2000]) {
      for (const thr of [0.03, 0.05, 0.08, 0.1, 0.15]) {
        const cfg = {
          ...cur,
          htfTrendFilter: {
            lookbackBars: lb,
            apply: "short" as const,
            threshold: thr,
          },
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r2bBest.r) < 0) {
          r2bBest = { cfg, r };
          console.log(fmt(`  HTF lb=${lb} thr=${thr}`, r));
        }
      }
    }
    cur = r2bBest.cfg;
    console.log(fmt("R2b winner", r2bBest.r));

    // R3: chandelierExit
    console.log(`\n--- R3: chandelierExit ---`);
    let r3Best = { cfg: cur, r: r2bBest.r };
    for (const period of [56, 168, 336, 600]) {
      for (const mult of [2, 2.5, 3, 3.5, 4, 5]) {
        const cfg = { ...cur, chandelierExit: { period, mult, minMoveR: 0.5 } };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r3Best.r) < 0) {
          r3Best = { cfg, r };
          console.log(fmt(`  chand p${period} m${mult}`, r));
        }
      }
    }
    cur = r3Best.cfg;
    console.log(fmt("R3 winner", r3Best.r));

    // R4: partialTakeProfit
    console.log(`\n--- R4: PTP ---`);
    let r4Best = { cfg: cur, r: r3Best.r };
    for (const trigger of [0.005, 0.008, 0.01, 0.015, 0.02, 0.025, 0.03]) {
      for (const frac of [0.2, 0.3, 0.5, 0.7]) {
        const cfg = {
          ...cur,
          partialTakeProfit: { triggerPct: trigger, closeFraction: frac },
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r4Best.r) < 0) {
          r4Best = { cfg, r };
          console.log(fmt(`  PTP t=${trigger} f=${frac}`, r));
        }
      }
    }
    cur = r4Best.cfg;
    console.log(fmt("R4 winner", r4Best.r));

    // R5: timeBoost
    console.log(`\n--- R5: timeBoost ---`);
    let r5Best = { cfg: cur, r: r4Best.r };
    for (const day of [2, 4, 6, 8, 12]) {
      for (const eqB of [0.02, 0.04, 0.07]) {
        for (const factor of [1.5, 2, 2.5, 3]) {
          const cfg = {
            ...cur,
            timeBoost: { afterDay: day, equityBelow: eqB, factor },
          };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (score(r, r5Best.r) < 0) {
            r5Best = { cfg, r };
            console.log(fmt(`  tb d=${day} eb=${eqB} f=${factor}`, r));
          }
        }
      }
    }
    cur = r5Best.cfg;
    console.log(fmt("R5 winner", r5Best.r));

    // R6: greedy hour drop
    console.log(`\n--- R6: greedy hour-drop ---`);
    let r6Best = { cfg: cur, r: r5Best.r };
    let bestHours =
      cur.allowedHoursUtc ?? Array.from({ length: 24 }, (_, i) => i);
    let improved = true;
    let iter = 0;
    while (improved && iter < 4) {
      improved = false;
      for (const h of [...bestHours]) {
        const candidate = bestHours.filter((x) => x !== h);
        if (candidate.length < 6) continue;
        const cfg = { ...cur, allowedHoursUtc: candidate };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r6Best.r) < 0) {
          r6Best = { cfg, r };
          bestHours = candidate;
          improved = true;
          console.log(fmt(`  drop ${h}`, r));
        }
      }
      iter++;
    }
    cur = r6Best.cfg;
    console.log(fmt("R6 winner", r6Best.r));

    // R7: caf params
    console.log(`\n--- R7: caf BTC mom ---`);
    let r7Best = { cfg: cur, r: r6Best.r };
    const caf = cur.crossAssetFilter;
    if (caf) {
      for (const ms of [0.005, 0.01, 0.02, 0.03, 0.04]) {
        for (const mb of [4, 6, 12, 24]) {
          const cfg = {
            ...cur,
            crossAssetFilter: {
              ...caf,
              momSkipShortAbove: ms,
              momentumBars: mb,
            },
          };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (score(r, r7Best.r) < 0) {
            r7Best = { cfg, r };
            console.log(fmt(`  caf ms=${ms} mb=${mb}`, r));
          }
        }
      }
    }
    cur = r7Best.cfg;
    console.log(fmt("R7 winner", r7Best.r));

    // R8: multi-asset
    console.log(`\n--- R8: multi-asset ---`);
    const ethMr = cur.assets.find((a) => a.symbol === "ETH-MR")!;
    const makeAsset = (sym: string, source: string): Daytrade24hAssetCfg => ({
      ...ethMr,
      symbol: `${sym}-MR`,
      sourceSymbol: source,
      minEquityGain: 0.02,
      triggerBars: 1,
      riskFrac: 1.0,
    });
    let r8Best = { cfg: cur, r: r7Best.r };
    let candidates = ["BNBUSDT", "ADAUSDT"];
    while (true) {
      let stepBest: { cfg: FtmoDaytrade24hConfig; r: any; sym: string } | null =
        null;
      for (const sym of candidates) {
        const trial = {
          ...r8Best.cfg,
          assets: [
            ...r8Best.cfg.assets,
            makeAsset(sym.replace("USDT", ""), sym),
          ],
        };
        const r = runWalkForward(data, trial, TF_HOURS);
        if (score(r, r8Best.r) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0) {
            stepBest = { cfg: trial, r, sym };
          }
        }
      }
      if (stepBest === null) break;
      r8Best = { cfg: stepBest.cfg, r: stepBest.r };
      candidates = candidates.filter((s) => s !== stepBest!.sym);
      console.log(fmt(`  +${stepBest.sym}`, stepBest.r));
    }
    cur = r8Best.cfg;
    console.log(fmt("R8 winner", r8Best.r));

    // R9: drawdown protection
    console.log(`\n--- R9: peakDrawdownThrottle ---`);
    let r9Best = { cfg: cur, r: r8Best.r };
    for (const fp of [0.02, 0.03, 0.04, 0.05]) {
      for (const f of [0, 0.1, 0.25, 0.4]) {
        const cfg = {
          ...cur,
          peakDrawdownThrottle: { fromPeak: fp, factor: f },
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r9Best.r) < 0) {
          r9Best = { cfg, r };
          console.log(fmt(`  pdt fp=${fp} f=${f}`, r));
        }
      }
    }
    cur = r9Best.cfg;
    console.log(fmt("R9 winner", r9Best.r));

    console.log(`\n========== 5m V2 FINAL ==========`);
    console.log(fmt("V1 baseline", curR));
    console.log(fmt("V2 final   ", r9Best.r));
    console.log(
      `Δ V1→V2: +${((r9Best.r.passRate - curR.passRate) * 100).toFixed(2)}pp pass, ${r9Best.r.p90Days - curR.p90Days}d p90`,
    );
    console.log(`\nFinal config:`);
    console.log(
      JSON.stringify(
        {
          atrStop: cur.atrStop,
          lossStreakCooldown: cur.lossStreakCooldown,
          htfTrendFilter: cur.htfTrendFilter,
          chandelierExit: cur.chandelierExit,
          partialTakeProfit: cur.partialTakeProfit,
          timeBoost: cur.timeBoost,
          crossAssetFilter: cur.crossAssetFilter,
          peakDrawdownThrottle: cur.peakDrawdownThrottle,
          allowedHoursUtc: cur.allowedHoursUtc,
          assets: cur.assets.map((a) => a.symbol),
        },
        null,
        2,
      ),
    );
    expect(r9Best.r.passRate).toBeGreaterThan(0);
  });
});
