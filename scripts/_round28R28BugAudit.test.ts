/**
 * Round 28 — V5_QUARTZ_LITE_R28 BUG AUDIT (skeptical re-validation).
 *
 * The "71.28% under liveMode=true" claim is suspicious.  Round 12 caught V7's
 * 87% as a bug; we apply the same skepticism to R28 here.
 *
 * Audit dimensions (each isolates one suspected inflation source):
 *
 *   A)  Baseline R28          — reproduce 71.28%.
 *   B)  pingReliability=0.85  — realistic bot uptime (cron miss, MT5
 *                                disconnects).  Drops phantom ping-trades.
 *   C)  pingReliability=0.50  — worst-case (data outage / weekend miss).
 *   D)  PTP slippage realism  — engine credits PTP at exact triggerPct.  Real
 *                                MT5 fills are subject to slippage.  We add
 *                                10bp slippage by reducing ptp.triggerPct
 *                                to 0.024 (was 0.025).  Approximation: the
 *                                P&L locked at PTP is closeFraction *
 *                                (triggerPct - slippage), which equals what
 *                                the engine would compute if triggerPct were
 *                                10bp lower.
 *   E)  PTP disabled          — sanity: how much pass-rate does PTP itself
 *                                contribute?  If PTP is essentially the only
 *                                edge, the config is fragile.
 *   F)  liveMode=false (exit-sort) — measures the lookahead delta R28
 *                                claims to remove.  Should be MUCH higher;
 *                                if the gap is small, liveMode is not
 *                                actually changing chronology.
 *
 * Each variant runs the same 5.71y / 30m / step=3d window grid as the
 * original R28 validation (665 windows).
 */

import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
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

describe(
  "Round 28 — V5_QUARTZ_LITE_R28 BUG AUDIT",
  { timeout: 120 * 60_000 },
  () => {
    it("audit pingReliability + PTP slippage + lookahead delta", async () => {
      const baseR28: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      };

      const variants: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [
        { name: "A_R28_baseline", cfg: baseR28 },
        {
          name: "B_pingReliability_0.85",
          cfg: { ...baseR28, pingReliability: 0.85 },
        },
        {
          name: "C_pingReliability_0.50",
          cfg: { ...baseR28, pingReliability: 0.5 },
        },
        {
          name: "D_PTP_slippage_10bp",
          // 10bp slippage: triggerPct 0.025 → 0.024 (engine credits triggerPct
          // exactly at fire; this is mathematically equivalent to subtracting
          // slippage off the credited gain).
          cfg: {
            ...baseR28,
            partialTakeProfit: { triggerPct: 0.024, closeFraction: 0.6 },
          },
        },
        {
          name: "E_PTP_disabled",
          cfg: { ...baseR28, partialTakeProfit: undefined },
        },
        {
          name: "F_liveMode_false_(exit_sort_lookahead)",
          cfg: { ...baseR28, liveMode: false },
        },
        {
          name: "G_combined_ping0.85_slip10bp",
          cfg: {
            ...baseR28,
            pingReliability: 0.85,
            partialTakeProfit: { triggerPct: 0.024, closeFraction: 0.6 },
          },
        },
      ];

      const symbols = syms(baseR28);
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
      const minBars = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
      const bpd = 48;
      const winBars = baseR28.maxDays * bpd;
      const stepBars = 3 * bpd;
      const ts0 = aligned[symbols[0]][0].openTime;
      const lastTs = aligned[symbols[0]][minBars - 1].openTime;
      console.log(
        `Data: ${minBars} bars / ${((lastTs - ts0) / (365 * 24 * 3600_000)).toFixed(2)}y`,
      );

      function runWindows(c: FtmoDaytrade24hConfig): {
        pass: number;
        total: number;
        pct: number;
        median: number;
        tlPct: number;
        dlPct: number;
      } {
        let pass = 0;
        let total = 0;
        let tl = 0;
        let dl = 0;
        const passDays: number[] = [];
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of symbols)
            slice[s] = aligned[s].slice(start, start + winBars);
          const res = runFtmoDaytrade24h(slice, c);
          total++;
          if (res.passed) {
            pass++;
            if (res.passDay) passDays.push(res.passDay);
          }
          if (res.reason === "total_loss") tl++;
          if (res.reason === "daily_loss") dl++;
        }
        passDays.sort((a, b) => a - b);
        const median = passDays.length
          ? passDays[Math.floor(passDays.length / 2)]
          : 0;
        return {
          pass,
          total,
          pct: (pass / total) * 100,
          median,
          tlPct: (tl / total) * 100,
          dlPct: (dl / total) * 100,
        };
      }

      const results: Array<{
        name: string;
        pct: number;
        median: number;
        tlPct: number;
        dlPct: number;
        delta: number;
      }> = [];
      let baselinePct = 0;

      for (const v of variants) {
        const r = runWindows(v.cfg);
        if (v.name === "A_R28_baseline") baselinePct = r.pct;
        const delta = r.pct - baselinePct;
        results.push({
          name: v.name,
          pct: r.pct,
          median: r.median,
          tlPct: r.tlPct,
          dlPct: r.dlPct,
          delta,
        });
        console.log(
          `${v.name.padEnd(40)}  ${r.pct.toFixed(2)}%  med ${r.median}d  TL ${r.tlPct.toFixed(1)}%  DL ${r.dlPct.toFixed(1)}%  Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp`,
        );
      }

      // Print final summary table
      console.log(`\n=== R28 BUG AUDIT — final inflation breakdown ===`);
      console.log(`Variant                                   Pass%   Δ vs A`);
      for (const r of results) {
        console.log(
          `${r.name.padEnd(40)}  ${r.pct.toFixed(2)}%   ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)}pp`,
        );
      }

      expect(results.length).toBe(variants.length);
    });
  },
);
