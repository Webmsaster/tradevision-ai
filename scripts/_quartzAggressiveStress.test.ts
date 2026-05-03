/**
 * Robustness audit: V5_QUARTZ + top-6 + lev=3 (Step 1 champion).
 * TRAIN/TEST split, bootstrap CI, recent regime, NO-PAUSE, cost stress.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;

function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}
function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}
function evaluateRange(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  startBar: number,
  endBar: number,
) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0,
    totalT = 0,
    totalW = 0;
  const days: number[] = [];
  const passVec: number[] = [];
  for (let start = startBar; start + winBars <= endBar; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    passVec.push(res.passed ? 1 : 0);
    if (res.passed) {
      passes++;
      if (res.passDay && res.passDay > 0) days.push(res.passDay);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
    for (const t of res.trades) {
      totalT++;
      if (t.effPnl > 0) totalW++;
    }
  }
  days.sort((a, b) => a - b);
  return {
    windows,
    passes,
    passRate: windows ? passes / windows : 0,
    tl,
    dl,
    passVec,
    avgTradesPerWindow: windows ? totalT / windows : 0,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    wr: totalT > 0 ? totalW / totalT : 0,
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bootstrap(passVec: number[], B: number, seed: number) {
  const rand = rng(seed);
  const means: number[] = [];
  const n = passVec.length;
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += passVec[Math.floor(rand() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return {
    lo: means[Math.floor(B * 0.025)],
    hi: means[Math.floor(B * 0.975)],
    mean: means.reduce((a, b) => a + b, 0) / means.length,
  };
}

describe(
  "V5_QUARTZ Aggressive (top-6 + lev=3) ROBUSTNESS",
  { timeout: 60 * 60_000 },
  () => {
    it("TRAIN/TEST + bootstrap + recent + NO-PAUSE + cost stress", async () => {
      const Q = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ;
      const top6 = (cfg: FtmoDaytrade24hConfig) =>
        cfg.assets.filter((a) =>
          [
            "ETH-TREND",
            "BTC-TREND",
            "BNB-TREND",
            "BCH-TREND",
            "LTC-TREND",
            "ADA-TREND",
          ].includes(a.symbol),
        );
      const championCfg: FtmoDaytrade24hConfig = {
        ...Q,
        leverage: 3,
        assets: top6(Q),
      };

      const symbols = syms(championCfg);
      console.log(`\nLoading ${symbols.length} symbols (30m)...`);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: 100000,
            maxPages: 120,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch {}
      }

      const aligned = alignCommon(data, symbols);
      const n = Math.min(...symbols.map((s) => aligned[s].length));
      const SPLIT = Math.floor(n * 0.7);
      const RECENT = Math.max(0, n - 365 * BARS_PER_DAY);

      console.log(
        `Total bars: ${n}, train: 0..${SPLIT}, test: ${SPLIT}..${n}, recent 1y: ${RECENT}..${n}`,
      );

      // Stress tests
      const cases = [
        { name: "Champion baseline", cfg: championCfg },
        {
          name: "NO-PAUSE",
          cfg: { ...championCfg, pauseAtTargetReached: false },
        },
        {
          name: "cost+slip 2×",
          cfg: {
            ...championCfg,
            assets: championCfg.assets.map((a) => ({
              ...a,
              costBp: (a.costBp ?? 30) * 2,
              slippageBp: (a.slippageBp ?? 8) * 2,
            })),
          },
        },
        {
          name: "cost+slip 3×",
          cfg: {
            ...championCfg,
            assets: championCfg.assets.map((a) => ({
              ...a,
              costBp: (a.costBp ?? 30) * 3,
              slippageBp: (a.slippageBp ?? 8) * 3,
            })),
          },
        },
      ];

      console.log(`\n=== TRAIN/TEST/RECENT SPLIT (champion baseline) ===`);
      const full = evaluateRange(championCfg, data, 0, n);
      const train = evaluateRange(championCfg, data, 0, SPLIT);
      const test = evaluateRange(championCfg, data, SPLIT, n);
      const recent = evaluateRange(championCfg, data, RECENT, n);
      console.log(
        `FULL    ${(full.passRate * 100).toFixed(2)}% (${full.passes}/${full.windows}) wr=${(full.wr * 100).toFixed(1)}% TL=${full.tl} DL=${full.dl} med=${full.med}d p90=${full.p90}d`,
      );
      console.log(
        `TRAIN   ${(train.passRate * 100).toFixed(2)}% (${train.passes}/${train.windows}) wr=${(train.wr * 100).toFixed(1)}% TL=${train.tl} DL=${train.dl} med=${train.med}d p90=${train.p90}d`,
      );
      console.log(
        `TEST    ${(test.passRate * 100).toFixed(2)}% (${test.passes}/${test.windows}) wr=${(test.wr * 100).toFixed(1)}% TL=${test.tl} DL=${test.dl} med=${test.med}d p90=${test.p90}d`,
      );
      console.log(
        `RECENT  ${(recent.passRate * 100).toFixed(2)}% (${recent.passes}/${recent.windows}) wr=${(recent.wr * 100).toFixed(1)}% TL=${recent.tl} DL=${recent.dl} med=${recent.med}d p90=${recent.p90}d`,
      );
      const overfitGap = (train.passRate - test.passRate) * 100;
      console.log(
        `Overfit gap (TRAIN-TEST): ${overfitGap >= 0 ? "+" : ""}${overfitGap.toFixed(2)}pp`,
      );

      const bs = bootstrap(full.passVec, 1000, 20260429);
      console.log(
        `Bootstrap 95% CI [${(bs.lo * 100).toFixed(2)}%, ${(bs.hi * 100).toFixed(2)}%] mean ${(bs.mean * 100).toFixed(2)}%`,
      );

      console.log(`\n=== STRESS TESTS ===`);
      console.log(`${"variant".padEnd(20)} 3d-pass    med   p90  TL%   DL%`);
      for (const c of cases) {
        const r = evaluateRange(c.cfg, data, 0, n);
        const tlPct = r.windows ? ((r.tl / r.windows) * 100).toFixed(2) : "—";
        const dlPct = r.windows ? ((r.dl / r.windows) * 100).toFixed(2) : "—";
        const star = r.passRate >= 0.55 ? " ✓55%+" : "";
        console.log(
          `${c.name.padEnd(20)} ${(r.passRate * 100).toFixed(2).padStart(7)}% ${String(r.med).padStart(2)}d  ${String(r.p90).padStart(2)}d  ${tlPct.padStart(5)}% ${dlPct.padStart(5)}%${star}`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
