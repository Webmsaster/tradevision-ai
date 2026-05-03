/**
 * Round 19 — V5_QUARTZ Mega Speed Sweep on bug-fixed engine.
 *
 * Round 18 best: V5_QUARTZ 30m NO-PAUSE = 6d med / 52% pass / TL=35%.
 * Goal: compress to 4-5d / 60%+ pass / lower TL.
 *
 * Test 25+ tweak combos in single sweep (data already cached).
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

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  return arr[Math.floor(arr.length * p)];
}

function evaluate(cfg: FtmoDaytrade24hConfig, data: Record<string, Candle[]>) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (n === 0) return null;
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0;
  const passDays: number[] = [];
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (res.passed) {
      passes++;
      if (res.passDay && res.passDay > 0) passDays.push(res.passDay);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
  }
  passDays.sort((a, b) => a - b);
  return {
    windows,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
    p25: pctile(passDays, 0.25),
    med: pctile(passDays, 0.5),
    p75: pctile(passDays, 0.75),
    p90: pctile(passDays, 0.9),
  };
}

describe(
  "Round 19 — V5_QUARTZ MEGA speed sweep",
  { timeout: 60 * 60_000 },
  () => {
    it("25+ tweak combos to break 60% / 5d barrier", async () => {
      const QZ = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ;
      const symbols = syms(QZ);
      console.log(`Loading ${symbols.length} symbols (30m)...`);
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

      const baseAntiDL: FtmoDaytrade24hConfig = {
        ...QZ,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        dailyPeakTrailingStop: { trailDistance: 0.02 },
        pauseAtTargetReached: false, // NO-PAUSE for speed
      };

      const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];
      trials.push({ name: "BASELINE V5_QUARTZ NO-PAUSE", cfg: baseAntiDL });

      // PTPL aggressive accumulation
      const ptplVariants: Array<{
        name: string;
        levels: Array<{ triggerPct: number; closeFraction: number }>;
      }> = [
        {
          name: "PTPL early-lock [.5%30%][1%30%][2%40%]",
          levels: [
            { triggerPct: 0.005, closeFraction: 0.3 },
            { triggerPct: 0.01, closeFraction: 0.3 },
            { triggerPct: 0.02, closeFraction: 0.4 },
          ],
        },
        {
          name: "PTPL mid [1%50%][3%50%]",
          levels: [
            { triggerPct: 0.01, closeFraction: 0.5 },
            { triggerPct: 0.03, closeFraction: 0.5 },
          ],
        },
        {
          name: "PTPL hybrid [1.5%40%][3%30%][5%30%]",
          levels: [
            { triggerPct: 0.015, closeFraction: 0.4 },
            { triggerPct: 0.03, closeFraction: 0.3 },
            { triggerPct: 0.05, closeFraction: 0.3 },
          ],
        },
      ];
      for (const v of ptplVariants) {
        trials.push({
          name: v.name,
          cfg: { ...baseAntiDL, partialTakeProfitLevels: v.levels },
        });
      }

      // timeBoost variants
      for (const f of [2.0, 2.5, 3.0]) {
        const tb = { afterDay: 2, equityBelow: 0.05, factor: f };
        trials.push({
          name: `timeBoost f=${f}`,
          cfg: { ...baseAntiDL, timeBoost: tb },
        });
      }

      // Asset trim — drop high-TL suspects
      const dropAssets = (drops: string[]) =>
        baseAntiDL.assets.filter(
          (a) =>
            !drops.includes(a.symbol) &&
            !drops.includes(a.sourceSymbol ?? a.symbol),
        );
      trials.push({
        name: "QZ - drop AAVE-TREND",
        cfg: { ...baseAntiDL, assets: dropAssets(["AAVE-TREND"]) },
      });
      trials.push({
        name: "QZ - drop INJ-TREND",
        cfg: { ...baseAntiDL, assets: dropAssets(["INJ-TREND"]) },
      });
      trials.push({
        name: "QZ - drop AAVE+INJ",
        cfg: { ...baseAntiDL, assets: dropAssets(["AAVE-TREND", "INJ-TREND"]) },
      });
      trials.push({
        name: "QZ - drop SAND+RUNE+ARB",
        cfg: {
          ...baseAntiDL,
          assets: dropAssets(["SAND-TREND", "RUNE-TREND", "ARB-TREND"]),
        },
      });

      // atrStop tighter (TL reduction)
      if (baseAntiDL.atrStop) {
        const a = baseAntiDL.atrStop;
        for (const m of [1.5, 2.5]) {
          trials.push({
            name: `atrStop m=${m}`,
            cfg: { ...baseAntiDL, atrStop: { ...a, stopMult: m } },
          });
        }
      }

      // Combos
      trials.push({
        name: "COMBO: PTPL early + drop AAVE+INJ + tBoost=2.5",
        cfg: {
          ...baseAntiDL,
          partialTakeProfitLevels: ptplVariants[0].levels,
          assets: dropAssets(["AAVE-TREND", "INJ-TREND"]),
          timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.5 },
        },
      });
      trials.push({
        name: "COMBO: PTPL hybrid + drop SAND+RUNE+ARB",
        cfg: {
          ...baseAntiDL,
          partialTakeProfitLevels: ptplVariants[2].levels,
          assets: dropAssets(["SAND-TREND", "RUNE-TREND", "ARB-TREND"]),
        },
      });
      trials.push({
        name: "COMBO: drop AAVE+INJ + tBoost=3.0",
        cfg: {
          ...baseAntiDL,
          assets: dropAssets(["AAVE-TREND", "INJ-TREND"]),
          timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 3.0 },
        },
      });

      // R19 ULTIMATE — all 4 agent recommendations combined
      trials.push({
        name: "🎯 ULTIMATE: drop INJ+SAND+ARB+RUNE + tBoost-C + atrStop m=3.5",
        cfg: {
          ...baseAntiDL,
          assets: dropAssets([
            "INJ-TREND",
            "SAND-TREND",
            "ARB-TREND",
            "RUNE-TREND",
          ]),
          timeBoost: { afterDay: 0, equityBelow: 0.08, factor: 1.5 },
          atrStop: baseAntiDL.atrStop
            ? { ...baseAntiDL.atrStop, stopMult: 3.5 }
            : undefined,
        },
      });
      trials.push({
        name: "🎯 ULTIMATE+PTPL hybrid",
        cfg: {
          ...baseAntiDL,
          assets: dropAssets([
            "INJ-TREND",
            "SAND-TREND",
            "ARB-TREND",
            "RUNE-TREND",
          ]),
          timeBoost: { afterDay: 0, equityBelow: 0.08, factor: 1.5 },
          atrStop: baseAntiDL.atrStop
            ? { ...baseAntiDL.atrStop, stopMult: 3.5 }
            : undefined,
          partialTakeProfitLevels: ptplVariants[2].levels, // hybrid
        },
      });
      trials.push({
        name: "🎯 V5_QUARTZ_LITE 9assets",
        cfg: {
          ...baseAntiDL,
          assets: baseAntiDL.assets.filter((a) =>
            [
              "BTC-TREND",
              "ETH-TREND",
              "BNB-TREND",
              "ADA-TREND",
              "LTC-TREND",
              "BCH-TREND",
              "ETC-TREND",
              "XRP-TREND",
              "AAVE-TREND",
            ].includes(a.symbol),
          ),
        },
      });
      trials.push({
        name: "🎯 LITE + tBoost-C + atrStop m=3.5",
        cfg: {
          ...baseAntiDL,
          assets: baseAntiDL.assets.filter((a) =>
            [
              "BTC-TREND",
              "ETH-TREND",
              "BNB-TREND",
              "ADA-TREND",
              "LTC-TREND",
              "BCH-TREND",
              "ETC-TREND",
              "XRP-TREND",
              "AAVE-TREND",
            ].includes(a.symbol),
          ),
          timeBoost: { afterDay: 0, equityBelow: 0.08, factor: 1.5 },
          atrStop: baseAntiDL.atrStop
            ? { ...baseAntiDL.atrStop, stopMult: 3.5 }
            : undefined,
        },
      });
      trials.push({
        name: "🎯 LITE + tBoost-A f=2.5 + atrStop m=3.5",
        cfg: {
          ...baseAntiDL,
          assets: baseAntiDL.assets.filter((a) =>
            [
              "BTC-TREND",
              "ETH-TREND",
              "BNB-TREND",
              "ADA-TREND",
              "LTC-TREND",
              "BCH-TREND",
              "ETC-TREND",
              "XRP-TREND",
              "AAVE-TREND",
            ].includes(a.symbol),
          ),
          timeBoost: { afterDay: 1, equityBelow: 0.05, factor: 2.5 },
          atrStop: baseAntiDL.atrStop
            ? { ...baseAntiDL.atrStop, stopMult: 3.5 }
            : undefined,
        },
      });

      console.log(
        `\n${"variant".padEnd(50)} ${"pass".padStart(7)} ${"med".padStart(4)} ${"p25".padStart(4)} ${"p75".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)}`,
      );
      console.log("─".repeat(90));

      const results: Array<{
        name: string;
        pass: number;
        med: number;
        p25: number;
        p75: number;
        p90: number;
        tl: number;
      }> = [];

      for (const { name, cfg } of trials) {
        const r = evaluate(cfg, data);
        if (!r) continue;
        const flag =
          r.med <= 4 && r.passRate >= 0.6
            ? " 🏆🏆🏆 GOAL!"
            : r.med <= 5 && r.passRate >= 0.6
              ? " 🏆"
              : r.med <= 6 && r.passRate >= 0.55
                ? " ✓✓"
                : r.med <= 7
                  ? " ✓"
                  : "";
        console.log(
          `${name.padEnd(50)} ${(r.passRate * 100).toFixed(2).padStart(6)}% ${String(r.med).padStart(3)}d ${String(r.p25).padStart(3)}d ${String(r.p75).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}%${flag}`,
        );
        results.push({
          name,
          pass: r.passRate,
          med: r.med,
          p25: r.p25,
          p75: r.p75,
          p90: r.p90,
          tl: r.tlPct,
        });
      }

      results.sort((a, b) => a.med - b.med || b.pass - a.pass);
      console.log("\n=== TOP-5 by lowest med (pass>=55%) ===");
      const valid = results.filter((r) => r.pass >= 0.55);
      for (let i = 0; i < Math.min(5, valid.length); i++) {
        const r = valid[i];
        console.log(
          `${i + 1}. ${r.name.padEnd(50)} med=${r.med}d pass=${(r.pass * 100).toFixed(2)}% TL=${(r.tl * 100).toFixed(2)}%`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
