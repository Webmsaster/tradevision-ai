/**
 * Stress-test the V261/V7 champions: TRAIN/TEST OOS split, bootstrap CI,
 * recent-regime sub-sample.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY: Record<string, number> = { "30m": 48, "1h": 24, "2h": 12 };

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
  bpd: number,
  stepDays: number,
) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const winBars = cfg.maxDays * bpd;
  const stepBars = stepDays * bpd;
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

const VARIANTS = [
  ["V261_2H_OPT", FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT, "2h"],
  ["V7_1H_OPT", FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT, "1h"],
  ["V10_30M_OPT", FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT, "30m"],
  ["V12_30M_OPT", FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT, "30m"],
] as Array<[string, FtmoDaytrade24hConfig, string]>;

describe("V7/V261 champions stress test", { timeout: 30 * 60_000 }, () => {
  it("TRAIN/TEST split + bootstrap CI + recent regime", async () => {
    const allSyms = [
      ...new Set(VARIANTS.flatMap(([, cfg]) => syms(cfg))),
    ].sort();
    console.log(`\nLoading ${allSyms.length} symbols (30m/1h/2h)...`);
    const dataMap: Record<string, Record<string, Candle[]>> = {
      "30m": {},
      "1h": {},
      "2h": {},
    };
    for (const s of allSyms) {
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "30m",
          targetCount: 100000,
          maxPages: 120,
        });
        dataMap["30m"][s] = r.filter((c) => c.isFinal);
      } catch {}
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "1h",
          targetCount: 60000,
          maxPages: 80,
        });
        dataMap["1h"][s] = r.filter((c) => c.isFinal);
      } catch {}
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        dataMap["2h"][s] = r.filter((c) => c.isFinal);
      } catch {}
    }

    for (const [name, cfg, dataTf] of VARIANTS) {
      const data = dataMap[dataTf];
      const symbols = syms(cfg);
      const aligned = alignCommon(data, symbols);
      const n = Math.min(...symbols.map((s) => aligned[s].length));
      const bpd = BARS_PER_DAY[dataTf];
      const SPLIT = Math.floor(n * 0.7);
      const RECENT = Math.max(0, n - 365 * bpd); // last 1yr

      console.log(
        `\n=== ${name} (TF=${dataTf}, total bars=${n}, train=0..${SPLIT}, test=${SPLIT}..${n}) ===`,
      );
      const full = evaluateRange(cfg, data, 0, n, bpd, 3);
      const train = evaluateRange(cfg, data, 0, SPLIT, bpd, 3);
      const test = evaluateRange(cfg, data, SPLIT, n, bpd, 3);
      const recent = evaluateRange(cfg, data, RECENT, n, bpd, 3);

      console.log(
        `FULL    pass=${(full.passRate * 100).toFixed(2)}% (${full.passes}/${full.windows}) wr=${(full.wr * 100).toFixed(2)}% TL=${full.tl} DL=${full.dl} med=${full.med}d p90=${full.p90}d`,
      );
      console.log(
        `TRAIN   pass=${(train.passRate * 100).toFixed(2)}% (${train.passes}/${train.windows}) wr=${(train.wr * 100).toFixed(2)}% TL=${train.tl} DL=${train.dl} med=${train.med}d p90=${train.p90}d`,
      );
      console.log(
        `TEST    pass=${(test.passRate * 100).toFixed(2)}% (${test.passes}/${test.windows}) wr=${(test.wr * 100).toFixed(2)}% TL=${test.tl} DL=${test.dl} med=${test.med}d p90=${test.p90}d`,
      );
      console.log(
        `RECENT  pass=${(recent.passRate * 100).toFixed(2)}% (${recent.passes}/${recent.windows}) wr=${(recent.wr * 100).toFixed(2)}% TL=${recent.tl} DL=${recent.dl} med=${recent.med}d p90=${recent.p90}d`,
      );
      const overfitGap = (train.passRate - test.passRate) * 100;
      console.log(
        `Overfit gap (TRAIN - TEST): ${overfitGap >= 0 ? "+" : ""}${overfitGap.toFixed(2)}pp`,
      );

      const bs = bootstrap(full.passVec, 1000, 20260429);
      console.log(
        `Bootstrap 95% CI [${(bs.lo * 100).toFixed(2)}%, ${(bs.hi * 100).toFixed(2)}%] mean ${(bs.mean * 100).toFixed(2)}%`,
      );
    }

    expect(true).toBe(true);
  });
});
