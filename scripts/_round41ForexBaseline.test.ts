/**
 * Round 41 — Forex Baseline (FTMO V5-style adapted for Major-Forex pairs).
 *
 * Hypothesis: Crypto vol (~50-100% annualized) makes FTMO 5%-DL/10%-TL caps
 * tight on 30d windows. Forex majors (EURUSD/GBPUSD/USDJPY/AUDUSD/USDCAD/
 * NZDUSD) run ~7-12% annualized vol → DL/TL hit far less often.
 *
 * Key engine adaptations from V5_QUARTZ (after exploratory tuning):
 *   - tighter stopPct (0.03 vs 0.05 crypto): forex daily-range ~0.5-0.8% on 2h
 *   - tighter tpPct (0.01 vs 0.02 crypto):   reversion edge tighter on FX
 *   - higher leverage (8 vs 2 crypto):       FX vol → multiply position sizing
 *   - higher mct (12 vs 4-10 crypto):        more concurrent uncorrelated FX trades
 *   - intradayDailyLossThrottle (3%):        cap entries before DL=5% violation
 *   - dailyPeakTrailingStop (1.5%):          lock realized intraday peaks
 *   - costBp 3 / slippageBp 1:                forex tight spreads
 *
 * Baseline output (Round 41): 94.48% engine pass-rate / 81.09% wr / 4d med.
 * Round 42 sweep found champion: sp0.035 tp0.0075 lev10 → 98.77% engine /
 *   99.38% with 6 majors aligned (Round 44 — 6-major basket optimal).
 * Round 43 V4-Sim validation: 99.39% drift +0.61pp (acceptance ≥50% massively
 *   exceeded; lev10 trades replicate live with near-zero drift).
 *
 * Source: Yahoo 1h candles → resampled to 2h via _loadForexHistory.ts.
 * Range: 2y (Yahoo intraday limit) → ~1.4y aligned across 6 majors.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import {
  loadForexMajors,
  alignForexCommon,
  FOREX_MAJORS,
} from "./_loadForexHistory";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/ROUND41_FOREX_BASELINE_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const BARS_PER_DAY_2H = 12;

export function makeForexAsset(yahoo: string): Daytrade24hAssetCfg {
  const stem = yahoo.replace(/=X$/, "");
  return {
    symbol: `${stem}-FX`,
    sourceSymbol: yahoo,
    costBp: 3,
    slippageBp: 1,
    swapBpPerDay: 0.5,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true, // V5-style mean-reversion
    disableShort: false, // forex has no inherent long-bias
    stopPct: 0.03,
    tpPct: 0.01,
    holdBars: 60,
  };
}

export function buildForexBaselineCfg(
  eligible: string[],
  override: Partial<FtmoDaytrade24hConfig> = {},
): FtmoDaytrade24hConfig {
  return {
    triggerBars: 1,
    leverage: 8,
    tpPct: 0.01,
    stopPct: 0.03,
    holdBars: 60,
    timeframe: "2h",
    maxConcurrentTrades: 12,
    assets: eligible.map(makeForexAsset),
    profitTarget: 0.08,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    maxDays: 30,
    pauseAtTargetReached: true,
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    dailyPeakTrailingStop: { trailDistance: 0.015 },
    intradayDailyLossThrottle: {
      hardLossThreshold: 0.03,
      softLossThreshold: 0.018,
      softFactor: 0.5,
    },
    // Forex active hours: London + NY overlap (8-20 UTC). Skip Asian
    // session lower-vol slot for cleaner reversion signals.
    allowedHoursUtc: [8, 10, 12, 14, 16, 18, 20],
    ...override,
  };
}

describe("Round 41 — Forex Baseline", { timeout: 60 * 60_000 }, () => {
  it("V5-style forex baseline pass-rate", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `ROUND 41 FOREX BASELINE ${new Date().toISOString()}\n`,
    );

    log(`Loading Yahoo forex 1h → resampled to 2h, range=2y...`);
    const data = await loadForexMajors(
      { timeframe: "2h", range: "2y" },
      FOREX_MAJORS,
    );
    for (const s of Object.keys(data)) {
      const n = data[s].length;
      const years = n / BARS_PER_DAY_2H / 365;
      log(`  ${s}: ${n} bars (${years.toFixed(2)}y)`);
    }
    const eligible = Object.keys(data).filter(
      (s) => data[s].length >= 30 * BARS_PER_DAY_2H,
    );
    if (eligible.length === 0) {
      log("FATAL: no eligible forex pairs.");
      expect(eligible.length).toBeGreaterThan(0);
      return;
    }

    const aligned = alignForexCommon(
      Object.fromEntries(eligible.map((s) => [s, data[s]])),
    );
    const minLen = Math.min(...eligible.map((s) => aligned[s].length));
    log(
      `\nAligned: ${eligible.length} pairs / ${minLen} bars / ${(minLen / BARS_PER_DAY_2H / 365).toFixed(2)}y\n`,
    );

    const winBars = 30 * BARS_PER_DAY_2H;
    const stepBars = 3 * BARS_PER_DAY_2H;
    const cfg = buildForexBaselineCfg(eligible);

    let passes = 0,
      windows = 0,
      tlFails = 0,
      dlFails = 0;
    let wins = 0,
      losses = 0;
    let sumPnl = 0;
    const passDays: number[] = [];
    let totalTrades = 0;

    for (let s = 0; s + winBars <= minLen; s += stepBars) {
      const sub: Record<string, Candle[]> = {};
      for (const sym of eligible) sub[sym] = aligned[sym].slice(s, s + winBars);
      const r = runFtmoDaytrade24h(sub, cfg);
      windows++;
      if (r.passed) {
        passes++;
        if (r.passDay !== undefined) passDays.push(r.passDay);
      }
      if (r.reason === "total_loss") tlFails++;
      if (r.reason === "daily_loss") dlFails++;
      for (const t of r.trades) {
        const ep = (t as { effPnl?: number }).effPnl;
        if (ep !== undefined) {
          sumPnl += ep;
          if (ep > 0) wins++;
          else if (ep < 0) losses++;
        }
      }
      totalTrades += r.trades.length;
    }
    passDays.sort((a, b) => a - b);
    const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
    const pr = passes / windows;
    const wr = wins + losses > 0 ? wins / (wins + losses) : 0;

    log(`\n========== Forex Baseline Results ==========`);
    log(`Pass-rate: ${(pr * 100).toFixed(2)}% (${passes}/${windows})`);
    log(`TL fails:  ${((tlFails / windows) * 100).toFixed(2)}% (${tlFails})`);
    log(`DL fails:  ${((dlFails / windows) * 100).toFixed(2)}% (${dlFails})`);
    log(`Pass-days p50/p90: ${pick(0.5)}d / ${pick(0.9)}d`);
    log(
      `Trade winrate: ${(wr * 100).toFixed(2)}% (W${wins}/L${losses}), avgPnl=${((sumPnl / totalTrades) * 100).toFixed(3)}%`,
    );
    log(`Avg trades/window: ${(totalTrades / windows).toFixed(1)}`);

    expect(passes).toBeGreaterThan(0);
  });
});
