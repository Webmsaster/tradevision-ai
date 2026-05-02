/**
 * Round 28 — Push V5_QUARTZ_LITE_R28 toward 80% under liveMode=true.
 *
 * Baseline: R28 = 71.28% on 5.71y / 665w / 30m / liveMode=true / liveCaps 5%/40%.
 *
 * Aggressive sweep dimensions (combinatorial subset, 30+ variants):
 *   1. challengePeakTrailingStop {undef, 0.06, 0.07, 0.08}
 *   2. atrStop {p56m2 (current), p28m2, p84m1.5, undef}
 *   3. minTradingDays {3, 4, 5}
 *   4. lossStreakCooldown {undef, {2, 100}, {3, 200}}
 *   5. holdBars {240, 600, 1200}
 *   6. asset adders: try +INJ / +RUNE / +AVAX / +SAND
 *
 * Run: node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts \
 *   scripts/_round28PushTo80.test.ts --reporter=verbose > /tmp/round28_push80.log 2>&1
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

type AssetCfg = FtmoDaytrade24hConfig["assets"][number];

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

// Pull asset configs (with V5_QUARTZ stack: TPs, riskFrac, etc.) for the 4 candidates.
function getQuartzAssetByName(name: string): AssetCfg | undefined {
  return FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ.assets.find(
    (a) => a.symbol === name,
  );
}

interface Variant {
  id: string;
  cfg: FtmoDaytrade24hConfig;
}

function buildVariants(): Variant[] {
  const baseR28 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28;
  const variants: Variant[] = [];

  // Asset add-back candidates (pull configs from V5_QUARTZ — they exist there).
  const inj = getQuartzAssetByName("INJ-TREND");
  const rune = getQuartzAssetByName("RUNE-TREND");
  const avax = getQuartzAssetByName("AVAX-TREND");
  const sand = getQuartzAssetByName("SAND-TREND");

  type AdderId = "" | "+INJ" | "+RUNE" | "+AVAX" | "+SAND";
  const adders: { id: AdderId; assets: AssetCfg[] }[] = [
    { id: "", assets: [] },
    { id: "+INJ", assets: inj ? [inj] : [] },
    { id: "+RUNE", assets: rune ? [rune] : [] },
    { id: "+AVAX", assets: avax ? [avax] : [] },
    { id: "+SAND", assets: sand ? [sand] : [] },
  ];

  // 0) Pure baseline R28 (sanity)
  variants.push({
    id: "R28-baseline",
    cfg: { ...baseR28, liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 } },
  });

  // 1) challengePeakTrailingStop sweep (TL-mitigation), keep R28 base
  for (const cpts of [0.06, 0.07, 0.08]) {
    variants.push({
      id: `cpts${cpts}`,
      cfg: {
        ...baseR28,
        challengePeakTrailingStop: { trailDistance: cpts },
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
    });
  }

  // 2) atrStop variants
  const atrVariants: Array<{
    id: string;
    atr?: { period: number; stopMult: number };
  }> = [
    { id: "atr-p28m2", atr: { period: 28, stopMult: 2 } },
    { id: "atr-p84m1.5", atr: { period: 84, stopMult: 1.5 } },
    { id: "atr-undef" }, // no atrStop override; still has chandelier from QUARTZ
  ];
  for (const v of atrVariants) {
    const cfg: FtmoDaytrade24hConfig = {
      ...baseR28,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    };
    if (v.atr) cfg.atrStop = v.atr;
    else delete (cfg as Partial<FtmoDaytrade24hConfig>).atrStop;
    variants.push({ id: v.id, cfg });
  }

  // 3) minTradingDays sweep
  for (const mtd of [3, 5]) {
    variants.push({
      id: `mtd${mtd}`,
      cfg: {
        ...baseR28,
        minTradingDays: mtd,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
    });
  }

  // 4) lossStreakCooldown sweep
  variants.push({
    id: "lsc-2-100",
    cfg: {
      ...baseR28,
      lossStreakCooldown: { afterLosses: 2, cooldownBars: 100 },
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    },
  });
  variants.push({
    id: "lsc-3-200",
    cfg: {
      ...baseR28,
      lossStreakCooldown: { afterLosses: 3, cooldownBars: 200 },
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    },
  });

  // 5) holdBars sweep (R28 inherits 240 from V5_QUARTZ via per-asset)
  for (const hb of [600, 1200]) {
    variants.push({
      id: `hb${hb}`,
      cfg: {
        ...baseR28,
        assets: baseR28.assets.map((a) => ({ ...a, holdBars: hb })),
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
    });
  }

  // 6) Asset adders alone
  for (const adder of adders.slice(1)) {
    if (adder.assets.length === 0) continue;
    variants.push({
      id: `add${adder.id}`,
      cfg: {
        ...baseR28,
        assets: [...baseR28.assets, ...adder.assets],
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
    });
  }

  // 7) Combo: cpts + lsc (TL-mitigation stack)
  for (const cpts of [0.06, 0.07, 0.08]) {
    variants.push({
      id: `cpts${cpts}+lsc-2-100`,
      cfg: {
        ...baseR28,
        challengePeakTrailingStop: { trailDistance: cpts },
        lossStreakCooldown: { afterLosses: 2, cooldownBars: 100 },
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
    });
  }

  // 8) Combo: cpts + adder (best TL-mit + signal-volume)
  for (const cpts of [0.07, 0.08]) {
    for (const adder of adders.slice(1)) {
      if (adder.assets.length === 0) continue;
      variants.push({
        id: `cpts${cpts}${adder.id}`,
        cfg: {
          ...baseR28,
          challengePeakTrailingStop: { trailDistance: cpts },
          assets: [...baseR28.assets, ...adder.assets],
          liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        },
      });
    }
  }

  // 9) Combo: cpts + atr-p84m1.5 (slow-stop stack)
  for (const cpts of [0.07, 0.08]) {
    variants.push({
      id: `cpts${cpts}+atrP84m1.5`,
      cfg: {
        ...baseR28,
        challengePeakTrailingStop: { trailDistance: cpts },
        atrStop: { period: 84, stopMult: 1.5 },
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
    });
  }

  // 10) Triple combo: cpts + lsc + adder
  for (const cpts of [0.07, 0.08]) {
    for (const adder of [adders[1], adders[4]]) {
      // +INJ, +SAND
      if (adder.assets.length === 0) continue;
      variants.push({
        id: `cpts${cpts}+lsc-2-100${adder.id}`,
        cfg: {
          ...baseR28,
          challengePeakTrailingStop: { trailDistance: cpts },
          lossStreakCooldown: { afterLosses: 2, cooldownBars: 100 },
          assets: [...baseR28.assets, ...adder.assets],
          liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        },
      });
    }
  }

  // 11) Aggressive: cpts + lsc + atr-p84m1.5
  variants.push({
    id: "cpts0.07+lsc-2-100+atrP84m1.5",
    cfg: {
      ...baseR28,
      challengePeakTrailingStop: { trailDistance: 0.07 },
      lossStreakCooldown: { afterLosses: 2, cooldownBars: 100 },
      atrStop: { period: 84, stopMult: 1.5 },
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    },
  });

  return variants;
}

interface Result {
  id: string;
  passPct: number;
  passN: number;
  total: number;
  medDay: number;
  tlPct: number;
  dlPct: number;
}

describe(
  "Round 28 — push V5_QUARTZ_LITE_R28 toward 80%",
  { timeout: 240 * 60_000 },
  () => {
    it("aggressive combinatorial sweep", async () => {
      const variants = buildVariants();
      console.log(`\nBuilt ${variants.length} variants.\n`);

      // Symbol union across all variants — load each once.
      const allSymbols = new Set<string>();
      for (const v of variants) for (const s of syms(v.cfg)) allSymbols.add(s);
      const symbols = [...allSymbols].sort();
      console.log(
        `Loading ${symbols.length} symbols (30m): ${symbols.join(", ")}`,
      );

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
        } catch (e) {
          console.warn(`Failed loading ${s}: ${e}`);
        }
      }

      function runVariant(v: Variant): Result {
        const vSymbols = syms(v.cfg);
        const subData: Record<string, Candle[]> = {};
        for (const s of vSymbols) subData[s] = data[s] ?? [];
        const aligned = alignCommon(subData, vSymbols);
        const minBars = Math.min(
          ...vSymbols.map((s) => aligned[s]?.length ?? 0),
        );
        const bpd = 48;
        const winBars = v.cfg.maxDays * bpd;
        const stepBars = 3 * bpd;

        let pass = 0;
        let total = 0;
        let tl = 0;
        let dl = 0;
        const days: number[] = [];
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of vSymbols)
            slice[s] = aligned[s].slice(start, start + winBars);
          const res = runFtmoDaytrade24h(slice, v.cfg);
          total++;
          if (res.passed) {
            pass++;
            days.push(res.passDay ?? 0);
          }
          if (res.reason === "total_loss") tl++;
          if (res.reason === "daily_loss") dl++;
        }
        days.sort((a, b) => a - b);
        const med = days.length ? days[Math.floor(days.length / 2)] : 0;
        return {
          id: v.id,
          passPct: total > 0 ? (pass / total) * 100 : 0,
          passN: pass,
          total,
          medDay: med,
          tlPct: total > 0 ? (tl / total) * 100 : 0,
          dlPct: total > 0 ? (dl / total) * 100 : 0,
        };
      }

      const results: Result[] = [];
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        const r = runVariant(v);
        results.push(r);
        console.log(
          `[${i + 1}/${variants.length}] ${r.id.padEnd(40)} pass=${r.passPct.toFixed(2)}% (${r.passN}/${r.total}) med=${r.medDay}d TL=${r.tlPct.toFixed(2)}% DL=${r.dlPct.toFixed(2)}%`,
        );
      }

      results.sort((a, b) => b.passPct - a.passPct);

      console.log(`\n=== TOP 20 (sorted by pass-rate) ===`);
      for (const r of results.slice(0, 20)) {
        console.log(
          `TOP ${r.id.padEnd(40)} pass=${r.passPct.toFixed(2)}% (${r.passN}/${r.total}) med=${r.medDay}d TL=${r.tlPct.toFixed(2)}% DL=${r.dlPct.toFixed(2)}%`,
        );
      }

      const best = results[0];
      console.log(
        `\nBEST: ${best.id} → ${best.passPct.toFixed(2)}% (gap to 80%: ${(80 - best.passPct).toFixed(2)}pp)`,
      );
      if (best.passPct >= 80) {
        console.log(`>>> 80% achieved with ${best.id} <<<`);
      } else {
        console.log(
          `>>> 80% NOT achieved — closest ${best.id} ${best.passPct.toFixed(2)}% <<<`,
        );
      }

      expect(results.length).toBeGreaterThan(0);
    });
  },
);
