/**
 * Live-Safe Fine-Tune Sweep — 30m TF.
 *
 * Refines the atrStop p42 m5 winner from ftmoLiveSafeTuning30m.test.ts
 * by sweeping nearby variants + LSC cooldown + htfTrendFilter threshold +
 * timeBoost on top.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const LIVE_CAPS = { maxStopPct: 0.03, maxRiskFrac: 0.02 };
const CHALLENGE_DAYS = 30;
const BARS_PER_DAY = 48;

interface BatchResult {
  passes: number;
  windows: number;
  passRate: number;
  medianDays: number;
  p25Days: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
  totalTrades: number;
  ev: number;
}

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  stepDays = 3,
): BatchResult {
  const winBars = Math.round(CHALLENGE_DAYS * BARS_PER_DAY);
  const stepBars = Math.round(stepDays * BARS_PER_DAY);
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  let totalTrades = 0;
  for (const r of out) {
    totalTrades += r.trades.length;
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  }
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    passes,
    windows: out.length,
    passRate: passes / out.length,
    medianDays: pick(0.5),
    p25Days: pick(0.25),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    totalTrades,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
}

function fmt(label: string, r: BatchResult) {
  return `${label.padEnd(44)} ${r.passes.toString().padStart(3)}/${r.windows} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

describe("Live-safe 30m fine-tune sweep", { timeout: 1500_000 }, () => {
  it("refines around atr p42 m5 winner", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "30m",
      targetCount: 60000,
      maxPages: 60,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "30m",
      targetCount: 60000,
      maxPages: 60,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "30m",
      targetCount: 60000,
      maxPages: 60,
    });
    const n = Math.min(eth.length, btc.length, sol.length);
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
    };
    const yrs = (n / 48 / 365).toFixed(2);
    console.log(`\n=== Fine-Tune Sweep — ${yrs}y / ${n} bars ===\n`);

    const base: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
      atrStop: { period: 42, stopMult: 5 },
      liveCaps: LIVE_CAPS,
    };
    const winner = runWalkForward(data, base);
    console.log(fmt("Phase-1 winner: atr p42 m5", winner));

    // Round 2: fine ATR around (p42 m5)
    const r2: Array<{ label: string; r: BatchResult }> = [];
    console.log(`\n--- R2: atrStop fine sweep around p42 m5 ---`);
    for (const p of [32, 38, 42, 46, 52]) {
      for (const m of [4.0, 4.5, 5.0, 5.5, 6.0]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...base,
          atrStop: { period: p, stopMult: m },
        };
        const r = runWalkForward(data, cfg);
        const label = `atr p${p} m${m}`;
        r2.push({ label, r });
        console.log(fmt(label, r));
      }
    }
    const r2Best = [...r2].sort((a, b) => b.r.passRate - a.r.passRate)[0];
    console.log(
      `R2 winner: ${r2Best.label} → ${(r2Best.r.passRate * 100).toFixed(2)}%`,
    );

    const baseR2: FtmoDaytrade24hConfig = {
      ...base,
      atrStop: {
        period: parseInt(r2Best.label.match(/p(\d+)/)![1]),
        stopMult: parseFloat(r2Best.label.match(/m([\d.]+)/)![1]),
      },
    };

    // Round 3: lossStreakCooldown sweep
    const r3: Array<{ label: string; r: BatchResult }> = [];
    console.log(`\n--- R3: lossStreakCooldown sweep ---`);
    for (const cd of [50, 100, 150, 200, 300, 400]) {
      for (const after of [2, 3]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...baseR2,
          lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
        };
        const r = runWalkForward(data, cfg);
        const label = `LSC after=${after} cd=${cd}`;
        r3.push({ label, r });
        console.log(fmt(label, r));
      }
    }
    const r3Best = [...r3].sort(
      (a, b) => b.r.passRate - a.r.passRate || a.r.medianDays - b.r.medianDays,
    )[0];
    console.log(
      `R3 winner: ${r3Best.label} → ${(r3Best.r.passRate * 100).toFixed(2)}% / med ${r3Best.r.medianDays}d`,
    );

    const after = parseInt(r3Best.label.match(/after=(\d+)/)![1]);
    const cd = parseInt(r3Best.label.match(/cd=(\d+)/)![1]);
    const baseR3: FtmoDaytrade24hConfig = {
      ...baseR2,
      lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
    };

    // Round 4: htfTrendFilter threshold sweep
    const r4: Array<{ label: string; r: BatchResult }> = [];
    console.log(`\n--- R4: htfTrendFilter threshold sweep ---`);
    for (const lb of [100, 200, 300]) {
      for (const thr of [0.05, 0.08, 0.1, 0.12, 0.15]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...baseR3,
          htfTrendFilter: {
            lookbackBars: lb,
            apply: "short",
            threshold: thr,
          },
        };
        const r = runWalkForward(data, cfg);
        const label = `HTF lb=${lb} thr=${thr}`;
        r4.push({ label, r });
        console.log(fmt(label, r));
      }
    }
    const r4Best = [...r4].sort(
      (a, b) => b.r.passRate - a.r.passRate || a.r.medianDays - b.r.medianDays,
    )[0];
    console.log(
      `R4 winner: ${r4Best.label} → ${(r4Best.r.passRate * 100).toFixed(2)}%`,
    );

    // Final report
    console.log(`\n========== FINAL CHAMPION ==========`);
    console.log(fmt("Phase 1 (V12 + atr p42 m5)", winner));
    console.log(fmt(`R2 (${r2Best.label})`, r2Best.r));
    console.log(fmt(`R3 (${r3Best.label})`, r3Best.r));
    console.log(fmt(`R4 (${r4Best.label})`, r4Best.r));

    expect(r4Best.r.passRate).toBeGreaterThan(0.5);
  });
});
