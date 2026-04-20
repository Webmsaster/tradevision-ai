/**
 * Iter 142 — 5-gate validation of iter141 F1+T2 winner.
 *
 * Config: iter135 + funding>0.0001 skip + taker-buy-ratio ≥ 0.48 entry gate.
 * In-sample (2083d): n=1205, WR 59.7%, mean 0.050%, Sharpe 14.32, bs+ 100%,
 * bs5% +43.7%, pctProf 100%, minW +1.6% (every 10-window profitable).
 *
 * Gates:
 *   G1 full: n ≥ 500, Sharpe ≥ 10, bs+ ≥ 95%, pctProf ≥ 90%, minW ≥ 0
 *   G2 quarters: all 4 positive
 *   G3 TBR sweep {0.46, 0.48, 0.50, 0.52}: all Sharpe ≥ 9
 *   G4 sensitivity 10 variants: ≥ 70% pass Sharpe ≥ 8 & mean ≥ 0.03%
 *   G5 OOS 60/40: Sharpe ≥ 7, mean ≥ 0.03%, bs+ ≥ 85%
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchFundingHistory } from "../src/utils/fundingRate";
import {
  BTC_INTRADAY_CONFIG,
  type BtcIntradayConfig,
} from "../src/utils/btcIntraday";
import type { Candle } from "../src/utils/indicators";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";

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

interface FilterParams {
  fundingRateThreshold: number; // skip if funding > this (default 0.0001)
  tbrMin: number; // min taker-buy ratio (default 0.48)
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

function mapFunding(
  candles: Candle[],
  funding: { fundingTime: number; fundingRate: number }[],
): number[] {
  const rate: number[] = new Array(candles.length).fill(NaN);
  if (funding.length === 0) return rate;
  const sorted = [...funding].sort((a, b) => a.fundingTime - b.fundingTime);
  let j = 0;
  for (let i = 0; i < candles.length; i++) {
    const t = candles[i].openTime;
    while (j + 1 < sorted.length && sorted[j + 1].fundingTime <= t) j++;
    if (sorted[j].fundingTime <= t) rate[i] = sorted[j].fundingRate;
  }
  return rate;
}

function run(
  candles: Candle[],
  rateArr: number[],
  fp: FilterParams,
  cfg: BtcIntradayConfig = BTC_INTRADAY_CONFIG,
): Trade[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);
  const takerBuys = candles.map((c) => c.takerBuyVolume ?? c.volume / 2);
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
    if (
      fp.fundingRateThreshold > 0 &&
      isFinite(rateArr[i]) &&
      rateArr[i] > fp.fundingRateThreshold
    )
      continue;
    if (fp.tbrMin > 0 && volumes[i] > 0) {
      const tbr = takerBuys[i] / volumes[i];
      if (tbr < fp.tbrMin) continue;
    }

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

function stats(trades: Trade[], days: number, bpw: number, seed: number) {
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const mean =
    trades.length > 0 ? pnls.reduce((a, p) => a + p, 0) / pnls.length : 0;
  const sh = sharpeOf(pnls);
  const tpd = trades.length / days;
  const wr = trades.length > 0 ? wins / trades.length : 0;
  const winRet: number[] = [];
  for (let w = 0; w < 10; w++) {
    const lo = w * bpw;
    const hi = (w + 1) * bpw;
    const wt = trades.filter((t) => t.openBar >= lo && t.openBar < hi);
    winRet.push(wt.reduce((a, t) => a * (1 + t.pnl), 1) - 1);
  }
  const pctProf = winRet.filter((r) => r > 0).length / winRet.length;
  const minWin = Math.min(...winRet);
  const bs = bootstrap(
    pnls,
    100,
    Math.max(10, Math.floor(pnls.length / 15)),
    seed,
  );
  return { n: trades.length, tpd, wr, ret, sh, mean, pctProf, minWin, bs };
}

const BASE: FilterParams = { fundingRateThreshold: 0.0001, tbrMin: 0.48 };

describe("iter 142 — 5-gate F1+T2", () => {
  it(
    "full battery on funding+tbr combined filter",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 142: 5-gate F1+T2 ===");
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

      console.log("loading funding history...");
      const funding = await fetchFundingHistory("BTCUSDT", 10_000);
      const rateArr = mapFunding(c, funding);
      console.log(`funding=${funding.length} events mapped`);

      // G1
      const tAll = run(c, rateArr, BASE);
      const s = stats(tAll, days, bpw, 777);
      console.log(
        `\nG1 FULL n=${s.n} tpd=${s.tpd.toFixed(2)} WR=${(s.wr * 100).toFixed(1)}% mean=${(s.mean * 100).toFixed(3)}% ret=${(s.ret * 100).toFixed(1)}% Shp=${s.sh.toFixed(2)} bs+=${(s.bs.pctPositive * 100).toFixed(0)}% bs5%=${(s.bs.p5 * 100).toFixed(1)}% pctProf=${(s.pctProf * 100).toFixed(0)}% minW=${(s.minWin * 100).toFixed(1)}%`,
      );
      const g1 =
        s.n >= 500 &&
        s.sh >= 10 &&
        s.bs.pctPositive >= 0.95 &&
        s.pctProf >= 0.9 &&
        s.minWin >= 0;

      // G2
      const qSize = Math.floor(c.length / 4);
      const qRet: number[] = [];
      console.log("G2 quarters:");
      for (let k = 0; k < 4; k++) {
        const sub = c.slice(k * qSize, (k + 1) * qSize);
        const subRate = mapFunding(sub, funding);
        const tq = run(sub, subRate, BASE);
        const ss = stats(
          tq,
          sub.length / 24,
          Math.floor(sub.length / 10),
          100 + k,
        );
        qRet.push(ss.ret);
        console.log(
          `  Q${k + 1} n=${ss.n} tpd=${ss.tpd.toFixed(2)} WR=${(ss.wr * 100).toFixed(1)}% mean=${(ss.mean * 100).toFixed(3)}% ret=${(ss.ret * 100).toFixed(1)}% Shp=${ss.sh.toFixed(2)}`,
        );
      }
      const g2 = qRet.every((r) => r > 0);

      // G3 TBR sweep
      console.log("G3 TBR sweep:");
      let g3 = true;
      for (const tbr of [0.46, 0.48, 0.5, 0.52]) {
        const t = run(c, rateArr, { ...BASE, tbrMin: tbr });
        const ss = stats(t, days, bpw, 300 + Math.round(tbr * 100));
        if (ss.sh < 9) g3 = false;
        console.log(
          `  tbr=${tbr} n=${ss.n} mean=${(ss.mean * 100).toFixed(3)}% Shp=${ss.sh.toFixed(2)}`,
        );
      }

      // G4 sensitivity
      console.log("G4 sensitivity:");
      const vs: Array<{ label: string; fp: FilterParams }> = [
        { label: "funding 0.5bp", fp: { ...BASE, fundingRateThreshold: 5e-5 } },
        { label: "funding 2bp", fp: { ...BASE, fundingRateThreshold: 2e-4 } },
        { label: "tbr 0.46", fp: { ...BASE, tbrMin: 0.46 } },
        { label: "tbr 0.50", fp: { ...BASE, tbrMin: 0.5 } },
        { label: "no funding", fp: { ...BASE, fundingRateThreshold: 0 } },
        { label: "no tbr", fp: { ...BASE, tbrMin: 0 } },
        {
          label: "funding only",
          fp: { fundingRateThreshold: 1e-4, tbrMin: 0 },
        },
        { label: "tbr only", fp: { fundingRateThreshold: 0, tbrMin: 0.48 } },
        {
          label: "loose 0.47+0.5bp",
          fp: { fundingRateThreshold: 5e-5, tbrMin: 0.47 },
        },
        {
          label: "strict 0.5+2bp",
          fp: { fundingRateThreshold: 2e-4, tbrMin: 0.5 },
        },
      ];
      let vPass = 0;
      for (const v of vs) {
        const t = run(c, rateArr, v.fp);
        const ss = stats(t, days, bpw, 500);
        const ok = ss.sh >= 8 && ss.mean >= 0.0003 && ss.ret > 0;
        if (ok) vPass++;
        console.log(
          `  ${v.label.padEnd(18)} n=${ss.n.toString().padStart(4)} mean=${(ss.mean * 100).toFixed(3).padStart(6)}% Shp=${ss.sh.toFixed(2).padStart(5)} ${ok ? "★" : ""}`,
        );
      }
      const g4 = vPass / vs.length >= 0.7;
      console.log(`  passed ${vPass}/${vs.length}`);

      // G5 OOS
      const split = Math.floor(c.length * 0.6);
      const oosC = c.slice(split);
      const oosFunding = mapFunding(oosC, funding);
      const oosT = run(oosC, oosFunding, BASE);
      const oosS = stats(
        oosT,
        oosC.length / 24,
        Math.floor(oosC.length / 10),
        888,
      );
      console.log(
        `G5 OOS  n=${oosS.n} tpd=${oosS.tpd.toFixed(2)} WR=${(oosS.wr * 100).toFixed(1)}% mean=${(oosS.mean * 100).toFixed(3)}% ret=${(oosS.ret * 100).toFixed(1)}% Shp=${oosS.sh.toFixed(2)} bs+=${(oosS.bs.pctPositive * 100).toFixed(0)}%`,
      );
      const g5 =
        oosS.sh >= 7 && oosS.mean >= 0.0003 && oosS.bs.pctPositive >= 0.85;

      console.log(
        `\n── VERDICT ──\nG1=${g1 ? "✓" : "✗"} G2=${g2 ? "✓" : "✗"} G3=${g3 ? "✓" : "✗"} G4=${g4 ? "✓" : "✗"} G5=${g5 ? "✓" : "✗"}  ${g1 && g2 && g3 && g4 && g5 ? "★★★ ALL PASS ★★★" : "— fails"}`,
      );
    },
  );
});
