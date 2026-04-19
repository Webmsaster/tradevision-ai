/**
 * Iter 47: Bootstrap-robustness lock on iter46 WR ≥ 70% candidates.
 *
 * iter46 found 4 configs (all SUI momentum) with WR ≥ 70% + Sharpe ≥ 1 + ret>0
 * on the full history. Before we can call any of them production-ready, we
 * apply the same 10-window bootstrap from iter34 (6 chronological cuts +
 * 4 block-bootstrap resamples).
 *
 * Lock criteria: median Sharpe ≥ 1.0  AND  min Sharpe ≥ 0.0  AND  ≥80% of
 * splits profitable  AND  median WR ≥ 0.65 (slight relaxation from the single
 * best — we still need WR robustly high, not just on one window).
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
  tpPct: number;
  stopPct: number;
  holdBars: number;
  mode: "fade" | "momentum";
  htfTrend: boolean;
  microPullback: boolean;
  avoidHours: number[];
}

interface Candidate {
  label: string;
  symbol: string;
  cfg: Cfg;
}

const CANDIDATES: Candidate[] = [
  {
    label: "SUI mom htf+micro tp1.0/st2.5",
    symbol: "SUIUSDT",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      tpPct: 0.01,
      stopPct: 0.025,
      holdBars: 6,
      mode: "momentum",
      htfTrend: true,
      microPullback: true,
      avoidHours: [],
    },
  },
  {
    label: "SUI mom htf+micro tp1.0/st2.0",
    symbol: "SUIUSDT",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      tpPct: 0.01,
      stopPct: 0.02,
      holdBars: 6,
      mode: "momentum",
      htfTrend: true,
      microPullback: true,
      avoidHours: [],
    },
  },
  {
    label: "SUI mom all tp1.0/st2.5",
    symbol: "SUIUSDT",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      tpPct: 0.01,
      stopPct: 0.025,
      holdBars: 6,
      mode: "momentum",
      htfTrend: true,
      microPullback: true,
      avoidHours: [0, 8, 16, 5, 6],
    },
  },
  {
    label: "SUI mom micro tp1.0/st2.5",
    symbol: "SUIUSDT",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      tpPct: 0.01,
      stopPct: 0.025,
      holdBars: 6,
      mode: "momentum",
      htfTrend: false,
      microPullback: true,
      avoidHours: [],
    },
  },
  // Bonus: iter46 showed SUI mom htf+micro tp1.5/st2.5 had even higher Sharpe
  // (17.33, WR 69.2%) — close to 70% WR. Test too.
  {
    label: "SUI mom htf+micro tp1.5/st2.5",
    symbol: "SUIUSDT",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      tpPct: 0.015,
      stopPct: 0.025,
      holdBars: 6,
      mode: "momentum",
      htfTrend: true,
      microPullback: true,
      avoidHours: [],
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

function runCfg(candles: Candle[], cfg: Cfg): RunResult {
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

    if (cfg.avoidHours.length) {
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
    const tpLevel =
      direction === "long" ? entry * (1 + cfg.tpPct) : entry * (1 - cfg.tpPct);
    const stopLevel =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);
    let exitIdx = i + 1 + cfg.holdBars;
    if (exitIdx >= candles.length) exitIdx = candles.length - 1;
    let exitPrice = candles[exitIdx].close;
    for (let j = i + 2; j <= exitIdx; j++) {
      const bar = candles[j];
      const tpHit =
        direction === "long" ? bar.high >= tpLevel : bar.low <= tpLevel;
      const stopHit =
        direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
      if (tpHit && stopHit) {
        exitIdx = j;
        exitPrice = stopLevel;
        break;
      }
      if (tpHit) {
        exitIdx = j;
        exitPrice = tpLevel;
        break;
      }
      if (stopHit) {
        exitIdx = j;
        exitPrice = stopLevel;
        break;
      }
    }
    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction,
      holdingHours: exitIdx - (i + 1),
      config: MAKER_COSTS,
    });
    returns.push(cost.netPnlPct);
    totalTrades++;
    i = exitIdx;
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
  // Use trades-per-year annualization (consistent with rest of codebase)
  const periodBars = candles.length;
  const periodYears = periodBars / (24 * 365);
  const perYear = periodYears > 0 ? returns.length / periodYears : 0;
  const sh = sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0;

  return { trades: totalTrades, wr, sh, pf, ret: netRet };
}

function chronoSplits(candles: Candle[]): Candle[][] {
  const splits: Candle[][] = [];
  for (const r of [0.5, 0.55, 0.6, 0.65, 0.7, 0.75]) {
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

describe("iteration 47 — bootstrap lock on iter46 70%-WR candidates", () => {
  it("10-window bootstrap on 5 candidates", { timeout: 600_000 }, async () => {
    console.log("\n=== ITER 47: BOOTSTRAP LOCK OF 70%-WR CANDIDATES ===");

    const candles = await loadBinanceHistory({
      symbol: "SUIUSDT",
      timeframe: "1h",
      targetCount: 10000,
    });
    console.log(`SUIUSDT loaded: ${candles.length} bars`);

    interface BS {
      label: string;
      sharpes: number[];
      wrs: number[];
      rets: number[];
      trades: number[];
      medSh: number;
      minSh: number;
      medWR: number;
      minWR: number;
      pctProf: number;
      passed: boolean;
    }
    const results: BS[] = [];

    for (const cand of CANDIDATES) {
      const sharpes: number[] = [];
      const wrs: number[] = [];
      const rets: number[] = [];
      const trades: number[] = [];

      for (const oos of chronoSplits(candles)) {
        const r = runCfg(oos, cand.cfg);
        if (r.trades < 10) continue;
        sharpes.push(r.sh);
        wrs.push(r.wr);
        rets.push(r.ret * 100);
        trades.push(r.trades);
      }
      for (let i = 0; i < 4; i++) {
        const sample = blockBootstrap(candles, 720, 6, 1234 + i * 17);
        const r = runCfg(sample, cand.cfg);
        if (r.trades < 10) continue;
        sharpes.push(r.sh);
        wrs.push(r.wr);
        rets.push(r.ret * 100);
        trades.push(r.trades);
      }

      if (sharpes.length === 0) {
        console.log(`  ${cand.label}: no valid samples`);
        continue;
      }

      const medSh = pct(sharpes, 0.5);
      const minSh = Math.min(...sharpes);
      const medWR = pct(wrs, 0.5);
      const minWR = Math.min(...wrs);
      const pctProf = rets.filter((r) => r > 0).length / rets.length;
      const passed =
        medSh >= 1.0 && minSh >= 0.0 && pctProf >= 0.8 && medWR >= 0.65;

      results.push({
        label: cand.label,
        sharpes,
        wrs,
        rets,
        trades,
        medSh,
        minSh,
        medWR,
        minWR,
        pctProf,
        passed,
      });
    }

    console.log("\n=== RESULTS ===");
    console.log(
      "label".padEnd(34) +
        "n".padStart(4) +
        "minSh".padStart(8) +
        "medSh".padStart(8) +
        "medWR".padStart(8) +
        "minWR".padStart(8) +
        "pctProf".padStart(9) +
        " verdict",
    );
    for (const r of results.sort((a, b) => b.medSh - a.medSh)) {
      console.log(
        r.label.padEnd(34) +
          String(r.sharpes.length).padStart(4) +
          r.minSh.toFixed(2).padStart(8) +
          r.medSh.toFixed(2).padStart(8) +
          (r.medWR * 100).toFixed(1).padStart(8) +
          (r.minWR * 100).toFixed(1).padStart(8) +
          (r.pctProf * 100).toFixed(0).padStart(8) +
          "%" +
          (r.passed ? "  ★ LOCK" : "  drop"),
      );
    }

    const winners = results.filter((r) => r.passed);
    console.log(
      `\n★ Locked (medSh≥1 AND minSh≥0 AND medWR≥65 AND pctProf≥80): ${winners.length}`,
    );
    for (const w of winners) {
      console.log(
        `  ${w.label}  medSh ${w.medSh.toFixed(2)}  medWR ${(w.medWR * 100).toFixed(1)}%  minSh ${w.minSh.toFixed(2)}  minWR ${(w.minWR * 100).toFixed(1)}%`,
      );
    }
  });
});
