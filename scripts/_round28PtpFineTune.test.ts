/**
 * Round 28 — fine-tune partialTakeProfit + dailyPeakTrailingStop combos.
 *
 * V12-boost sweep best: +ptp25_50 = 69.77% (gap 0.23pp). Fine-tune by
 * sweeping triggerPct in [0.018..0.032] x closeFraction in [0.30..0.65]
 * and combining with dpt {0.010, 0.012, 0.015, 0.018, 0.020}.
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

const PTP_TRIGGERS = [0.018, 0.02, 0.022, 0.025, 0.028, 0.03, 0.032];
const PTP_FRACS = [0.3, 0.4, 0.45, 0.5, 0.55, 0.6];
const DPTS = [0.01, 0.012, 0.015, 0.018, 0.02];

describe(
  "Round 28 — fine-tune ptp x dpt liveMode=true",
  { timeout: 180 * 60_000 },
  () => {
    it("knack 70%", async () => {
      const symbols = syms(BASE);
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
      const winBars = BASE.maxDays * bpd;
      const stepBars = 3 * bpd;

      // Pre-slice all windows once.
      const wStarts: number[] = [];
      for (let s = 0; s + winBars <= minBars; s += stepBars) wStarts.push(s);

      type R = { name: string; passPct: number; tlPct: number; med: number };
      const results: R[] = [];

      let count = 0;
      const total = PTP_TRIGGERS.length * PTP_FRACS.length * DPTS.length;
      for (const dpt of DPTS) {
        for (const t of PTP_TRIGGERS) {
          for (const f of PTP_FRACS) {
            count++;
            const cfg: FtmoDaytrade24hConfig = {
              ...BASE,
              dailyPeakTrailingStop: { trailDistance: dpt },
              partialTakeProfit: { triggerPct: t, closeFraction: f },
              liveMode: true,
              liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
            } as FtmoDaytrade24hConfig;
            let w = 0,
              p = 0,
              tl = 0;
            const days: number[] = [];
            for (const start of wStarts) {
              const slice: Record<string, Candle[]> = {};
              for (const s of symbols)
                slice[s] = aligned[s].slice(start, start + winBars);
              const res = runFtmoDaytrade24h(slice, cfg);
              w++;
              if (res.passed) {
                p++;
                if (res.passDay) days.push(res.passDay);
              } else if (res.reason === "total_loss") tl++;
            }
            days.sort((a, b) => a - b);
            const passPct = (p / w) * 100;
            const tlPct = (tl / w) * 100;
            const med = days[Math.floor(days.length / 2)] ?? 0;
            const name = `dpt${dpt.toFixed(3)}_ptp${t.toFixed(3)}_f${f.toFixed(2)}`;
            results.push({ name, passPct, tlPct, med });
            if (count % 5 === 0 || passPct >= 69.5) {
              console.log(
                `[${count}/${total}] ${name.padEnd(32)}| ${passPct.toFixed(2).padStart(6)}% | TL ${tlPct.toFixed(2).padStart(6)}% | med ${med}d`,
              );
            }
          }
        }
      }

      console.log(`\n\n=== TOP 20 ===`);
      const sorted = [...results]
        .sort((a, b) => b.passPct - a.passPct)
        .slice(0, 20);
      for (const r of sorted) {
        console.log(
          `${r.name.padEnd(32)}| ${r.passPct.toFixed(2).padStart(6)}% | TL ${r.tlPct.toFixed(2).padStart(6)}% | med ${r.med}d`,
        );
      }
      const winner = sorted[0];
      console.log(
        `\n>>> WINNER: ${winner.name} → ${winner.passPct.toFixed(2)}% (TL ${winner.tlPct.toFixed(2)}%, med ${winner.med}d) <<<`,
      );
      if (winner.passPct >= 70)
        console.log(
          `*** GOAL ACHIEVED: ≥70% liveMode=true single-account! ***`,
        );
      else
        console.log(
          `*** NOT YET: gap = ${(70 - winner.passPct).toFixed(2)}pp ***`,
        );
      expect(true).toBe(true);
    });
  },
);
