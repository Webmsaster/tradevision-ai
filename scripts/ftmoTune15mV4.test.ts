/**
 * V4 Phase: drawdown-defense + extended htfTrendFilter + stricter BTC-mom.
 *
 * Hypothesis: 139 TL-breaches = strategy keeps full-risk in drawdown.
 * Fix: extend adaptiveSizing tiers to negative equity (defensive sizing
 * when already underwater).
 *
 * Plus: longer htfTrendFilter lookback to catch slow grinds (2023 issue).
 * Plus: stricter cross-asset BTC momentum threshold.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

describe(
  "15m V4 — drawdown-defense + macro filters",
  { timeout: 1800_000 },
  () => {
    it("attacks the TL-breach rate", async () => {
      const eth = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "15m",
        targetCount: 250000,
        maxPages: 250,
      });
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount: 250000,
        maxPages: 250,
      });
      const sol = await loadBinanceHistory({
        symbol: "SOLUSDT",
        timeframe: "15m",
        targetCount: 250000,
        maxPages: 250,
      });
      const n = Math.min(eth.length, btc.length, sol.length);
      const data = {
        ETHUSDT: eth.slice(-n),
        BTCUSDT: btc.slice(-n),
        SOLUSDT: sol.slice(-n),
      };
      console.log(
        `\n=== 15m V4 — ${(n / 96 / 365).toFixed(2)}y / ${n} bars ===`,
      );

      let cur: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
        liveCaps: LIVE_CAPS,
      };
      let curR = runWalkForward(data, cur, 0.25);
      console.log(fmt("V2 BASELINE", curR));

      // R1: extend adaptiveSizing into negative equity (drawdown defense)
      console.log(`\n--- R1: drawdown-aware sizing ---`);
      let r1Best = { cfg: cur, r: curR };
      const sizingVariants: Array<{ label: string; tiers: any[] }> = [
        {
          label: "current",
          tiers: cur.adaptiveSizing ?? [],
        },
        // dd-1: gradual defense
        {
          label: "dd -3%/0.3, -1.5%/0.5",
          tiers: [
            { equityAbove: -0.03, factor: 0.3 },
            { equityAbove: -0.015, factor: 0.5 },
            ...(cur.adaptiveSizing ?? []),
          ],
        },
        // dd-2: aggressive defense
        {
          label: "dd -3%/0.2, -1.5%/0.4",
          tiers: [
            { equityAbove: -0.03, factor: 0.2 },
            { equityAbove: -0.015, factor: 0.4 },
            ...(cur.adaptiveSizing ?? []),
          ],
        },
        // dd-3: even tighter
        {
          label: "dd -2%/0.25",
          tiers: [
            { equityAbove: -0.02, factor: 0.25 },
            ...(cur.adaptiveSizing ?? []),
          ],
        },
        // dd-4: skip-effective (factor 0)
        {
          label: "dd -4%/0",
          tiers: [
            { equityAbove: -0.04, factor: 0 },
            ...(cur.adaptiveSizing ?? []),
          ],
        },
        // dd-5: medium tier
        {
          label: "dd -2.5%/0.3, -1%/0.5",
          tiers: [
            { equityAbove: -0.025, factor: 0.3 },
            { equityAbove: -0.01, factor: 0.5 },
            ...(cur.adaptiveSizing ?? []),
          ],
        },
        // dd-6: very granular
        {
          label: "dd granular",
          tiers: [
            { equityAbove: -0.04, factor: 0.1 },
            { equityAbove: -0.025, factor: 0.25 },
            { equityAbove: -0.01, factor: 0.4 },
            ...(cur.adaptiveSizing ?? []),
          ],
        },
      ];
      for (const v of sizingVariants) {
        const cfg: FtmoDaytrade24hConfig = { ...cur, adaptiveSizing: v.tiers };
        const r = runWalkForward(data, cfg, 0.25);
        if (score(r, r1Best.r) < 0) {
          r1Best = { cfg, r };
          console.log(fmt(`  ${v.label}`, r));
        }
      }
      cur = r1Best.cfg;
      console.log(fmt("R1 winner", r1Best.r));

      // R2: stricter htfTrendFilter (longer lookback to catch slow grinds)
      console.log(`\n--- R2: extended htfTrendFilter ---`);
      let r2Best = { cfg: cur, r: r1Best.r };
      for (const lb of [200, 400, 600, 800, 1200, 2000]) {
        for (const thr of [0.03, 0.05, 0.07, 0.1, 0.15]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            htfTrendFilter: {
              lookbackBars: lb,
              apply: "short",
              threshold: thr,
            },
          };
          const r = runWalkForward(data, cfg, 0.25);
          if (score(r, r2Best.r) < 0) {
            r2Best = { cfg, r };
            console.log(fmt(`  HTF lb=${lb} thr=${thr}`, r));
          }
        }
      }
      cur = r2Best.cfg;
      console.log(fmt("R2 winner", r2Best.r));

      // R3: stricter crossAssetFilter momSkipShortAbove
      console.log(`\n--- R3: tighter BTC momentum filter ---`);
      let r3Best = { cfg: cur, r: r2Best.r };
      const caf = cur.crossAssetFilter;
      if (caf) {
        for (const ms of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04]) {
          for (const mb of [4, 6, 8, 12, 24]) {
            const cfg: FtmoDaytrade24hConfig = {
              ...cur,
              crossAssetFilter: {
                ...caf,
                momSkipShortAbove: ms,
                momentumBars: mb,
              },
            };
            const r = runWalkForward(data, cfg, 0.25);
            if (score(r, r3Best.r) < 0) {
              r3Best = { cfg, r };
              console.log(fmt(`  caf ms=${ms} mb=${mb}`, r));
            }
          }
        }
      }
      cur = r3Best.cfg;
      console.log(fmt("R3 winner", r3Best.r));

      // R4: tighter LSC (faster cooldown after losses)
      console.log(`\n--- R4: aggressive LSC ---`);
      let r4Best = { cfg: cur, r: r3Best.r };
      for (const after of [1, 2, 3]) {
        for (const cd of [50, 100, 200, 400, 600, 1000, 1500]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
          };
          const r = runWalkForward(data, cfg, 0.25);
          if (score(r, r4Best.r) < 0) {
            r4Best = { cfg, r };
            console.log(fmt(`  LSC after=${after} cd=${cd}`, r));
          }
        }
      }
      cur = r4Best.cfg;
      console.log(fmt("R4 winner", r4Best.r));

      console.log(`\n========== V4 FINAL ==========`);
      console.log(fmt("V2 baseline", curR));
      console.log(fmt("V4 final   ", r4Best.r));
      console.log(
        `Δ V2→V4: +${((r4Best.r.passRate - curR.passRate) * 100).toFixed(2)}pp pass, ${r4Best.r.p90Days - curR.p90Days}d p90`,
      );
      console.log(`\nFinal config:`);
      console.log(
        JSON.stringify(
          {
            adaptiveSizing: cur.adaptiveSizing,
            htfTrendFilter: cur.htfTrendFilter,
            crossAssetFilter: cur.crossAssetFilter,
            lossStreakCooldown: cur.lossStreakCooldown,
          },
          null,
          2,
        ),
      );
      expect(r4Best.r.passRate).toBeGreaterThan(0);
    });
  },
);
