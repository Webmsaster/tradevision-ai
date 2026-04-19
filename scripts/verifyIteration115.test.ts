/**
 * Iter 115 — BTC ensemble: OR-combine top 4 iter114 mechanics.
 *
 * From iter114 over 2083d of 1h BTC data, four long-only mechanics passed the
 * gate (Sharpe ≥ 2, WR ≥ 52%, ≥50% windows profitable, bootstrap ≥ 80%):
 *
 *   M1 nDown=2,  htfLen=168  → 1659 trades, Shp 2.03, +34.6%, 0.80 tpd
 *   M4 rsi7≤40,  htfLen=168  → 1066 trades, Shp 5.20, +77.7%, 0.51 tpd
 *   M5 brkNHi=48,htfLen=168  →  594 trades, Shp 5.91, +48.8%, 0.29 tpd
 *   M6 redBar≤-0.5%,htf=168  → 1278 trades, Shp 3.64, +60.3%, 0.61 tpd
 *
 * Ensemble approach:
 *   - generate union of bar indices from all 4 mechanics
 *   - apply cooldown (no re-entry while a trade is open)
 *   - tag each trade with which mechanic fired it (first in list wins on ties)
 *   - measure per-mechanic and combined: tpd, Sharpe, cumRet, bootstrap, 10 windows
 *
 * Also test three sub-ensembles (3/4 mechanics) to see which contribute marginal
 * alpha vs redundancy, and two larger families:
 *   A) all 4
 *   B) all 4 minus M1 (higher-WR only)
 *   C) all 4 minus M5 (drop breakout, stress-test)
 *   D) M4+M6 (two highest-bootstrap mechanics only)
 *
 * Pass gate for ensemble:
 *   tpd ≥ 1.0,  Sharpe ≥ 3,  cumRet > 0,  bootstrap pct+ ≥ 85%,
 *   ≥ 60% of 10 windows profitable, minWin ≥ -10%.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const BTC = "BTCUSDT";
const TARGET_CANDLES = 50_000;

const TP1 = 0.008;
const TP2 = 0.04;
const STOP = 0.01;
const HOLD = 24;

// ────── helpers ──────

function smaLast(v: number[], n: number): number {
  if (v.length < n) return v[v.length - 1] ?? 0;
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function maxLast(v: number[], n: number): number {
  const s = v.slice(-n);
  let m = -Infinity;
  for (const x of s) if (x > m) m = x;
  return m;
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

function executeLong(
  candles: Candle[],
  i: number,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp1L = entry * (1 + TP1);
  const tp2L = entry * (1 + TP2);
  let sL = entry * (1 - STOP);
  const mx = Math.min(i + 1 + HOLD, candles.length - 1);
  let tp1Hit = false;
  let tp1Bar = -1;
  let l2P = candles[mx].close;
  let l2B = mx;
  for (let j = i + 2; j <= mx; j++) {
    const bar = candles[j];
    const sH = bar.low <= sL;
    const t1 = bar.high >= tp1L;
    const t2 = bar.high >= tp2L;
    if (!tp1Hit) {
      if (sH) {
        l2B = j;
        l2P = sL;
        break;
      }
      if (t1) {
        tp1Hit = true;
        tp1Bar = j;
        sL = entry;
        if (t2) {
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

// ────── candidate generators (tagged with mechanic id) ──────

type Mech = "M1" | "M4" | "M5" | "M6";

interface Candidate {
  bar: number;
  mech: Mech;
}

function candidatesFor(candles: Candle[]): Candidate[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const r7 = rsiSeries(closes, 7);
  const HTF = 168;
  const out: Candidate[] = [];

  // Precompute SMA168 mask
  const trend: boolean[] = new Array(candles.length).fill(false);
  for (let i = HTF; i < candles.length; i++) {
    const sma = smaLast(closes.slice(i - HTF, i), HTF);
    trend[i] = candles[i].close > sma;
  }

  for (let i = HTF; i < candles.length - 1; i++) {
    if (!trend[i]) continue;
    const hr = new Date(candles[i].openTime).getUTCHours();
    if (hr === 0) continue;

    // M1 nDown=2
    if (i >= 2 && closes[i] < closes[i - 1] && closes[i - 1] < closes[i - 2]) {
      out.push({ bar: i, mech: "M1" });
      continue;
    }

    // M4 rsi7 ≤ 40
    if (i > 7 && r7[i] <= 40) {
      out.push({ bar: i, mech: "M4" });
      continue;
    }

    // M5 breakout: close > max(highs[i-48..i-1])
    if (i >= 48) {
      const prevMax = maxLast(highs.slice(i - 48, i), 48);
      if (candles[i].close > prevMax) {
        out.push({ bar: i, mech: "M5" });
        continue;
      }
    }

    // M6 single-bar big red ≤ -0.5%
    const o = candles[i].open;
    const c = candles[i].close;
    if (o > 0 && (c - o) / o <= -0.005) {
      out.push({ bar: i, mech: "M6" });
      continue;
    }
  }
  return out;
}

function candidatesSubset(candles: Candle[], include: Set<Mech>): Candidate[] {
  return candidatesFor(candles).filter((c) => include.has(c.mech));
}

interface Trade {
  pnl: number;
  openBar: number;
  mech: Mech;
}

function runEnsemble(candles: Candle[], cands: Candidate[]): Trade[] {
  const sorted = [...cands].sort((a, b) => a.bar - b.bar);
  const trades: Trade[] = [];
  let cool = -1;
  for (const cand of sorted) {
    if (cand.bar < cool) continue;
    const r = executeLong(candles, cand.bar);
    if (!r) continue;
    trades.push({ pnl: r.pnl, openBar: cand.bar, mech: cand.mech });
    cool = r.exitBar + 1;
  }
  return trades;
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
): { pctPositive: number; medRet: number; p5: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, medRet: 0, p5: 0 };
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
    medRet: sorted[Math.floor(sorted.length / 2)],
    p5: sorted[Math.floor(sorted.length * 0.05)],
  };
}

function reportEnsemble(
  label: string,
  trades: Trade[],
  days: number,
  bpw: number,
  seed: number,
): void {
  if (trades.length === 0) {
    console.log(`${label} — empty`);
    return;
  }
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const sh = sharpeOf(pnls);
  const tpd = trades.length / days;
  const wr = wins / trades.length;
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
    30,
    Math.max(10, Math.floor(pnls.length / 15)),
    seed,
  );
  const pass =
    tpd >= 1.0 &&
    sh >= 3 &&
    ret > 0 &&
    bs.pctPositive >= 0.85 &&
    pctProf >= 0.6 &&
    minWin >= -0.1;
  console.log(
    `\n── ${label} ── ${pass ? "★ PASS" : "✗ FAIL"}
  trades ${trades.length}  tpd ${tpd.toFixed(2)}  WR ${(wr * 100).toFixed(
    1,
  )}%  cumRet ${(ret * 100).toFixed(1)}%  Sharpe ${sh.toFixed(2)}
  pctProf ${(pctProf * 100).toFixed(0)}%  minWin ${(minWin * 100).toFixed(
    1,
  )}%  bs+ ${(bs.pctPositive * 100).toFixed(0)}%  bsMed ${(
    bs.medRet * 100
  ).toFixed(1)}%  bs5% ${(bs.p5 * 100).toFixed(1)}%
  windows [${winRet.map((r) => (r * 100).toFixed(1) + "%").join(", ")}]`,
  );
  // per-mechanic contribution
  const byMech = new Map<Mech, number[]>();
  for (const t of trades) {
    if (!byMech.has(t.mech)) byMech.set(t.mech, []);
    byMech.get(t.mech)!.push(t.pnl);
  }
  const parts: string[] = [];
  for (const [mech, ps] of byMech.entries()) {
    const w = ps.filter((p) => p > 0).length;
    const r = ps.reduce((a, p) => a * (1 + p), 1) - 1;
    parts.push(
      `${mech} n=${ps.length} WR=${((w / ps.length) * 100).toFixed(0)}% ret=${(r * 100).toFixed(1)}%`,
    );
  }
  console.log(`  by-mech: ${parts.join(" | ")}`);
}

describe("iter 115 — BTC ensemble validation", () => {
  it(
    "OR-combine iter114 top mechanics and measure ensemble quality",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 115: BTC ensemble validation ===");
      const candles = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1h",
        targetCount: TARGET_CANDLES,
        maxPages: 100,
      });
      const days = candles.length / 24;
      const bpw = Math.floor(candles.length / 10);
      console.log(
        `loaded ${candles.length} 1h BTC candles (${days.toFixed(0)} days)`,
      );

      const A: Set<Mech> = new Set(["M1", "M4", "M5", "M6"]);
      const B: Set<Mech> = new Set(["M4", "M5", "M6"]);
      const C: Set<Mech> = new Set(["M1", "M4", "M6"]);
      const D: Set<Mech> = new Set(["M4", "M6"]);
      const E: Set<Mech> = new Set(["M1", "M4"]);
      const F: Set<Mech> = new Set(["M1", "M6"]);

      const sets = [
        { label: "A: M1+M4+M5+M6 (full ensemble)", ids: A, seed: 11 },
        { label: "B: M4+M5+M6 (drop nDown)", ids: B, seed: 12 },
        { label: "C: M1+M4+M6 (drop breakout)", ids: C, seed: 13 },
        { label: "D: M4+M6 (hi-WR rsi + redBar)", ids: D, seed: 14 },
        { label: "E: M1+M4 (dip + rsi)", ids: E, seed: 15 },
        { label: "F: M1+M6 (dip + redBar)", ids: F, seed: 16 },
      ];

      for (const s of sets) {
        const trades = runEnsemble(candles, candidatesSubset(candles, s.ids));
        reportEnsemble(s.label, trades, days, bpw, s.seed);
      }

      // Walk-forward test on set A only: split into 2-half, 4-quarter
      console.log("\n\n══ Walk-forward stress on set A ══");
      const half = Math.floor(candles.length / 2);
      const h1 = candles.slice(0, half);
      const h2 = candles.slice(half);
      const qSize = Math.floor(candles.length / 4);
      const qs = [0, 1, 2, 3].map((k) =>
        candles.slice(k * qSize, (k + 1) * qSize),
      );
      const stressPrint = (label: string, sub: Candle[]) => {
        const trades = runEnsemble(sub, candidatesSubset(sub, A));
        if (trades.length === 0) {
          console.log(`${label}: no trades`);
          return;
        }
        const pnls = trades.map((t) => t.pnl);
        const w = pnls.filter((p) => p > 0).length;
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const sh = sharpeOf(pnls);
        const tpd = trades.length / (sub.length / 24);
        console.log(
          `${label.padEnd(22)} n=${trades.length} tpd=${tpd.toFixed(2)} WR=${(
            (w / trades.length) *
            100
          ).toFixed(1)}% ret=${(ret * 100).toFixed(1)}% Shp=${sh.toFixed(2)}`,
        );
      };
      stressPrint("half1 (first 50%)", h1);
      stressPrint("half2 (last 50%)", h2);
      for (let k = 0; k < 4; k++) stressPrint(`Q${k + 1}`, qs[k]);
    },
  );
});
