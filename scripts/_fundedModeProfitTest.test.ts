/**
 * FUNDED-MODE PROFIT TEST — what each champion actually earns in the funded
 * account, where the real money is made.
 *
 * FTMO funded rules:
 *   - No profit target, lifetime account
 *   - 5% daily loss limit (death)
 *   - 10% total loss limit (death)
 *   - 80% profit split paid out monthly
 *   - Drawdown reset at end of month
 *
 * Settings:
 *   - profitTarget = 999 (effectively disabled)
 *   - maxDays = 90 (three months of trading)
 *   - liveCaps {maxStopPct:0.05, maxRiskFrac:0.4} — FTMO real
 *   - minTradingDays = 0 (no rule in funded)
 *   - pauseAtTargetReached = false (no target to pause at)
 *
 * Outputs per config:
 *   - 90-day final equity gain (median, p10, p90)
 *   - Survival rate (no DL/TL blowup)
 *   - Max drawdown distribution
 *   - $ profit @ 80% split for $100k account
 *
 * Champions tested: V5_NOVA, V5_QUARTZ, V5_AMBER, V5_TITANIUM, V5_NOVA-pause,
 * V5_QUARTZ-pause (pause variant in funded = pause earner stops trading
 * once monthly target hit, ping-trade for active-day rule).
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import type { LiveTimeframe } from "../src/hooks/useLiveCandles";

const BARS_PER_DAY: Record<string, number> = {
  "30m": 48,
  "2h": 12,
};

const FTMO_LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
const FUNDED_DAYS = 90;
const FUNDED_PROFIT_SPLIT = 0.8;
const ACCOUNT_USD = 100_000;

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

interface FundedResult {
  windows: number;
  survived: number; // no DL/TL blowup over 90d
  blewUp: number; // hit DL or TL
  finalEquities: number[]; // finalEquityPct - 1 (i.e. PnL fraction)
  maxDrawdowns: number[];
}

function evaluateFunded(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  dataTf: string,
): FundedResult | null {
  const bpd = BARS_PER_DAY[dataTf] ?? 48;
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (n === 0) return null;
  const winBars = FUNDED_DAYS * bpd;
  const stepBars = 30 * bpd; // step 30 days = ~roll per month
  const out: FundedResult = {
    windows: 0,
    survived: 0,
    blewUp: 0,
    finalEquities: [],
    maxDrawdowns: [],
  };
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    out.windows++;
    if (res.reason === "daily_loss" || res.reason === "total_loss") {
      out.blewUp++;
      // record PnL up to blowup point (treat as loss)
      out.finalEquities.push(res.finalEquityPct - 1);
      out.maxDrawdowns.push(res.maxDrawdown);
    } else {
      out.survived++;
      out.finalEquities.push(res.finalEquityPct - 1);
      out.maxDrawdowns.push(res.maxDrawdown);
    }
  }
  return out;
}

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)];
}

interface ChampionEntry {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  dataTf: "30m" | "2h";
}

describe(
  "FUNDED-MODE PROFIT TEST — 90d earner simulation",
  { timeout: 60 * 60_000 },
  () => {
    it("how much does each champion actually make?", async () => {
      const champions: ChampionEntry[] = [
        {
          name: "V5_NOVA",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
          dataTf: "2h",
        },
        {
          name: "V5_QUARTZ",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
          dataTf: "30m",
        },
        {
          name: "V5_AMBER",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
          dataTf: "30m",
        },
        {
          name: "V5_TITANIUM",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
          dataTf: "30m",
        },
      ];

      const byTf: Record<string, Set<string>> = {};
      for (const { cfg, dataTf } of champions) {
        if (!byTf[dataTf]) byTf[dataTf] = new Set();
        for (const s of syms(cfg)) byTf[dataTf].add(s);
      }

      const dataByTf: Record<string, Record<string, Candle[]>> = {};
      for (const tf of Object.keys(byTf)) {
        dataByTf[tf] = {};
        const symbols = [...byTf[tf]].sort();
        console.log(`Loading ${symbols.length} symbols (${tf})...`);
        for (const s of symbols) {
          try {
            const r = await loadBinanceHistory({
              symbol: s,
              timeframe: tf as LiveTimeframe,
              targetCount: 100000,
              maxPages: 120,
            });
            dataByTf[tf][s] = r.filter((c) => c.isFinal);
          } catch (e) {
            console.warn(`  skip ${s}: ${(e as Error).message}`);
          }
        }
      }

      console.log(
        `\n${"config".padEnd(22)} ${"variant".padEnd(10)} ${"survive".padStart(7)} ${"med 90d".padStart(8)} ${"p10 90d".padStart(8)} ${"p90 90d".padStart(8)} ${"med/Mo".padStart(8)} ${"$user/Mo*".padStart(11)} ${"maxDD".padStart(7)}`,
      );
      console.log("─".repeat(95));

      const summary: Array<{
        name: string;
        variant: string;
        survival: number;
        medMonthly: number;
        userMonthlyUsd: number;
      }> = [];

      for (const { name, cfg, dataTf } of champions) {
        const data = dataByTf[dataTf];
        if (!data) continue;

        for (const variant of ["NO-PAUSE", "PAUSE"]) {
          // Funded-mode config: huge profit-target, 90d, real liveCaps
          const fundedCfg: FtmoDaytrade24hConfig = {
            ...cfg,
            profitTarget: 999, // effectively disabled
            maxDays: FUNDED_DAYS,
            minTradingDays: 0, // no rule in funded
            pauseAtTargetReached: variant === "PAUSE",
            liveCaps: FTMO_LIVE_CAPS,
          };

          const r = evaluateFunded(fundedCfg, data, dataTf);
          if (!r || r.windows === 0) continue;

          const survival = r.survived / r.windows;
          const medFinal = pctile(r.finalEquities, 0.5);
          const p10 = pctile(r.finalEquities, 0.1);
          const p90 = pctile(r.finalEquities, 0.9);
          const medMaxDD = pctile(r.maxDrawdowns, 0.5);
          // Convert 90d return → monthly (compound: (1+90d)^(1/3) - 1)
          const medMonthly = Math.pow(1 + medFinal, 1 / 3) - 1;
          const userMonthlyUsd = ACCOUNT_USD * medMonthly * FUNDED_PROFIT_SPLIT;

          console.log(
            `${name.padEnd(22)} ${variant.padEnd(10)} ${(survival * 100).toFixed(1).padStart(6)}% ${(medFinal * 100).toFixed(2).padStart(7)}% ${(p10 * 100).toFixed(2).padStart(7)}% ${(p90 * 100).toFixed(2).padStart(7)}% ${(medMonthly * 100).toFixed(2).padStart(7)}% ${("$" + userMonthlyUsd.toFixed(0)).padStart(11)} ${(medMaxDD * 100).toFixed(2).padStart(6)}%`,
          );

          summary.push({
            name,
            variant,
            survival,
            medMonthly,
            userMonthlyUsd,
          });
        }
      }

      summary.sort((a, b) => b.userMonthlyUsd - a.userMonthlyUsd);
      console.log(
        "\n*$user/Mo = monthly equity gain × 80% profit split on $100k account",
      );
      console.log("\n=== PROFIT LEADERBOARD (median user $ / month) ===");
      for (let i = 0; i < summary.length; i++) {
        const s = summary[i];
        const flag = s.userMonthlyUsd > 0 ? " ✓" : " 🚨 LOSING";
        console.log(
          `${String(i + 1).padEnd(3)} ${s.name.padEnd(22)} ${s.variant.padEnd(10)} survive=${(s.survival * 100).toFixed(0).padStart(3)}% mo=${(s.medMonthly * 100).toFixed(2).padStart(6)}% user=$${s.userMonthlyUsd.toFixed(0).padStart(6)}${flag}`,
        );
      }

      expect(true).toBe(true);
    });
  },
);
