/**
 * Iter 140 — funding-rate filter on iter135 baseline.
 *
 * Hypothesis: extreme positive funding = crowded longs = higher stop-out rate
 * on long entries. Filtering those bars should raise WR and mean/trade.
 *
 * Pull full Binance perpetual funding history (~6200 events since Sep 2019,
 * 8h intervals). Map each 1h candle to its most-recent funding event. Test
 * several skip thresholds:
 *   F1: skip if funding > 0.0001 (0.01% per 8h)
 *   F2: skip if funding > 0.0002 (0.02% per 8h)
 *   F3: skip if funding > 0.0003 (0.03% per 8h, "extreme" in analyzeFunding)
 *   F4: skip if zScore > 1.5 vs trailing-90-event window
 *   F5: skip if zScore > 2.0
 *   F6: skip if BOTH funding > 0.0001 AND zScore > 1 (robust)
 *
 * Baseline iter135 (no funding filter): Sharpe 10.15, mean 0.035%, tpd 1.20
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchFundingHistory } from "../src/utils/fundingRate";
import {
  runBtcIntraday,
  BTC_INTRADAY_CONFIG,
  type BtcIntradayConfig,
} from "../src/utils/btcIntraday";
import type { Candle } from "../src/utils/indicators";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";

// We re-implement the runner here so we can accept a per-bar skipFlag mask.
// (runBtcIntraday doesn't expose per-bar filters externally.)

function smaLast(v: number[], n: number): number {
  if (v.length < n) return v[v.length - 1] ?? 0;
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function medianLast(v: number[], n: number): number {
  if (v.length < n) return 0;
  const s = [...v.slice(-n)].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function maxLast(v: number[], n: number): number {
  const s = v.slice(-n);
  let m = -Infinity;
  for (const x of s) if (x > m) m = x;
  return m;
}
function atrSeries(candles: Candle[], len: number): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < len + 1) return out;
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
  }
  let sum = 0;
  for (let i = 1; i <= len; i++) sum += tr[i];
  out[len] = sum / len;
  for (let i = len + 1; i < candles.length; i++) {
    out[i] = (out[i - 1] * (len - 1) + tr[i]) / len;
  }
  return out;
}
function rsiSeries(closes: number[], len: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= len) return out;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss += -d;
  }
  gain /= len;
  loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (len - 1) + g) / len;
    loss = (loss * (len - 1) + l) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function sharpeOf(pnls: number[]): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(365 * 24);
}
function bootstrap(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): { pctPositive: number; p5: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, p5: 0 };
  let s = seed;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const rets: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sampled: number[] = [];
    const nBlocks = Math.ceil(pnls.length / blockLen);
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * Math.max(1, pnls.length - blockLen));
      for (let k = 0; k < blockLen; k++) sampled.push(pnls[start + k]);
    }
    const ret = sampled.reduce((a, p) => a * (1 + p), 1) - 1;
    rets.push(ret);
  }
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    pctPositive: rets.filter((r) => r > 0).length / rets.length,
    p5: sorted[Math.floor(sorted.length * 0.05)],
  };
}

type Mech = "M1" | "M4" | "M5" | "M6";

interface Trade {
  pnl: number;
  openBar: number;
}

/**
 * Map each candle bar index to the most-recent funding event rate and z-score.
 * funding events are spaced 8h apart; returns arrays aligned to candles[].
 */
function mapFunding(
  candles: Candle[],
  funding: { fundingTime: number; fundingRate: number }[],
): { rate: number[]; z: number[] } {
  const rate: number[] = new Array(candles.length).fill(NaN);
  const z: number[] = new Array(candles.length).fill(NaN);
  if (funding.length === 0) return { rate, z };
  const sorted = [...funding].sort((a, b) => a.fundingTime - b.fundingTime);
  let j = 0;
  for (let i = 0; i < candles.length; i++) {
    const t = candles[i].openTime;
    while (j + 1 < sorted.length && sorted[j + 1].fundingTime <= t) j++;
    if (sorted[j].fundingTime <= t) {
      rate[i] = sorted[j].fundingRate;
      // compute z-score from trailing 90 events up to j-1
      const lo = Math.max(0, j - 90);
      if (j > 10) {
        const win = sorted.slice(lo, j).map((e) => e.fundingRate);
        const m = win.reduce((a, b) => a + b, 0) / win.length;
        const v = win.reduce((a, b) => a + (b - m) * (b - m), 0) / win.length;
        const sd = Math.sqrt(v);
        z[i] = sd > 0 ? (rate[i] - m) / sd : 0;
      } else {
        z[i] = 0;
      }
    }
  }
  return { rate, z };
}

