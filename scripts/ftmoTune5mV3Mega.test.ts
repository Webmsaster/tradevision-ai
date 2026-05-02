/**
 * 5m V3 MEGA SWEEP — try EVERYTHING.
 *
 * V2 was 71.09%. We want 90%. Need +19pp. Trying every remaining engine
 * feature: volatilityFilter, breakEven, drawdownShield, dailyGainCap,
 * adaptiveSizing tier extension, kellySizing, per-asset overrides,
 * triggerBars, more assets (LINK/ADA/AVAX/MATIC/DOGE/XRP/LTC/DOT/BCH).
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V2,
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

const EXTRA_ASSETS = [
  "LINKUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "XRPUSDT",
  "LTCUSDT",
] as const;

describe("5m V3 MEGA — push toward 90%", { timeout: 3000_000 }, () => {
  it("tries every remaining axis", async () => {
    const targetCount = 700000;
    const maxPages = 700;
    console.log(`Loading 5m history for many assets...`);
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
    const extra: Record<string, Candle[]> = {};
    for (const sym of EXTRA_ASSETS) {
      extra[sym] = await loadBinanceHistory({
        symbol: sym,
        timeframe: "5m",
        targetCount,
        maxPages,
      });
      console.log(`  ${sym}: ${extra[sym].length} bars`);
    }
    const lengths = [
      eth.length,
      btc.length,
      sol.length,
      bnb.length,
      ...EXTRA_ASSETS.map((s) => extra[s].length),
    ];
    const n = Math.min(...lengths);
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
      BNBUSDT: bnb.slice(-n),
    };
    for (const sym of EXTRA_ASSETS) data[sym] = extra[sym].slice(-n);
    console.log(`Aligned: ${n} bars (${(n / 288 / 365).toFixed(2)}y)\n`);

    let cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V2,
      liveCaps: LIVE_CAPS,
    };
    let curR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V2 BASELINE", curR));

    // R1: per-asset triggerBars
    console.log(`\n--- R1: per-asset triggerBars ---`);
    let r1Best = { cfg: cur, r: curR };
    for (const eth_t of [1, 2]) {
      for (const btc_t of [1, 2, 3]) {
        for (const sol_t of [1, 2]) {
          for (const bnb_t of [1, 2]) {
            const cfg: FtmoDaytrade24hConfig = {
              ...cur,
              assets: cur.assets.map((a) => {
                if (a.symbol === "ETH-MR") return { ...a, triggerBars: eth_t };
                if (a.symbol === "BTC-MR") return { ...a, triggerBars: btc_t };
                if (a.symbol === "SOL-MR") return { ...a, triggerBars: sol_t };
                if (a.symbol === "BNB-MR") return { ...a, triggerBars: bnb_t };
                return a;
              }),
            };
            const r = runWalkForward(data, cfg, TF_HOURS);
            if (score(r, r1Best.r) < 0) {
              r1Best = { cfg, r };
              console.log(fmt(`  E${eth_t} B${btc_t} S${sol_t} N${bnb_t}`, r));
            }
          }
        }
      }
    }
    cur = r1Best.cfg;
    console.log(fmt("R1 winner", r1Best.r));

    // R2: ETH-MR per-asset stopPct/tpPct
    console.log(`\n--- R2: ETH-MR stopPct × tpPct ---`);
    let r2Best = { cfg: cur, r: r1Best.r };
    for (const sp of [0.005, 0.008, 0.012, 0.018, 0.025]) {
      for (const tp of [0.01, 0.015, 0.02, 0.025, 0.03, 0.04]) {
        const cfg = {
          ...cur,
          assets: cur.assets.map((a) =>
            a.symbol === "ETH-MR" ? { ...a, stopPct: sp, tpPct: tp } : a,
          ),
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r2Best.r) < 0) {
          r2Best = { cfg, r };
          console.log(fmt(`  ETH sp=${sp} tp=${tp}`, r));
        }
      }
    }
    cur = r2Best.cfg;
    console.log(fmt("R2 winner", r2Best.r));

    // R3: BTC/SOL minEquityGain
    console.log(`\n--- R3: BTC/SOL gates ---`);
    let r3Best = { cfg: cur, r: r2Best.r };
    for (const gate of [0.005, 0.01, 0.02, 0.03, 0.04, 0.05]) {
      const cfg = {
        ...cur,
        assets: cur.assets.map((a) =>
          a.symbol === "BTC-MR" || a.symbol === "SOL-MR"
            ? { ...a, minEquityGain: gate }
            : a,
        ),
      };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, r3Best.r) < 0) {
        r3Best = { cfg, r };
        console.log(fmt(`  BTC/SOL gate=${gate}`, r));
      }
    }
    cur = r3Best.cfg;
    console.log(fmt("R3 winner", r3Best.r));

    // R4: adaptiveSizing tier extension (negative-equity)
    console.log(`\n--- R4: adaptiveSizing extended ---`);
    let r4Best = { cfg: cur, r: r3Best.r };
    const tierVariants = [
      { label: "current", tiers: cur.adaptiveSizing ?? [] },
      {
        label: "+dd-3%/0.2",
        tiers: [
          { equityAbove: -0.03, factor: 0.2 },
          ...(cur.adaptiveSizing ?? []),
        ],
      },
      {
        label: "+dd-2%/0.3",
        tiers: [
          { equityAbove: -0.02, factor: 0.3 },
          ...(cur.adaptiveSizing ?? []),
        ],
      },
      {
        label: "+dd-4%/0.1",
        tiers: [
          { equityAbove: -0.04, factor: 0.1 },
          ...(cur.adaptiveSizing ?? []),
        ],
      },
      {
        label: "granular",
        tiers: [
          { equityAbove: -0.04, factor: 0.1 },
          { equityAbove: -0.025, factor: 0.25 },
          { equityAbove: -0.01, factor: 0.4 },
          ...(cur.adaptiveSizing ?? []),
        ],
      },
    ];
    for (const v of tierVariants) {
      const cfg = { ...cur, adaptiveSizing: v.tiers };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, r4Best.r) < 0) {
        r4Best = { cfg, r };
        console.log(fmt(`  ${v.label}`, r));
      }
    }
    cur = r4Best.cfg;
    console.log(fmt("R4 winner", r4Best.r));

    // R5: volatilityFilter
    console.log(`\n--- R5: volatilityFilter ---`);
    let r5Best = { cfg: cur, r: r4Best.r };
    for (const period of [14, 28, 84]) {
      for (const minAtr of [undefined, 0.001, 0.002]) {
        for (const maxAtr of [0.01, 0.015, 0.02, 0.03, undefined]) {
          if (minAtr === undefined && maxAtr === undefined) continue;
          const cfg = {
            ...cur,
            volatilityFilter: {
              period,
              minAtrFrac: minAtr,
              maxAtrFrac: maxAtr,
            },
          };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (score(r, r5Best.r) < 0) {
            r5Best = { cfg, r };
            console.log(fmt(`  vol p${period} ${minAtr}/${maxAtr}`, r));
          }
        }
      }
    }
    cur = r5Best.cfg;
    console.log(fmt("R5 winner", r5Best.r));

    // R6: breakEven
    console.log(`\n--- R6: breakEven ---`);
    let r6Best = { cfg: cur, r: r5Best.r };
    for (const thr of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03]) {
      const cfg = { ...cur, breakEven: { threshold: thr } };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, r6Best.r) < 0) {
        r6Best = { cfg, r };
        console.log(fmt(`  BE thr=${thr}`, r));
      }
    }
    cur = r6Best.cfg;
    console.log(fmt("R6 winner", r6Best.r));

    // R7: kellySizing
    console.log(`\n--- R7: kellySizing ---`);
    let r7Best = { cfg: cur, r: r6Best.r };
    const kVar = [
      { label: "off", ks: undefined },
      {
        label: "5/[0.5/0.7,0.65/1.3]",
        ks: {
          minTrades: 5,
          windowSize: 20,
          tiers: [
            { winRateAbove: 0.5, multiplier: 0.7 },
            { winRateAbove: 0.65, multiplier: 1.3 },
          ],
        },
      },
      {
        label: "10/[0.5/0.5,0.6/1,0.7/1.5]",
        ks: {
          minTrades: 10,
          windowSize: 30,
          tiers: [
            { winRateAbove: 0.5, multiplier: 0.5 },
            { winRateAbove: 0.6, multiplier: 1 },
            { winRateAbove: 0.7, multiplier: 1.5 },
          ],
        },
      },
      {
        label: "5/[0.5/1,0.7/1.5]",
        ks: {
          minTrades: 5,
          windowSize: 20,
          tiers: [
            { winRateAbove: 0.5, multiplier: 1 },
            { winRateAbove: 0.7, multiplier: 1.5 },
          ],
        },
      },
    ];
    for (const v of kVar) {
      const cfg = { ...cur, kellySizing: v.ks };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, r7Best.r) < 0) {
        r7Best = { cfg, r };
        console.log(fmt(`  kelly ${v.label}`, r));
      }
    }
    cur = r7Best.cfg;
    console.log(fmt("R7 winner", r7Best.r));

    // R8: more multi-asset (greedy)
    console.log(`\n--- R8: greedy add more assets ---`);
    let r8Best = { cfg: cur, r: r7Best.r };
    const ethRef = cur.assets.find((a) => a.symbol === "ETH-MR")!;
    const makeAsset = (sym: string): Daytrade24hAssetCfg => ({
      ...ethRef,
      symbol: `${sym.replace("USDT", "")}-MR`,
      sourceSymbol: sym,
      minEquityGain: 0.02,
      triggerBars: 1,
      riskFrac: 1.0,
    });
    let candidates = [...EXTRA_ASSETS];
    while (true) {
      let stepBest: { cfg: FtmoDaytrade24hConfig; r: any; sym: string } | null =
        null;
      for (const sym of candidates) {
        const trial = {
          ...r8Best.cfg,
          assets: [...r8Best.cfg.assets, makeAsset(sym)],
        };
        const r = runWalkForward(data, trial, TF_HOURS);
        if (score(r, r8Best.r) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0)
            stepBest = { cfg: trial, r, sym };
        }
      }
      if (stepBest === null) break;
      r8Best = { cfg: stepBest.cfg, r: stepBest.r };
      candidates = candidates.filter((s) => s !== stepBest!.sym);
      console.log(fmt(`  +${stepBest.sym}`, stepBest.r));
    }
    cur = r8Best.cfg;
    console.log(fmt("R8 winner", r8Best.r));

    // R9: drawdownShield
    console.log(`\n--- R9: drawdownShield ---`);
    let r9Best = { cfg: cur, r: r8Best.r };
    for (const be of [-0.04, -0.03, -0.02, -0.01]) {
      for (const f of [0, 0.1, 0.25, 0.4]) {
        const cfg = { ...cur, drawdownShield: { belowEquity: be, factor: f } };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r9Best.r) < 0) {
          r9Best = { cfg, r };
          console.log(fmt(`  dds be=${be} f=${f}`, r));
        }
      }
    }
    cur = r9Best.cfg;
    console.log(fmt("R9 winner", r9Best.r));

    // R10: tpPct global
    console.log(`\n--- R10: global tpPct ---`);
    let r10Best = { cfg: cur, r: r9Best.r };
    for (const tp of [
      0.005, 0.008, 0.01, 0.012, 0.015, 0.018, 0.022, 0.025, 0.03,
    ]) {
      const cfg = { ...cur, tpPct: tp };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, r10Best.r) < 0) {
        r10Best = { cfg, r };
        console.log(fmt(`  tpPct=${tp}`, r));
      }
    }
    cur = r10Best.cfg;
    console.log(fmt("R10 winner", r10Best.r));

    // R11: holdBars
    console.log(`\n--- R11: holdBars ---`);
    let r11Best = { cfg: cur, r: r10Best.r };
    for (const hb of [1200, 2400, 3600, 4800, 7200, 10000]) {
      const cfg = { ...cur, holdBars: hb };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, r11Best.r) < 0) {
        r11Best = { cfg, r };
        console.log(fmt(`  hb=${hb}`, r));
      }
    }
    cur = r11Best.cfg;
    console.log(fmt("R11 winner", r11Best.r));

    console.log(`\n========== 5m V3 MEGA FINAL ==========`);
    console.log(fmt("V2 baseline", curR));
    console.log(fmt("V3 final   ", r11Best.r));
    console.log(
      `Δ V2→V3: +${((r11Best.r.passRate - curR.passRate) * 100).toFixed(2)}pp pass, ${r11Best.r.p90Days - curR.p90Days}d p90`,
    );
    console.log(
      `Distance to 90%: ${(0.9 - (r11Best.r.passRate * 100) / 100).toFixed(4)}`,
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
          adaptiveSizing: cur.adaptiveSizing,
          volatilityFilter: cur.volatilityFilter,
          breakEven: cur.breakEven,
          kellySizing: cur.kellySizing,
          drawdownShield: cur.drawdownShield,
          tpPct: cur.tpPct,
          holdBars: cur.holdBars,
          allowedHoursUtc: cur.allowedHoursUtc,
          assets: cur.assets.map((a) => a.symbol),
        },
        null,
        2,
      ),
    );
    expect(r11Best.r.passRate).toBeGreaterThan(0);
  });
});
