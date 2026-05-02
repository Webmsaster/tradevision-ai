/**
 * Round 28 — Drop-AAVE under liveMode=true (engine-only, fast).
 *
 * Tests V5_QUARTZ_LITE asset subsets under both liveMode=false (default
 * exit-time sort, lookahead-inflated) and liveMode=true (entry-time sort,
 * live-fair). Faster than V4 simulator since it uses the bulk-sim engine.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;

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

function makeVariant(
  name: string,
  keepSymbols: string[],
): { name: string; cfg: FtmoDaytrade24hConfig } {
  return {
    name,
    cfg: {
      ...BASE,
      assets: BASE.assets.filter((a) => keepSymbols.includes(a.symbol)),
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    },
  };
}

const VARIANTS = [
  makeVariant("Q_LITE_FULL_9", [
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "ADA-TREND",
    "LTC-TREND",
    "BCH-TREND",
    "ETC-TREND",
    "XRP-TREND",
    "AAVE-TREND",
  ]),
  makeVariant("Q_LITE_NO_AAVE_8", [
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "ADA-TREND",
    "LTC-TREND",
    "BCH-TREND",
    "ETC-TREND",
    "XRP-TREND",
  ]),
  makeVariant("Q_LITE_NO_AAVE_LTC_XRP_6", [
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "ADA-TREND",
    "BCH-TREND",
    "ETC-TREND",
  ]),
  makeVariant("Q_LITE_TOP5", [
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "BCH-TREND",
    "ETC-TREND",
  ]),
  makeVariant("Q_LITE_HIGH_MOM_4", [
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "BCH-TREND",
  ]),
];

describe(
  "Round 28 — Drop-AAVE under liveMode=true (engine)",
  { timeout: 30 * 60_000 },
  () => {
    it("compare liveMode=false vs liveMode=true for asset subsets", async () => {
      const allSyms = new Set<string>();
      for (const v of VARIANTS) for (const s of syms(v.cfg)) allSyms.add(s);
      const data: Record<string, Candle[]> = {};
      for (const s of allSyms) {
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

      type R = {
        name: string;
        mF: number;
        mT: number;
        drift: number;
        tlF: number;
        tlT: number;
        medF: number;
        medT: number;
      };
      const results: R[] = [];

      for (const v of VARIANTS) {
        const cfgF: FtmoDaytrade24hConfig = { ...v.cfg };
        const cfgT: FtmoDaytrade24hConfig = {
          ...v.cfg,
          liveMode: true,
        } as FtmoDaytrade24hConfig;
        const symbols = syms(v.cfg);
        const aligned = alignCommon(data, symbols);
        const minBars = Math.min(
          ...symbols.map((s) => aligned[s]?.length ?? 0),
        );
        const bpd = 48;
        const winBars = v.cfg.maxDays * bpd;
        const stepBars = 3 * bpd;

        let wF = 0,
          pF = 0,
          tlF = 0;
        let wT = 0,
          pT = 0,
          tlT = 0;
        const dF: number[] = [];
        const dT: number[] = [];

        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of symbols)
            slice[s] = aligned[s].slice(start, start + winBars);

          const rF = runFtmoDaytrade24h(slice, cfgF);
          wF++;
          if (rF.passed) {
            pF++;
            if (rF.passDay) dF.push(rF.passDay);
          } else if (rF.reason === "total_loss") tlF++;

          const rT = runFtmoDaytrade24h(slice, cfgT);
          wT++;
          if (rT.passed) {
            pT++;
            if (rT.passDay) dT.push(rT.passDay);
          } else if (rT.reason === "total_loss") tlT++;
        }
        dF.sort((a, b) => a - b);
        dT.sort((a, b) => a - b);
        const medF = dF[Math.floor(dF.length / 2)] ?? 0;
        const medT = dT[Math.floor(dT.length / 2)] ?? 0;
        const mF = (pF / wF) * 100;
        const mT = (pT / wT) * 100;
        results.push({
          name: v.name,
          mF,
          mT,
          drift: mT - mF,
          tlF: (tlF / wF) * 100,
          tlT: (tlT / wT) * 100,
          medF,
          medT,
        });
        console.log(
          `\n=== ${v.name} (${v.cfg.assets.length} assets, ${minBars} bars) ===`,
        );
        console.log(
          `  liveMode=false: ${pF}/${wF} = ${mF.toFixed(2)}% / med=${medF}d / TL=${((tlF / wF) * 100).toFixed(2)}%`,
        );
        console.log(
          `  liveMode=true:  ${pT}/${wT} = ${mT.toFixed(2)}% / med=${medT}d / TL=${((tlT / wT) * 100).toFixed(2)}%`,
        );
        console.log(`  drift: ${(mT - mF).toFixed(2)}pp`);
      }

      console.log(`\n\n=== SUMMARY (Round 28 Drop-AAVE LiveMode) ===`);
      console.log(
        `Config                       | LM-FALSE | LM-TRUE | Drift     | LM-T-Med | LM-T-TL`,
      );
      for (const r of results) {
        console.log(
          `${r.name.padEnd(30)} | ${r.mF.toFixed(2).padStart(7)}% | ${r.mT.toFixed(2).padStart(6)}% | ${r.drift.toFixed(2).padStart(7)}pp | ${String(r.medT).padStart(7)}d | ${r.tlT.toFixed(2).padStart(6)}%`,
        );
      }
      const best = [...results].sort((a, b) => b.mT - a.mT)[0];
      console.log(
        `\n>>> BEST liveMode=true: ${best.name} → ${best.mT.toFixed(2)}% (med ${best.medT}d) <<<`,
      );
      expect(true).toBe(true);
    });
  },
);