function executeLong(
  candles: Candle[],
  atr: number[],
  i: number,
  cfg: BtcIntradayConfig,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const atrI = atr[i];
  if (!isFinite(atrI) || atrI <= 0) return null;
  const tp1L = entry * (1 + cfg.tp1Pct);
  const tp2L = entry + (cfg.tpAtrMult ?? 8) * atrI;
  let sL = entry * (1 - cfg.stopPct);
  const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
  let tp1Hit = false;
  let tp1Bar = -1;
  let l2P = candles[mx].close;
  let l2B = mx;
  for (let j = i + 2; j <= mx; j++) {
    const bar = candles[j];
    if (!tp1Hit) {
      if (bar.low <= sL) {
        l2B = j;
        l2P = sL;
        break;
      }
      if (bar.high >= tp1L) {
        tp1Hit = true;
        tp1Bar = j;
        sL = entry;
        if (bar.high >= tp2L) {
          l2B = j;
          l2P = tp2L;
          break;
        }
        continue;
      }
    } else {
      if (bar.low <= sL) {
        l2B = j;
        l2P = sL;
        break;
      }
      if (bar.high >= tp2L) {
        l2B = j;
        l2P = tp2L;
        break;
      }
    }
  }
  const leg2 = applyCosts({
    entry,
    exit: l2P,
    direction: "long",
    holdingHours: l2B - (i + 1),
    config: MAKER_COSTS,
  }).netPnlPct;
  const leg1 = tp1Hit
    ? applyCosts({
        entry,
        exit: tp1L,
        direction: "long",
        holdingHours: tp1Bar - (i + 1),
        config: MAKER_COSTS,
      }).netPnlPct
    : leg2;
  return { exitBar: l2B, pnl: 0.5 * leg1 + 0.5 * leg2 };
}

function fireM(
  candles: Candle[],
  closes: number[],
  highs: number[],
  r7: number[],
  i: number,
  m: Mech,
  cfg: BtcIntradayConfig,
): boolean {
  switch (m) {
    case "M1":
      if (i < 2) return false;
      return closes[i] < closes[i - 1] && closes[i - 1] < closes[i - 2];
    case "M4":
      if (i <= cfg.rsiLen) return false;
      return r7[i] <= cfg.rsiTh;
    case "M5": {
      if (i < cfg.nHi + 1) return false;
      return candles[i].close > maxLast(highs.slice(i - cfg.nHi, i), cfg.nHi);
    }
    case "M6": {
      const o = candles[i].open;
      const c = candles[i].close;
      if (o <= 0) return false;
      return (c - o) / o <= -cfg.redPct;
    }
  }
}

interface FundingSkip {
  /** Returns true if this bar should be SKIPPED (filter fails). */
  skip: (rate: number, z: number) => boolean;
  label: string;
}

function runWithFundingFilter(
  candles: Candle[],
  rateArr: number[],
  zArr: number[],
  filter: FundingSkip,
  cfg: BtcIntradayConfig = BTC_INTRADAY_CONFIG,
): Trade[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);
  const r7 = rsiSeries(closes, cfg.rsiLen);
  const atr = atrSeries(candles, cfg.atrLen ?? 14);

  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = cfg.htfLen; i < candles.length; i++) {
    const s = smaLast(closes.slice(i - cfg.htfLen, i), cfg.htfLen);
    trendMask[i] = candles[i].close > s;
  }
  const macroMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = cfg.macro30dBars; i < candles.length; i++) {
    const past = closes[i - cfg.macro30dBars];
    if (past > 0) macroMask[i] = (closes[i] - past) / past > 0;
  }
  const volumeMult = cfg.volumeMult ?? 0;
  const volumeMedianLen = cfg.volumeMedianLen ?? 96;
  const volMedian: number[] = new Array(candles.length).fill(0);
  if (volumeMult > 0 && volumeMedianLen > 0) {
    for (let i = volumeMedianLen; i < candles.length; i++) {
      volMedian[i] = medianLast(
        volumes.slice(i - volumeMedianLen, i),
        volumeMedianLen,
      );
    }
  }
  const avoidSet = new Set(cfg.avoidHoursUtc ?? []);
  const startIdx = Math.max(cfg.htfLen, cfg.macro30dBars, cfg.rsiLen + 1) + 2;
  const trades: Trade[] = [];
  const openExits: { exitBar: number; mech: Mech }[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];

  for (let i = startIdx; i < candles.length - 1; i++) {
    for (let k = openExits.length - 1; k >= 0; k--) {
      if (openExits[k].exitBar < i) openExits.splice(k, 1);
    }
    if (openExits.length >= cfg.maxConcurrent) continue;
    if (!trendMask[i] || !macroMask[i]) continue;
    const hr = new Date(candles[i].openTime).getUTCHours();
    if (avoidSet.has(hr)) continue;
    if (volumeMult > 0 && volumes[i] <= volumeMult * volMedian[i]) continue;
    // FUNDING FILTER
    if (isFinite(rateArr[i]) && filter.skip(rateArr[i], zArr[i])) continue;

    for (const m of mechs) {
      if (openExits.length >= cfg.maxConcurrent) break;
      if (openExits.some((o) => o.mech === m)) continue;
      if (!fireM(candles, closes, highs, r7, i, m, cfg)) continue;
      const r2 = executeLong(candles, atr, i, cfg);
      if (!r2) continue;
      trades.push({ pnl: r2.pnl / cfg.maxConcurrent, openBar: i });
      openExits.push({ exitBar: r2.exitBar, mech: m });
    }
  }
  return trades;
}

