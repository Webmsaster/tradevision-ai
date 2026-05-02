/**
 * V245_QUARTZ Adaptation Test (Round 28).
 *
 * Adapts V245's 4h MR-shorts engine stack (atrStop p18 m8 + holdBars 60 +
 * timeBoost d4 f2.0 + pauseAtTargetReached) to V5_QUARTZ_LITE's 9-asset
 * TREND basket (BTC, ETH, BNB, ADA, LTC, BCH, ETC, XRP, AAVE) on 4h bars.
 *
 * Reports walk-forward backtest pass-rates under both:
 *   - liveMode=false (default — exit-time sort, current backtest convention)
 *   - liveMode=true  (Round-28 live-replication midpoint check)
 *
 * Goal: ≥75% backtest AND ≥70% under liveMode=true → SINGLE-ACCOUNT LIVE 70%.
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run scripts/_v245QuartzAdapt.test.ts \
 *     --reporter=basic --testTimeout=1800000 2>&1 | tail -100
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V245_QUARTZ,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { pick, computePassDay, assertAligned } from "./_passDayUtils";

const BARS_PER_DAY = 6; // 4h TF (24/4)
const CHALLENGE_DAYS = 30;

const ASSETS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "ETCUSDT",
  "XRPUSDT",
  "AAVEUSDT",
];

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  stepDays = 3,
) {
  assertAligned(byAsset);
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
  const tlBreaches = out.filter((r) => r.reason === "total_loss").length;
  const dlBreaches = out.filter((r) => r.reason === "daily_loss").length;
  const passDays: number[] = [];
  for (const r of out) if (r.passed) passDays.push(computePassDay(r));
  passDays.sort((a, b) => a - b);
  const px = (q: number) => {
    const v = pick(passDays, q);
    return Number.isNaN(v) ? 0 : v;
  };
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: px(0.5),
    p25Days: px(0.25),
    p75Days: px(0.75),
    p90Days: px(0.9),
    tlPct: out.length > 0 ? tlBreaches / out.length : 0,
    dlPct: out.length > 0 ? dlBreaches / out.length : 0,
    tlBreaches,
    dlBreaches,
  };
}

describe("V245_QUARTZ adaptation", { timeout: 1800_000 }, () => {
  it("runs walk-forward under liveMode=false and liveMode=true", async () => {
    // 4h has 6 bars/day. To get >100 step=3d windows we need ≥ (30+3*100)*6
    // = 1980 bars. Aim for ~12000 bars (~5.5y) to match V245's audit horizon.
    const targetCount = 12000;
    const maxPages = 20;

    console.log(
      `\n=== V245_QUARTZ — loading 9 assets @ 4h (~${targetCount} bars each) ===`,
    );
    const data: Record<string, Candle[]> = {};
    for (const sym of ASSETS) {
      const bars = await loadBinanceHistory({
        symbol: sym,
        timeframe: "4h",
        targetCount,
        maxPages,
      });
      data[sym] = bars;
      const yrs = (bars.length / BARS_PER_DAY / 365).toFixed(2);
      console.log(`  ${sym.padEnd(10)} ${bars.length} bars (${yrs}y)`);
    }
    // align to common length and intersect openTimes
    const minLen = Math.min(...Object.values(data).map((a) => a.length));
    const slicedTail: Record<string, Candle[]> = {};
    for (const sym of ASSETS) slicedTail[sym] = data[sym].slice(-minLen);
    const sets = ASSETS.map(
      (s) => new Set(slicedTail[s].map((c) => c.openTime)),
    );
    let common = [...sets[0]];
    for (let i = 1; i < sets.length; i++) {
      common = common.filter((t) => sets[i].has(t));
    }
    common.sort((a, b) => a - b);
    const cs = new Set(common);
    const aligned: Record<string, Candle[]> = {};
    for (const sym of ASSETS)
      aligned[sym] = slicedTail[sym].filter((c) => cs.has(c.openTime));

    const n = aligned[ASSETS[0]].length;
    const yrs = (n / BARS_PER_DAY / 365).toFixed(2);
    console.log(`\n  Aligned: ${n} bars (${yrs}y) across all 9 assets`);

    // ============== Mode 1: liveMode=false (default backtest) ==============
    console.log(
      `\n=== Walk-forward step=3d  |  liveMode=false (default backtest) ===`,
    );
    const cfgBT: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_V245_QUARTZ,
      liveMode: false,
    };
    const rBT = runWalkForward(aligned, cfgBT, 3);
    console.log(
      `V245_QUARTZ (BT)    ${rBT.passes}/${rBT.windows} = ${(rBT.passRate * 100).toFixed(2)}%  ` +
        `med=${rBT.medianDays}d p25=${rBT.p25Days} p75=${rBT.p75Days} p90=${rBT.p90Days}  ` +
        `TL=${(rBT.tlPct * 100).toFixed(1)}% DL=${(rBT.dlPct * 100).toFixed(1)}%`,
    );

    // ============== Mode 2: liveMode=true (entry-time sort) ===============
    console.log(
      `\n=== Walk-forward step=3d  |  liveMode=true (live-replication midpoint) ===`,
    );
    const cfgLive: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_V245_QUARTZ,
      liveMode: true,
    };
    const rLive = runWalkForward(aligned, cfgLive, 3);
    console.log(
      `V245_QUARTZ (LIVE)  ${rLive.passes}/${rLive.windows} = ${(rLive.passRate * 100).toFixed(2)}%  ` +
        `med=${rLive.medianDays}d p25=${rLive.p25Days} p75=${rLive.p75Days} p90=${rLive.p90Days}  ` +
        `TL=${(rLive.tlPct * 100).toFixed(1)}% DL=${(rLive.dlPct * 100).toFixed(1)}%`,
    );

    // ============== Verdict ==============
    const drift = rBT.passRate - rLive.passRate;
    console.log(`\n=== FINAL ===`);
    console.log(
      `Config:    FTMO_DAYTRADE_24H_CONFIG_V245_QUARTZ  (V245 stack on 9-asset V5 basket)`,
    );
    console.log(
      `BT mode:   ${(rBT.passRate * 100).toFixed(2)}%  med=${rBT.medianDays}d p90=${rBT.p90Days}d  TL=${(rBT.tlPct * 100).toFixed(1)}%`,
    );
    console.log(
      `LIVE mode: ${(rLive.passRate * 100).toFixed(2)}%  med=${rLive.medianDays}d p90=${rLive.p90Days}d  TL=${(rLive.tlPct * 100).toFixed(1)}%`,
    );
    console.log(`Drift:     ${(drift * 100).toFixed(2)}pp (BT − LIVE)`);
    console.log(
      `Goal:      BT ≥75% AND LIVE ≥70%.  ` +
        `BT ${rBT.passRate >= 0.75 ? "PASS" : "FAIL"}, LIVE ${rLive.passRate >= 0.7 ? "PASS" : "FAIL"}.`,
    );
    const verdict =
      rBT.passRate >= 0.75 && rLive.passRate >= 0.7
        ? "PROMOTE TO LIVE"
        : rBT.passRate >= 0.75
          ? "BT-ONLY (live drift too large)"
          : "REJECT — backtest below 75%";
    console.log(`Verdict:   ${verdict}`);

    expect(rBT.windows).toBeGreaterThan(0);
    expect(rLive.windows).toBeGreaterThan(0);
  });
});
