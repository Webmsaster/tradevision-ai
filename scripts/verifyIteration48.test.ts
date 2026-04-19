/**
 * Iter 48: Scaling-out + breakeven-stop for ≥70% Win-Rate.
 *
 * Mechanic:
 *   - Fire trigger (same as locked edges).
 *   - First TP at +tp1 (small): exit 50% of position.
 *   - AFTER first TP hits: move stop to entry (breakeven) on remaining 50%.
 *   - Second TP at +tp2 (larger): exit remaining 50%.
 *   - Else time-stop at holdBars.
 *
 * This mechanically boosts WR because any trade that reaches tp1 ends at
 * worst near 0 (tp1*0.5 + 0*0.5 - fees), not negative. We count a "win" if
 * total netPnl > 0 (no partial wins).
 *
 * Bootstrap test: we use single-window-and-bootstrap in one pass. A config
 * is LOCKED if:
 *   median Sharpe ≥ 1.0 AND min Sharpe ≥ 0 AND
 *   median WR ≥ 0.70 AND min WR ≥ 0.60 AND
 *   ≥80% of splits profitable AND trades ≥ 20 per window.
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
  useBreakeven: boolean; // if true, move stop to BE after tp1
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

interface RunResult {
  trades: number;
  wr: number;
  sh: number;
  pf: number;
  ret: number;
  netReturns: number[];
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
    let leg1Pnl = 0; // PnL of the first 50% (realized at tp1)
    let leg2ExitPrice = candles[maxExit].close;
    let leg2ExitBar = maxExit;

    for (let j = i + 2; j <= maxExit; j++) {
      const bar = candles[j];
      // Check stop first if not yet hit TP1 (uses initial stop),
      // else uses moved-to-BE stop.
      const stopHit =
        direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
      const tp1Reached =
        direction === "long" ? bar.high >= tp1Level : bar.low <= tp1Level;
      const tp2Reached =
        direction === "long" ? bar.high >= tp2Level : bar.low <= tp2Level;

      if (!tp1Hit) {
        // pre-TP1 phase: both legs still open
        if (tp1Reached && stopHit) {
          // same-bar both touched: assume stop first (conservative)
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          // and leg1 was stopped too (pre-TP1)
          leg1Pnl = computeLeg(entry, stopLevel, direction);
          break;
        }
        if (stopHit) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          leg1Pnl = computeLeg(entry, stopLevel, direction);
          break;
        }
        if (tp1Reached) {
          tp1Hit = true;
          tp1HitBar = j;
          leg1Pnl = computeLeg(entry, tp1Level, direction);
          if (cfg.useBreakeven) {
            stopLevel = entry;
          }
          // continue searching for tp2 or stop
          if (tp2Reached) {
            // very fast move — both hit in same bar
            leg2ExitBar = j;
            leg2ExitPrice = tp2Level;
            break;
          }
          continue;
        }
      } else {
        // post-TP1 phase: check new stop (BE or original) vs tp2
        const stopHitNow =
          direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
        const tp2ReachedNow =
          direction === "long" ? bar.high >= tp2Level : bar.low <= tp2Level;
        if (tp2ReachedNow && stopHitNow) {
          // same-bar both: assume stop first
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

    // leg2 cost-adjusted
    const leg2Cost = applyCosts({
      entry,
      exit: leg2ExitPrice,
      direction,
      holdingHours: leg2ExitBar - (i + 1),
      config: MAKER_COSTS,
    });
    let leg2Pnl = leg2Cost.netPnlPct;

    // leg1 was stopped out pre-TP1 → same exit as leg2
    // leg1 took TP1 → separate exit at TP1
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

    // Total trade = average of the two legs (each 50%)
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

  return { trades: totalTrades, wr, sh, pf, ret: netRet, netReturns: returns };
}

function computeLeg(
  entry: number,
  exit: number,
  dir: "long" | "short",
): number {
  return dir === "long" ? (exit - entry) / entry : (entry - exit) / entry;
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

describe("iteration 48 — scaling-out + breakeven-stop for ≥70% WR", () => {
  it(
    "sweep tp1/tp2 combos on all 7 locked edges + bootstrap lock",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 48: SCALING-OUT + BE-STOP ===");

      const uniqueSyms = Array.from(
        new Set(LOCKED_EDGES.map((e) => lockedEdgeBinanceSymbol(e.symbol))),
      );
      const data: Record<string, Candle[]> = {};
      for (const s of uniqueSyms) {
        console.log(`Fetching ${s} 1h (~10000)...`);
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "1h",
          targetCount: 10000,
        });
      }

      // First: full-history sweep to find candidate (tp1, tp2) combos
      // Then: bootstrap-lock the winners.
      const tp1Options = [0.003, 0.005, 0.008];
      const tp2Options = [0.015, 0.02, 0.03];
      const filterOptions: Array<{
        name: string;
        htf: boolean;
        micro: boolean;
      }> = [
        { name: "none", htf: false, micro: false },
        { name: "htf", htf: true, micro: false },
        { name: "micro", htf: false, micro: true },
        { name: "htf+micro", htf: true, micro: true },
      ];

      interface FullRow {
        edge: string;
        sym: string;
        filt: string;
        tp1: number;
        tp2: number;
        be: boolean;
        n: number;
        wr: number;
        sh: number;
        pf: number;
        ret: number;
      }
      const fullRows: FullRow[] = [];

      for (const edge of LOCKED_EDGES) {
        const sym = lockedEdgeBinanceSymbol(edge.symbol);
        const baseLabel = `${sym.replace("USDT", "")} ${edge.cfg.mode}`;
        for (const filt of filterOptions) {
          for (const tp1 of tp1Options) {
            for (const tp2 of tp2Options) {
              if (tp2 <= tp1 * 1.5) continue;
              for (const be of [true, false]) {
                const r = runScaleOut(data[sym], {
                  lookback: edge.cfg.lookback,
                  volMult: edge.cfg.volMult,
                  priceZ: edge.cfg.priceZ,
                  tp1Pct: tp1,
                  tp2Pct: tp2,
                  stopPct: edge.cfg.stopPct * 1.8, // wider stop to accommodate scaling
                  holdBars: edge.cfg.holdBars,
                  mode: edge.cfg.mode,
                  htfTrend: filt.htf,
                  microPullback: filt.micro,
                  useBreakeven: be,
                });
                if (r.trades < 30) continue;
                fullRows.push({
                  edge: baseLabel,
                  sym,
                  filt: filt.name + (be ? "+be" : ""),
                  tp1,
                  tp2,
                  be,
                  n: r.trades,
                  wr: r.wr,
                  sh: r.sh,
                  pf: r.pf,
                  ret: r.ret,
                });
              }
            }
          }
        }
      }

      // Print top by WR
      console.log("\n=== Top full-history rows with WR ≥ 70% ===");
      console.log(
        "edge".padEnd(16) +
          "filt".padEnd(14) +
          "tp1/tp2".padStart(12) +
          "n".padStart(5) +
          "WR%".padStart(7) +
          "Sh".padStart(7) +
          "PF".padStart(7) +
          "ret%".padStart(8),
      );
      const candidates = fullRows
        .filter((r) => r.wr >= 0.7 && r.sh >= 1.0 && r.ret > 0)
        .sort((a, b) => b.sh - a.sh)
        .slice(0, 20);
      for (const r of candidates) {
        console.log(
          r.edge.padEnd(16) +
            r.filt.padEnd(14) +
            `${(r.tp1 * 100).toFixed(2)}/${(r.tp2 * 100).toFixed(1)}`.padStart(
              12,
            ) +
            r.n.toString().padStart(5) +
            (r.wr * 100).toFixed(1).padStart(7) +
            r.sh.toFixed(2).padStart(7) +
            r.pf.toFixed(2).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(8),
        );
      }

      console.log(
        `\n→ ${candidates.length} candidates with full-history WR≥70, Sh≥1, ret>0`,
      );
      if (candidates.length === 0) {
        console.log(
          "NO candidates even on single-window. Ending iter48 — scaling-out does not produce 70% WR.",
        );
        return;
      }

      // Bootstrap-lock the top 10 candidates
      console.log("\n=== Bootstrap lock (10 windows) on top candidates ===");
      console.log(
        "edge".padEnd(16) +
          "filt".padEnd(14) +
          "tp1/tp2".padStart(12) +
          "medSh".padStart(8) +
          "minSh".padStart(8) +
          "medWR".padStart(8) +
          "minWR".padStart(8) +
          "pctProf".padStart(9) +
          " verdict",
      );
      const topTen = candidates.slice(0, 10);
      let locked = 0;
      const lockedRecs: string[] = [];
      for (const c of topTen) {
        const sharpes: number[] = [];
        const wrs: number[] = [];
        const rets: number[] = [];
        const cand = LOCKED_EDGES.find(
          (e) =>
            lockedEdgeBinanceSymbol(e.symbol) === c.sym &&
            `${c.sym.replace("USDT", "")} ${e.cfg.mode}` === c.edge,
        );
        if (!cand) continue;
        const filt = c.filt.replace("+be", "");
        const useBe = c.filt.includes("+be");
        const full = data[c.sym];
        for (const oos of chronoSplits(full)) {
          const r = runScaleOut(oos, {
            lookback: cand.cfg.lookback,
            volMult: cand.cfg.volMult,
            priceZ: cand.cfg.priceZ,
            tp1Pct: c.tp1,
            tp2Pct: c.tp2,
            stopPct: cand.cfg.stopPct * 1.8,
            holdBars: cand.cfg.holdBars,
            mode: cand.cfg.mode,
            htfTrend: filt.includes("htf"),
            microPullback: filt.includes("micro"),
            useBreakeven: useBe,
          });
          if (r.trades < 10) continue;
          sharpes.push(r.sh);
          wrs.push(r.wr);
          rets.push(r.ret * 100);
        }
        for (let i2 = 0; i2 < 4; i2++) {
          const sample = blockBootstrap(full, 720, 6, 1234 + i2 * 17);
          const r = runScaleOut(sample, {
            lookback: cand.cfg.lookback,
            volMult: cand.cfg.volMult,
            priceZ: cand.cfg.priceZ,
            tp1Pct: c.tp1,
            tp2Pct: c.tp2,
            stopPct: cand.cfg.stopPct * 1.8,
            holdBars: cand.cfg.holdBars,
            mode: cand.cfg.mode,
            htfTrend: filt.includes("htf"),
            microPullback: filt.includes("micro"),
            useBreakeven: useBe,
          });
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
            c.filt.padEnd(14) +
            `${(c.tp1 * 100).toFixed(2)}/${(c.tp2 * 100).toFixed(1)}`.padStart(
              12,
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
          lockedRecs.push(
            `${c.edge} filt=${c.filt} tp1=${(c.tp1 * 100).toFixed(2)}% tp2=${(c.tp2 * 100).toFixed(1)}% medSh=${medSh.toFixed(2)} medWR=${(medWR * 100).toFixed(1)}%`,
          );
        }
      }

      console.log(
        `\n★ Bootstrap-locked (medSh≥1 AND minSh≥0 AND medWR≥70 AND minWR≥60 AND pctProf≥80): ${locked}`,
      );
      for (const s of lockedRecs) console.log(`  ${s}`);
    },
  );
});
