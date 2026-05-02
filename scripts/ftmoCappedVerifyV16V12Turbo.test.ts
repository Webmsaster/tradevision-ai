/**
 * Capped backtest verification of V16 (15m speed champion) and
 * V12_TURBO (30m tail-crush) under the live-execution safety caps:
 *
 *   - stopPct ≤ 3% (else trade is skipped, mirroring live-detector behaviour)
 *   - riskFrac clamped at 2% (mirrors LIVE_MAX_RISK_FRAC)
 *
 * The original V16/V12_TURBO numbers in the auto-memory (94.38% / 93.28% pass,
 * med 4d) were measured under the historical "no-cap" PnL model. This test
 * answers: what does the median look like once the live caps actually clip
 * the wide-ATR stops?
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts \
 *     scripts/ftmoCappedVerifyV16V12Turbo.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V261,
  FTMO_DAYTRADE_24H_CONFIG_V231,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { pick, computePassDay, assertAligned } from "./_passDayUtils";

const LIVE_CAPS = { maxStopPct: 0.03, maxRiskFrac: 0.02 };
const CHALLENGE_DAYS = 30;

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  tfHours: number,
  stepDays = 3,
) {
  assertAligned(byAsset);
  const barsPerDay = 24 / tfHours;
  const winBars = Math.round(CHALLENGE_DAYS * barsPerDay);
  const stepBars = Math.round(stepDays * barsPerDay);
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
  const tlBreaches = out.filter((r) => r.reason === "total_loss").length;
  const dlBreaches = out.filter((r) => r.reason === "daily_loss").length;
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
    tlBreaches,
    dlBreaches,
  };
}

function fmt(label: string, r: ReturnType<typeof runWalkForward>) {
  return `${label.padEnd(28)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p25=${r.p25Days} p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}`;
}

describe("V16 + V12_TURBO under live caps", { timeout: 1200_000 }, () => {
  it("V12 + V12_TURBO (30m) — no-cap vs capped", async () => {
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
    console.log(`\n=== V12_TURBO 30m — ${yrs}y / ${n} bars ===`);

    const v12Base = runWalkForward(
      data,
      FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
      0.5,
    );
    const v12Cap = runWalkForward(
      data,
      { ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT, liveCaps: LIVE_CAPS },
      0.5,
    );
    const turboBase = runWalkForward(
      data,
      FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
      0.5,
    );
    const turboCap = runWalkForward(
      data,
      { ...FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT, liveCaps: LIVE_CAPS },
      0.5,
    );
    console.log(fmt("V12 no-cap         ", v12Base));
    console.log(fmt("V12 live-cap       ", v12Cap));
    console.log(fmt("V12_TURBO no-cap   ", turboBase));
    console.log(fmt("V12_TURBO live-cap ", turboCap));

    expect(v12Base.windows).toBeGreaterThan(50);
  });

  it("V261 (4h) + V231 (4h legacy) — no-cap vs capped", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 30000,
      maxPages: 40,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: 30000,
      maxPages: 40,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "4h",
      targetCount: 30000,
      maxPages: 40,
    });
    const n = Math.min(eth.length, btc.length, sol.length);
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
    };
    const yrs = (n / 6 / 365).toFixed(2);
    console.log(`\n=== V261 + V231 4h — ${yrs}y / ${n} bars ===`);

    const v261Base = runWalkForward(data, FTMO_DAYTRADE_24H_CONFIG_V261, 4);
    const v261Cap = runWalkForward(
      data,
      { ...FTMO_DAYTRADE_24H_CONFIG_V261, liveCaps: LIVE_CAPS },
      4,
    );
    const v231Base = runWalkForward(data, FTMO_DAYTRADE_24H_CONFIG_V231, 4);
    const v231Cap = runWalkForward(
      data,
      { ...FTMO_DAYTRADE_24H_CONFIG_V231, liveCaps: LIVE_CAPS },
      4,
    );
    console.log(fmt("V261 no-cap        ", v261Base));
    console.log(fmt("V261 live-cap      ", v261Cap));
    console.log(fmt("V231 no-cap        ", v231Base));
    console.log(fmt("V231 live-cap      ", v231Cap));

    expect(v261Base.windows).toBeGreaterThan(50);
  });

  it("V16 (15m) — no-cap vs capped", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "15m",
      targetCount: 60000,
      maxPages: 60,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 60000,
      maxPages: 60,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "15m",
      targetCount: 60000,
      maxPages: 60,
    });
    const n = Math.min(eth.length, btc.length, sol.length);
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
    };
    const yrs = (n / 96 / 365).toFixed(2);
    console.log(`\n=== V16 15m — ${yrs}y / ${n} bars ===`);

    const baseline = runWalkForward(
      data,
      FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
      0.25,
    );
    const capped = runWalkForward(
      data,
      { ...FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT, liveCaps: LIVE_CAPS },
      0.25,
    );
    console.log(fmt("V16 no-cap   ", baseline));
    console.log(fmt("V16 live-cap ", capped));
    console.log(
      `Δ pass: ${((capped.passRate - baseline.passRate) * 100).toFixed(2)}pp · ` +
        `Δ median: ${capped.medianDays - baseline.medianDays}d`,
    );

    expect(capped.windows).toBeGreaterThan(50);
  });
});