function reportStats(
  label: string,
  trades: Trade[],
  days: number,
  bpw: number,
  seed: number,
) {
  if (trades.length < 30) {
    console.log(`${label.padEnd(36)} n=${trades.length} — too few`);
    return;
  }
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
  const sh = sharpeOf(pnls);
  const tpd = trades.length / days;
  const wr = wins / trades.length;
  const bs = bootstrap(
    pnls,
    50,
    Math.max(10, Math.floor(pnls.length / 15)),
    seed,
  );
  const winRet: number[] = [];
  for (let w = 0; w < 10; w++) {
    const lo = w * bpw;
    const hi = (w + 1) * bpw;
    const wt = trades.filter((t) => t.openBar >= lo && t.openBar < hi);
    winRet.push(wt.reduce((a, t) => a * (1 + t.pnl), 1) - 1);
  }
  const pctProf = winRet.filter((r) => r > 0).length / winRet.length;
  const minWin = Math.min(...winRet);
  console.log(
    `${label.padEnd(36)} ${trades.length
      .toString()
      .padStart(5)} ${tpd.toFixed(2)} ${(wr * 100).toFixed(1).padStart(5)}% ${(
      mean * 100
    )
      .toFixed(3)
      .padStart(6)}% ${(ret * 100).toFixed(1).padStart(7)}% ${sh
      .toFixed(2)
      .padStart(5)} ${(bs.pctPositive * 100).toFixed(0).padStart(3)}% ${(
      bs.p5 * 100
    )
      .toFixed(1)
      .padStart(6)}% ${(pctProf * 100).toFixed(0).padStart(3)}% ${(minWin * 100)
      .toFixed(1)
      .padStart(6)}%`,
  );
}

describe("iter 140 — funding-rate filter", () => {
  it(
    "test funding-skip thresholds on iter135 baseline",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 140: funding-rate filter ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const days = c.length / 24;
      const bpw = Math.floor(c.length / 10);
      console.log(
        `loaded ${c.length} BTC 1h candles (${days.toFixed(0)} days)`,
      );

      console.log("loading funding history (may take a bit)...");
      const funding = await fetchFundingHistory("BTCUSDT", 10_000);
      console.log(`loaded ${funding.length} funding events`);
      if (funding.length < 500) {
        console.log("⚠ funding history too thin, skipping test");
        return;
      }
      const { rate: rateArr, z: zArr } = mapFunding(c, funding);
      const mapped = rateArr.filter((v) => isFinite(v)).length;
      console.log(`${mapped}/${c.length} candles mapped to funding event`);

      // Per-bar funding stats
      const finiteRates = rateArr.filter((v) => isFinite(v));
      finiteRates.sort((a, b) => a - b);
      const q = (p: number) =>
        finiteRates[Math.floor(finiteRates.length * p)] ?? 0;
      console.log(
        `funding percentiles: p10=${(q(0.1) * 10000).toFixed(2)}bps · p50=${(q(0.5) * 10000).toFixed(2)}bps · p90=${(q(0.9) * 10000).toFixed(2)}bps · max=${(finiteRates[finiteRates.length - 1] * 10000).toFixed(2)}bps`,
      );

      const filters: FundingSkip[] = [
        { label: "F0 baseline (no funding filter)", skip: () => false },
        { label: "F1 skip rate > 0.0001 (+0.01%/8h)", skip: (r) => r > 0.0001 },
        { label: "F2 skip rate > 0.0002 (+0.02%/8h)", skip: (r) => r > 0.0002 },
        { label: "F3 skip rate > 0.0003 (+0.03%/8h)", skip: (r) => r > 0.0003 },
        { label: "F4 skip z > 1.5", skip: (_, z) => z > 1.5 },
        { label: "F5 skip z > 2.0", skip: (_, z) => z > 2.0 },
        {
          label: "F6 skip rate>0.0001 AND z>1",
          skip: (r, z) => r > 0.0001 && z > 1,
        },
        {
          label: "F7 skip rate>0.0002 OR z>2",
          skip: (r, z) => r > 0.0002 || z > 2,
        },
        // Reverse hypothesis: only trade when funding is LOW (contrarian long)
        { label: "F8 TRADE only if rate < 0.00005", skip: (r) => !(r < 5e-5) },
        { label: "F9 TRADE only if z < 0", skip: (_, z) => !(z < 0) },
      ];

      console.log(
        "\nlabel                                n     tpd    WR      mean%    cumRet    Shp   bs+   bs5%    %prof  minW",
      );
      for (const f of filters) {
        const t = runWithFundingFilter(c, rateArr, zArr, f);
        reportStats(f.label, t, days, bpw, 42);
      }
    },
  );
});
