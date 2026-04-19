/**
 * Iter 49: Fine-grained scaling-out sweep with vol-regime filter.
 *
 * iter48 found SUI mom htf+micro+be tp0.5/3.0 passes 4 of 5 bootstrap
 * criteria (medSh 1.13, medWR 76.9%, minWR 63.2%, pctProf 80%), ONLY
 * minSh (-0.78) fails. One bad bootstrap window is killing the lock.
 *
 * Hypothesis: adding a vol-regime or avoid-hours filter eliminates the
 * bad regime. Test:
 *   - finer tp1 options (0.3/0.4/0.5/0.6/0.8/1.0%)
 *   - tp2 options (2/2.5/3/4%)
 *   - vol-regime filter (30-80 percentile) on/off
 *   - avoid-hours (funding + low-liq) on/off
 *   - stop multipliers (1.5x/1.8x/2.0x/2.5x original)
 *   - all 7 locked-edge coins
 *
 * Lock criteria (full): medSh≥1 AND minSh≥0 AND medWR≥70 AND minWR≥60 AND pctProf≥80.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  LOCKED_EDGES,
  lockedEdgeBinanceSymbol,
} from "../src/utils/volumeSpikeSignal";
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
  volRegime?: { loPct: number; hiPct: number };
  avoidHours?: number[];
}

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

function realizedVol(closes: number[], window = 24): number {
  const r: number[] = [];
  for (let i = Math.max(1, closes.length - window); i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue;
    r.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(s.length * p);
  return s[Math.min(s.length - 1, Math.max(0, idx))];
}

function computeLeg(
  entry: number,
  exit: number,
  dir: "long" | "short",
): number {
  return dir === "long" ? (exit - entry) / entry : (entry - exit) / entry;
}

interface RunResult {
  trades: number;
  wr: number;
  sh: number;
  pf: number;
  ret: number;
}

function runScaleOut(candles: Candle[], cfg: Cfg): RunResult {
  // Pre-compute vol-regime thresholds if needed
  let volLoThr = 0;
  let volHiThr = Infinity;
  if (cfg.volRegime) {
    const rvs: number[] = [];
    const vwin = 96;
    for (let i = vwin; i < candles.length; i++) {
      rvs.push(
        realizedVol(
          candles.slice(i - vwin, i).map((c) => c.close),
          24,
        ),
      );
    }
    volLoThr = percentile(rvs, cfg.volRegime.loPct);
    volHiThr = percentile(rvs, cfg.volRegime.hiPct);
  }

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
    if (cfg.volRegime) {
      const rv = realizedVol(
        window.slice(-24).map((c) => c.close),
        24,
      );
      if (rv < volLoThr || rv > volHiThr) continue;
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

describe("iteration 49 — fine-grained scaling-out + vol-regime", () => {
  it("sweep + bootstrap lock", { timeout: 1_200_000 }, async () => {
    console.log("\n=== ITER 49: FINE-GRAINED SCALING-OUT ===");

    const uniqueSyms = Array.from(
      new Set(LOCKED_EDGES.map((e) => lockedEdgeBinanceSymbol(e.symbol))),
    );
    const data: Record<string, Candle[]> = {};
    for (const s of uniqueSyms) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "1h",
        targetCount: 10000,
      });
    }

    const tp1Options = [0.003, 0.004, 0.005, 0.006, 0.008, 0.01];
    const tp2Options = [0.02, 0.025, 0.03, 0.04];
    const stopMults = [1.5, 1.8, 2.2];
    const filters: Array<{
      name: string;
      htf: boolean;
      micro: boolean;
      vol?: { loPct: number; hiPct: number };
      avoid?: number[];
    }> = [
      { name: "htf+micro", htf: true, micro: true },
      {
        name: "htf+micro+vol",
        htf: true,
        micro: true,
        vol: { loPct: 0.3, hiPct: 0.8 },
      },
      {
        name: "htf+micro+avoid",
        htf: true,
        micro: true,
        avoid: [0, 8, 16, 5, 6],
      },
      {
        name: "all",
        htf: true,
        micro: true,
        vol: { loPct: 0.3, hiPct: 0.8 },
        avoid: [0, 8, 16, 5, 6],
      },
    ];

    interface CandRow {
      edge: string;
      sym: string;
      filtName: string;
      htf: boolean;
      micro: boolean;
      vol?: { loPct: number; hiPct: number };
      avoid?: number[];
      tp1: number;
      tp2: number;
      stopMult: number;
      n: number;
      wr: number;
      sh: number;
    }
    const candidates: CandRow[] = [];

    for (const edge of LOCKED_EDGES) {
      const sym = lockedEdgeBinanceSymbol(edge.symbol);
      const baseLabel = `${sym.replace("USDT", "")} ${edge.cfg.mode}`;
      for (const filt of filters) {
        for (const tp1 of tp1Options) {
          for (const tp2 of tp2Options) {
            if (tp2 <= tp1 * 2) continue;
            for (const sm of stopMults) {
              const r = runScaleOut(data[sym], {
                lookback: edge.cfg.lookback,
                volMult: edge.cfg.volMult,
                priceZ: edge.cfg.priceZ,
                tp1Pct: tp1,
                tp2Pct: tp2,
                stopPct: edge.cfg.stopPct * sm,
                holdBars: edge.cfg.holdBars,
                mode: edge.cfg.mode,
                htfTrend: filt.htf,
                microPullback: filt.micro,
                useBreakeven: true,
                volRegime: filt.vol,
                avoidHours: filt.avoid,
              });
              if (r.trades < 30) continue;
              if (r.wr < 0.7 || r.sh < 1.0 || r.ret <= 0) continue;
              candidates.push({
                edge: baseLabel,
                sym,
                filtName: filt.name,
                htf: filt.htf,
                micro: filt.micro,
                vol: filt.vol,
                avoid: filt.avoid,
                tp1,
                tp2,
                stopMult: sm,
                n: r.trades,
                wr: r.wr,
                sh: r.sh,
              });
            }
          }
        }
      }
    }

    console.log(
      `\n=> ${candidates.length} full-history candidates with WR≥70, Sh≥1, ret>0`,
    );
    console.log(
      "edge".padEnd(16) +
        "filt".padEnd(18) +
        "tp1/tp2/stM".padStart(14) +
        "n".padStart(5) +
        "WR%".padStart(7) +
        "Sh".padStart(7),
    );
    const topByWR = [...candidates].sort((a, b) => b.wr - a.wr).slice(0, 25);
    for (const c of topByWR) {
      console.log(
        c.edge.padEnd(16) +
          c.filtName.padEnd(18) +
          `${(c.tp1 * 100).toFixed(2)}/${(c.tp2 * 100).toFixed(1)}/x${c.stopMult.toFixed(1)}`.padStart(
            14,
          ) +
          c.n.toString().padStart(5) +
          (c.wr * 100).toFixed(1).padStart(7) +
          c.sh.toFixed(2).padStart(7),
      );
    }

    if (candidates.length === 0) {
      console.log("Kein Kandidat passiert Single-Split. Iter49 schließen.");
      return;
    }

    // Bootstrap-lock top ~15 by Sharpe (but ensure WR >= 70%)
    const topForBootstrap = [...candidates]
      .sort((a, b) => b.sh - a.sh)
      .slice(0, 15);

    console.log("\n=== Bootstrap lock (10 windows) ===");
    console.log(
      "edge".padEnd(16) +
        "filt".padEnd(18) +
        "tp1/tp2/stM".padStart(14) +
        "medSh".padStart(8) +
        "minSh".padStart(8) +
        "medWR".padStart(8) +
        "minWR".padStart(8) +
        "pctProf".padStart(9) +
        " verdict",
    );
    let locked = 0;
    const lockRecords: string[] = [];
    for (const c of topForBootstrap) {
      const edge = LOCKED_EDGES.find(
        (e) =>
          lockedEdgeBinanceSymbol(e.symbol) === c.sym &&
          `${c.sym.replace("USDT", "")} ${e.cfg.mode}` === c.edge,
      );
      if (!edge) continue;

      const sharpes: number[] = [];
      const wrs: number[] = [];
      const rets: number[] = [];
      const full = data[c.sym];
      const cfg: Cfg = {
        lookback: edge.cfg.lookback,
        volMult: edge.cfg.volMult,
        priceZ: edge.cfg.priceZ,
        tp1Pct: c.tp1,
        tp2Pct: c.tp2,
        stopPct: edge.cfg.stopPct * c.stopMult,
        holdBars: edge.cfg.holdBars,
        mode: edge.cfg.mode,
        htfTrend: c.htf,
        microPullback: c.micro,
        useBreakeven: true,
        volRegime: c.vol,
        avoidHours: c.avoid,
      };
      for (const oos of chronoSplits(full)) {
        const r = runScaleOut(oos, cfg);
        if (r.trades < 10) continue;
        sharpes.push(r.sh);
        wrs.push(r.wr);
        rets.push(r.ret * 100);
      }
      for (let i2 = 0; i2 < 4; i2++) {
        const sample = blockBootstrap(full, 720, 6, 1234 + i2 * 17);
        const r = runScaleOut(sample, cfg);
        if (r.trades < 10) continue;
        sharpes.push(r.sh);
        wrs.push(r.wr);
        rets.push(r.ret * 100);
      }
      if (sharpes.length === 0) continue;

      const medSh = pct(sharpes, 0.5);
      const minSh = Math.min(...sharpes);
      const medWR = pct(wrs, 0.5);
      const minWR = Math.min(...wrs);
      const pctProf = rets.filter((v) => v > 0).length / rets.length;
      const passed =
        medSh >= 1.0 &&
        minSh >= 0.0 &&
        pctProf >= 0.8 &&
        medWR >= 0.7 &&
        minWR >= 0.6;
      console.log(
        c.edge.padEnd(16) +
          c.filtName.padEnd(18) +
          `${(c.tp1 * 100).toFixed(2)}/${(c.tp2 * 100).toFixed(1)}/x${c.stopMult.toFixed(1)}`.padStart(
            14,
          ) +
          medSh.toFixed(2).padStart(8) +
          minSh.toFixed(2).padStart(8) +
          (medWR * 100).toFixed(1).padStart(8) +
          (minWR * 100).toFixed(1).padStart(8) +
          (pctProf * 100).toFixed(0).padStart(8) +
          "%" +
          (passed ? "  ★ LOCK" : "  drop"),
      );
      if (passed) {
        locked++;
        lockRecords.push(
          `${c.edge} filt=${c.filtName} tp1=${(c.tp1 * 100).toFixed(2)}/tp2=${(c.tp2 * 100).toFixed(1)}/stM=${c.stopMult} medSh=${medSh.toFixed(2)} medWR=${(medWR * 100).toFixed(1)}% minWR=${(minWR * 100).toFixed(1)}%`,
        );
      }
    }

    console.log(`\n★ Bootstrap-locked: ${locked}`);
    for (const s of lockRecords) console.log(`  ${s}`);
  });
});
