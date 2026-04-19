/**
 * Iter 50: Deep validation of iter49 top-3 WR candidates.
 *
 * iter49 found these top candidates for 70% WR target (scaling-out + BE stop):
 *   A) SUI mom htf+micro+avoid tp1=0.5/tp2=4.0/stM=2.2 — medWR 78.3%, medSh 1.16, minSh -0.19
 *   B) SUI mom htf+micro+avoid tp1=0.8/tp2=3.0/stM=2.2 — medWR 71.4%, medSh 1.21, minSh -0.18
 *   C) SUI mom htf+micro+avoid tp1=0.8/tp2=4.0/stM=2.2 — medWR 69.6%, medSh 1.23, minSh -0.08
 *
 * This iteration runs a DEEPER bootstrap (20 windows instead of 10) and
 * applies an industry-standard p25-Sharpe criterion.
 *
 * Per-window details will be printed so we can see whether the "bad" windows
 * are structural (a regime the strategy simply can't trade in, which would
 * need filtering) or random (occasional noise).
 *
 * Lock criteria (industry-standard):
 *   medSh ≥ 1.0 AND p25Sh ≥ 0.0 AND medWR ≥ 0.70 AND minWR ≥ 0.60 AND pctProf ≥ 80%.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { applyCosts } from "../src/utils/costModel";
import type { Candle } from "../src/utils/indicators";

interface Cfg {
  lookback: number;
  volMult: number;
  priceZ: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  mode: "fade" | "momentum";
  htfTrend: boolean;
  microPullback: boolean;
  useBreakeven: boolean;
  avoidHours?: number[];
}

interface Cand {
  label: string;
  cfg: Cfg;
}

const BASE: Cfg = {
  lookback: 48,
  volMult: 3,
  priceZ: 2.0,
  tp1Pct: 0,
  tp2Pct: 0,
  stopPct: 0,
  holdBars: 6,
  mode: "momentum",
  htfTrend: true,
  microPullback: true,
  useBreakeven: true,
  avoidHours: [0, 8, 16, 5, 6],
};

const CANDIDATES: Cand[] = [
  {
    label: "A) tp1=0.5 tp2=4.0 stM=2.2",
    cfg: {
      ...BASE,
      tp1Pct: 0.005,
      tp2Pct: 0.04,
      stopPct: 0.012 * 2.2,
    },
  },
  {
    label: "B) tp1=0.8 tp2=3.0 stM=2.2",
    cfg: {
      ...BASE,
      tp1Pct: 0.008,
      tp2Pct: 0.03,
      stopPct: 0.012 * 2.2,
    },
  },
  {
    label: "C) tp1=0.8 tp2=4.0 stM=2.2",
    cfg: {
      ...BASE,
      tp1Pct: 0.008,
      tp2Pct: 0.04,
      stopPct: 0.012 * 2.2,
    },
  },
  {
    label: "D) tp1=1.0 tp2=4.0 stM=2.2",
    cfg: {
      ...BASE,
      tp1Pct: 0.01,
      tp2Pct: 0.04,
      stopPct: 0.012 * 2.2,
    },
  },
  {
    label: "E) tp1=0.6 tp2=4.0 stM=2.2",
    cfg: {
      ...BASE,
      tp1Pct: 0.006,
      tp2Pct: 0.04,
      stopPct: 0.012 * 2.2,
    },
  },
];

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function stdReturns(closes: number[]): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue;
    r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}
function sma(vals: number[], period: number): number {
  const slice = vals.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

interface RunResult {
  trades: number;
  wr: number;
  sh: number;
  pf: number;
  ret: number;
}

function runScaleOut(candles: Candle[], cfg: Cfg): RunResult {
  const returns: number[] = [];
  let totalTrades = 0;

  for (let i = cfg.lookback; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0) continue;
    const window = candles.slice(i - cfg.lookback, i);
    const medVol = median(window.map((c) => c.volume));
    if (medVol <= 0) continue;
    const vZ = cur.volume / medVol;
    if (vZ < cfg.volMult) continue;
    const sd = stdReturns(window.map((c) => c.close));
    if (sd <= 0) continue;
    const ret = (cur.close - prev.close) / prev.close;
    const pZ = Math.abs(ret) / sd;
    if (pZ < cfg.priceZ) continue;
    const direction: "long" | "short" =
      cfg.mode === "fade"
        ? ret > 0
          ? "short"
          : "long"
        : ret > 0
          ? "long"
          : "short";
    if (cfg.htfTrend) {
      const smaVal = sma(
        window.slice(-24).map((c) => c.close),
        24,
      );
      const alignedLong = cur.close > smaVal;
      if (direction === "long" && !alignedLong) continue;
      if (direction === "short" && alignedLong) continue;
    }
    if (cfg.avoidHours && cfg.avoidHours.length) {
      const h = new Date(cur.openTime).getUTCHours();
      if (cfg.avoidHours.includes(h)) continue;
    }
    if (cfg.microPullback) {
      const penult = candles[i - 1];
      const before = candles[i - 2];
      if (!penult || !before) continue;
      if (cfg.mode === "momentum") {
        const hadPullback =
          direction === "long"
            ? penult.close < before.close
            : penult.close > before.close;
        if (!hadPullback) continue;
      } else {
        const sameDir =
          ret > 0 ? penult.close > before.close : penult.close < before.close;
        if (!sameDir) continue;
      }
    }
    const entryBar = candles[i + 1];
    if (!entryBar) break;
    const entry = entryBar.open;
    const tp1Level =
      direction === "long"
        ? entry * (1 + cfg.tp1Pct)
        : entry * (1 - cfg.tp1Pct);
    const tp2Level =
      direction === "long"
        ? entry * (1 + cfg.tp2Pct)
        : entry * (1 - cfg.tp2Pct);
    let stopLevel =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);
    const maxExit = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1HitBar = -1;
    let leg2ExitPrice = candles[maxExit].close;
    let leg2ExitBar = maxExit;
    for (let j = i + 2; j <= maxExit; j++) {
      const bar = candles[j];
      const stopHit =
        direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
      const tp1Reached =
        direction === "long" ? bar.high >= tp1Level : bar.low <= tp1Level;
      const tp2Reached =
        direction === "long" ? bar.high >= tp2Level : bar.low <= tp2Level;
      if (!tp1Hit) {
        if (tp1Reached && stopHit) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          break;
        }
        if (stopHit) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          break;
        }
        if (tp1Reached) {
          tp1Hit = true;
          tp1HitBar = j;
          if (cfg.useBreakeven) stopLevel = entry;
          if (tp2Reached) {
            leg2ExitBar = j;
            leg2ExitPrice = tp2Level;
            break;
          }
          continue;
        }
      } else {
        const stopHitNow =
          direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
        const tp2ReachedNow =
          direction === "long" ? bar.high >= tp2Level : bar.low <= tp2Level;
        if (tp2ReachedNow && stopHitNow) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          break;
        }
        if (tp2ReachedNow) {
          leg2ExitBar = j;
          leg2ExitPrice = tp2Level;
          break;
        }
        if (stopHitNow) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          break;
        }
      }
    }
    const leg2Cost = applyCosts({
      entry,
      exit: leg2ExitPrice,
      direction,
      holdingHours: leg2ExitBar - (i + 1),
      config: MAKER_COSTS,
    });
    const leg2Pnl = leg2Cost.netPnlPct;
    let leg1Net: number;
    if (tp1Hit) {
      const leg1Cost = applyCosts({
        entry,
        exit: tp1Level,
        direction,
        holdingHours: tp1HitBar - (i + 1),
        config: MAKER_COSTS,
      });
      leg1Net = leg1Cost.netPnlPct;
    } else {
      leg1Net = leg2Pnl;
    }
    const totalNet = 0.5 * leg1Net + 0.5 * leg2Pnl;
    returns.push(totalNet);
    totalTrades++;
    i = leg2ExitBar;
  }
  const netRet = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const wr = returns.length > 0 ? wins / returns.length : 0;
  const grossW = returns.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const grossL = Math.abs(
    returns.filter((r) => r < 0).reduce((s, v) => s + v, 0),
  );
  const pf = grossL > 0 ? grossW / grossL : returns.length > 0 ? 999 : 0;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const sd = Math.sqrt(v);
  const periodYears = candles.length / (24 * 365);
  const perYear = periodYears > 0 ? returns.length / periodYears : 0;
  const sh = sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0;
  return { trades: totalTrades, wr, sh, pf, ret: netRet };
}

function chronoSplits(candles: Candle[]): Candle[][] {
  const splits: Candle[][] = [];
  for (const r of [
    0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8,
  ]) {
    const cut = Math.floor(candles.length * r);
    splits.push(candles.slice(cut));
  }
  return splits;
}

function blockBootstrap(
  candles: Candle[],
  blockBars: number,
  n: number,
  seed: number,
): Candle[] {
  const blocks: Candle[][] = [];
  for (let i = 0; i + blockBars <= candles.length; i += blockBars) {
    blocks.push(candles.slice(i, i + blockBars));
  }
  let s = seed;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked: Candle[] = [];
  const want = Math.min(n, blocks.length);
  const used = new Set<number>();
  while (picked.length < want * blockBars) {
    const idx = Math.floor(rand() * blocks.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(...blocks[idx]);
  }
  let t = candles[0]?.openTime ?? 0;
  return picked.map((c) => {
    const out = { ...c, openTime: t, closeTime: t + 3_599_999 };
    t += 3_600_000;
    return out;
  });
}

function pct(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * q)];
}

describe("iteration 50 — deep bootstrap of top 70%-WR candidates", () => {
  it(
    "20-window bootstrap with per-window report",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 50: DEEP BOOTSTRAP ===");
      const candles = await loadBinanceHistory({
        symbol: "SUIUSDT",
        timeframe: "1h",
        targetCount: 10000,
      });
      console.log(`SUIUSDT: ${candles.length} bars`);

      interface Window {
        idx: number;
        kind: "chrono" | "bootstrap";
        trades: number;
        wr: number;
        sh: number;
        ret: number;
      }

      for (const cand of CANDIDATES) {
        const windows: Window[] = [];
        let idx = 0;
        for (const oos of chronoSplits(candles)) {
          const r = runScaleOut(oos, cand.cfg);
          if (r.trades < 10) {
            idx++;
            continue;
          }
          windows.push({
            idx: idx++,
            kind: "chrono",
            trades: r.trades,
            wr: r.wr,
            sh: r.sh,
            ret: r.ret * 100,
          });
        }
        for (let i2 = 0; i2 < 9; i2++) {
          const sample = blockBootstrap(candles, 720, 6, 1234 + i2 * 17);
          const r = runScaleOut(sample, cand.cfg);
          if (r.trades < 10) {
            idx++;
            continue;
          }
          windows.push({
            idx: idx++,
            kind: "bootstrap",
            trades: r.trades,
            wr: r.wr,
            sh: r.sh,
            ret: r.ret * 100,
          });
        }
        const shs = windows.map((w) => w.sh);
        const wrs = windows.map((w) => w.wr);
        const rets = windows.map((w) => w.ret);
        const medSh = pct(shs, 0.5);
        const p25Sh = pct(shs, 0.25);
        const minSh = Math.min(...shs);
        const medWR = pct(wrs, 0.5);
        const minWR = Math.min(...wrs);
        const pctProf = rets.filter((r) => r > 0).length / rets.length;
        const passed =
          medSh >= 1.0 &&
          p25Sh >= 0.0 &&
          medWR >= 0.7 &&
          minWR >= 0.6 &&
          pctProf >= 0.8;

        console.log(`\n== ${cand.label} (n=${windows.length}) ==`);
        console.log(
          "win#".padStart(5) +
            "kind".padStart(12) +
            "trades".padStart(8) +
            "WR%".padStart(7) +
            "Sh".padStart(8) +
            "ret%".padStart(9),
        );
        for (const w of windows) {
          console.log(
            w.idx.toString().padStart(5) +
              w.kind.padStart(12) +
              w.trades.toString().padStart(8) +
              (w.wr * 100).toFixed(1).padStart(7) +
              w.sh.toFixed(2).padStart(8) +
              w.ret.toFixed(1).padStart(9),
          );
        }
        console.log(
          `\n  Stats: medSh=${medSh.toFixed(2)}  p25Sh=${p25Sh.toFixed(2)}  minSh=${minSh.toFixed(2)}  medWR=${(medWR * 100).toFixed(1)}%  minWR=${(minWR * 100).toFixed(1)}%  pctProf=${(pctProf * 100).toFixed(0)}%`,
        );
        console.log(
          `  Lock (medSh≥1 ∧ p25Sh≥0 ∧ medWR≥70 ∧ minWR≥60 ∧ pctProf≥80): ${passed ? "★ PASS" : "drop"}`,
        );
      }
    },
  );
});
