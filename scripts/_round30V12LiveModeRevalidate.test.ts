/**
 * Round 30 — V12_30M_OPT liveMode=true re-validation.
 *
 * Pre-Round-28 V12 numbers (95.09% / TL 18% / med 5d) used the engine's
 * EXIT-time sort, which has ~14pp lookahead bias (Round 28 finding).
 *
 * This test measures the HONEST V12 pass-rate under liveMode=true (entry-time
 * sort, live-fair). Compares V12 + V12_TURBO + V261_2H_OPT side-by-side.
 *
 * Goal: pick the single best Python-deployable bot under honest backtest.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

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

type Variant = {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  tf: "30m" | "2h";
};

describe(
  "Round 30 — V12 / V12_TURBO / V261 liveMode=true re-validation",
  { timeout: 120 * 60_000 },
  () => {
    const variants: Variant[] = [
      {
        name: "V12_30M_OPT",
        cfg: FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
        tf: "30m",
      },
      {
        name: "V12_TURBO_30M_OPT",
        cfg: FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
        tf: "30m",
      },
      {
        name: "V261_2H_OPT",
        cfg: FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
        tf: "2h",
      },
    ];

    for (const v of variants) {
      it(`${v.name} liveMode false vs true`, async () => {
        const cfgFalse: FtmoDaytrade24hConfig = {
          ...v.cfg,
          liveMode: false,
          liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        };
        const cfgTrue: FtmoDaytrade24hConfig = {
          ...v.cfg,
          liveMode: true,
          liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        };

        const symbols = syms(v.cfg);
        const data: Record<string, Candle[]> = {};
        for (const s of symbols) {
          try {
            const r = await loadBinanceHistory({
              symbol: s,
              timeframe: v.tf,
              targetCount: 100000,
              maxPages: 120,
            });
            data[s] = r.filter((c) => c.isFinal);
          } catch {}
        }
        const aligned = alignCommon(data, symbols);
        const minBars = Math.min(
          ...symbols.map((s) => aligned[s]?.length ?? 0),
        );
        const bpd = v.tf === "30m" ? 48 : 12;
        const winBars = v.cfg.maxDays * bpd;
        const stepBars = 3 * bpd;
        const ts0 = aligned[symbols[0]][0].openTime;
        const lastTs = aligned[symbols[0]][minBars - 1].openTime;
        const years = ((lastTs - ts0) / (365 * 24 * 3600_000)).toFixed(2);

        console.log(`\n=== ${v.name} (${v.tf}) ===`);
        console.log(
          `Data: ${minBars} bars / ${years}y / ${symbols.length} assets`,
        );

        type WR = { passed: boolean; passDay: number; reason: string };
        function runWindows(c: FtmoDaytrade24hConfig): WR[] {
          const out: WR[] = [];
          for (let start = 0; start + winBars <= minBars; start += stepBars) {
            const slice: Record<string, Candle[]> = {};
            for (const s of symbols)
              slice[s] = aligned[s].slice(start, start + winBars);
            const res = runFtmoDaytrade24h(slice, c);
            out.push({
              passed: res.passed,
              passDay: res.passDay ?? 0,
              reason: res.reason,
            });
          }
          return out;
        }

        const resFalse = runWindows(cfgFalse);
        const resTrue = runWindows(cfgTrue);

        const passFalse = resFalse.filter((w) => w.passed).length;
        const passTrue = resTrue.filter((w) => w.passed).length;
        const tlFalse = resFalse.filter((w) =>
          w.reason?.includes("total_loss"),
        ).length;
        const tlTrue = resTrue.filter((w) =>
          w.reason?.includes("total_loss"),
        ).length;

        const medFalse = (() => {
          const ds = resFalse
            .filter((w) => w.passed && w.passDay > 0)
            .map((w) => w.passDay)
            .sort((a, b) => a - b);
          return ds[Math.floor(ds.length / 2)] ?? 0;
        })();
        const medTrue = (() => {
          const ds = resTrue
            .filter((w) => w.passed && w.passDay > 0)
            .map((w) => w.passDay)
            .sort((a, b) => a - b);
          return ds[Math.floor(ds.length / 2)] ?? 0;
        })();

        const N = resFalse.length;
        console.log(
          `liveMode=false: ${passFalse}/${N} = ${((passFalse / N) * 100).toFixed(2)}% / med ${medFalse}d / TL ${((tlFalse / N) * 100).toFixed(2)}%`,
        );
        console.log(
          `liveMode=true:  ${passTrue}/${N} = ${((passTrue / N) * 100).toFixed(2)}% / med ${medTrue}d / TL ${((tlTrue / N) * 100).toFixed(2)}%`,
        );
        console.log(
          `drift: ${(((passTrue - passFalse) / N) * 100).toFixed(2)}pp`,
        );

        expect(N).toBeGreaterThan(50);
      });
    }
  },
);
