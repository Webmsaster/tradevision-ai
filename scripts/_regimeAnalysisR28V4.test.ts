/**
 * Regime Analysis — re-run R28_V4 over 5.55y but classify each window's
 * starting regime, then compute pass-rate PER regime.
 *
 * Goal: find regimes where R28_V4 has <30% pass-rate. Skipping those
 * regimes in live deployment = pass-rate boost.
 *
 * Regimes (pure price-action, no funding-data dependency):
 *  - trend-up    : 168h BTC trend > +5% AND vol < 25% (1y annualised)
 *  - trend-down  : 168h BTC trend < -5%
 *  - chop        : |trend| ≤ 5% AND vol < 60%
 *  - high-vol    : vol ≥ 60% (regime-break)
 *  - calm        : |trend| ≤ 2% AND vol < 15%
 */
import { describe, it } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = "scripts/cache_bakeoff/regime_analysis.log";
writeFileSync(LOG_FILE, `[${new Date().toISOString()}] start\n`);
function plog(s: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`);
  console.log(s);
}

type Regime = "trend-up" | "trend-down" | "chop" | "high-vol" | "calm";

function classifyAt(candles: Candle[], startBarIdx: number): Regime {
  // Look at 168h = 7d = 7*48 = 336 bars (30m TF) BEFORE startBarIdx
  const lookback = 7 * 48;
  const from = Math.max(0, startBarIdx - lookback);
  const slice = candles.slice(from, startBarIdx);
  if (slice.length < 100) return "chop";
  const first = slice[0]!.close;
  const last = slice[slice.length - 1]!.close;
  const trend = (last - first) / first;
  // Realised vol: stdev of log-returns × sqrt(48*365) for annualised
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1]!.close > 0)
      rets.push(Math.log(slice[i]!.close / slice[i - 1]!.close));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length);
  const stdev = Math.sqrt(variance);
  const annualVol = stdev * Math.sqrt(48 * 365);

  if (annualVol >= 0.6) return "high-vol";
  if (Math.abs(trend) <= 0.02 && annualVol < 0.15) return "calm";
  if (trend > 0.05) return "trend-up";
  if (trend < -0.05) return "trend-down";
  return "chop";
}

describe("Regime Analysis R28_V4", { timeout: 90 * 60_000 }, () => {
  it("classifies pass-rate per regime", async () => {
    const cfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
      liveCaps:
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4.liveCaps ?? {
          maxStopPct: 0.05,
          maxRiskFrac: 0.4,
        },
    };
    const symbols = [
      "AAVEUSDT",
      "ADAUSDT",
      "BCHUSDT",
      "BNBUSDT",
      "BTCUSDT",
      "ETCUSDT",
      "ETHUSDT",
      "LTCUSDT",
      "XRPUSDT",
    ];
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const path = `${CACHE_DIR}/${s}_30m.json`;
      if (!existsSync(path)) {
        plog(`[error] missing cache ${path}`);
        return;
      }
      data[s] = JSON.parse(readFileSync(path, "utf-8")) as Candle[];
    }
    // Align to common timestamps
    const sets = symbols.map((s) => new Set(data[s]!.map((c) => c.openTime)));
    const common = [...sets[0]!]
      .filter((t) => sets.every((set) => set.has(t)))
      .sort((a, b) => a - b);
    const cs = new Set(common);
    const aligned: Record<string, Candle[]> = {};
    for (const s of symbols)
      aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
    const minBars = Math.min(...symbols.map((s) => aligned[s]!.length));
    plog(
      `[setup] ${symbols.length} syms, ${minBars} bars (${(minBars / 48 / 365).toFixed(2)}y)`,
    );

    const winBars = cfg.maxDays * 48;
    const stepBars = 14 * 48;
    const WARMUP = 5000;

    interface WinResult {
      start: number;
      regime: Regime;
      passed: boolean;
      reason: string;
      passDay?: number;
    }
    const results: WinResult[] = [];
    let n = 0;
    const tStart = Date.now();
    const btcCandles = aligned.BTCUSDT!;
    for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
      n++;
      const regime = classifyAt(btcCandles, start);
      const trimStart = start - WARMUP;
      const trimEnd = start + winBars;
      const trimmed: Record<string, Candle[]> = {};
      for (const k of Object.keys(aligned))
        trimmed[k] = aligned[k]!.slice(trimStart, trimEnd);
      try {
        const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, "regime");
        results.push({
          start,
          regime,
          passed: r.passed,
          reason: r.passed ? "pass" : r.reason,
          passDay: r.passDay,
        });
        if (n % 20 === 0)
          plog(
            `  [${n}] win @${start} regime=${regime} ${r.passed ? "PASS" : r.reason}`,
          );
      } catch (e) {
        plog(`[err] win @${start}: ${(e as Error).message}`);
      }
    }
    plog(`[done] ${n} windows in ${Math.round((Date.now() - tStart) / 1000)}s`);

    // Aggregate per regime
    const byRegime: Record<
      string,
      { total: number; pass: number; days: number[] }
    > = {};
    for (const r of results) {
      const k = r.regime;
      byRegime[k] ??= { total: 0, pass: 0, days: [] };
      byRegime[k]!.total++;
      if (r.passed) {
        byRegime[k]!.pass++;
        if (r.passDay) byRegime[k]!.days.push(r.passDay);
      }
    }
    plog("\n=== PASS-RATE PER REGIME ===");
    plog("regime       | total | pass | rate%  | median");
    plog("-------------+-------+------+--------+-------");
    const rows = Object.entries(byRegime).sort((a, b) => {
      const r1 = a[1].total > 0 ? a[1].pass / a[1].total : 0;
      const r2 = b[1].total > 0 ? b[1].pass / b[1].total : 0;
      return r2 - r1;
    });
    for (const [r, v] of rows) {
      v.days.sort((a, b) => a - b);
      const med =
        v.days.length > 0 ? v.days[Math.floor(v.days.length / 2)]! : 0;
      const rate = v.total > 0 ? (v.pass / v.total) * 100 : 0;
      plog(
        `${r.padEnd(12)} | ${String(v.total).padStart(5)} | ${String(v.pass).padStart(4)} | ${rate
          .toFixed(2)
          .padStart(6)} | ${med}d`,
      );
    }

    // What if we skip regimes < 30% pass-rate
    const blockList = rows
      .filter(([_, v]) => v.total >= 5 && v.pass / v.total < 0.3)
      .map(([r]) => r);
    if (blockList.length > 0) {
      const filtered = results.filter((r) => !blockList.includes(r.regime));
      const passes = filtered.filter((r) => r.passed).length;
      const rate = filtered.length > 0 ? (passes / filtered.length) * 100 : 0;
      const days = filtered
        .filter((r) => r.passed && r.passDay)
        .map((r) => r.passDay!)
        .sort((a, b) => a - b);
      const med = days.length > 0 ? days[Math.floor(days.length / 2)]! : 0;
      plog(
        `\n>>> WITH REGIME-GATE (skip ${blockList.join(",")}): ${passes}/${filtered.length} = ${rate.toFixed(2)}% / med ${med}d`,
      );
      plog(
        `vs unfiltered: ${results.filter((r) => r.passed).length}/${results.length} = ${(
          (results.filter((r) => r.passed).length / results.length) *
          100
        ).toFixed(2)}%`,
      );
    }
  });
});
