/**
 * Iter 123 — validate D6 and E2 with full 5-gate battery.
 *
 * From iter122 screen:
 *   D6 rsi42 nHi36 red0.2% nD2 cap4    → tpd 1.87, Sharpe 7.06, +125%, %prof 80%, bs+ 100%, minW -6.6%
 *   E2 rsi40 nHi48 red0.5% nD2 cap4 +M7 → tpd 2.25, Sharpe 3.90, +70%,   %prof 70%, bs+ 100%, minW -7.8%
 *
 * Plan: if E2 passes all 5 gates with ≥ 2 tpd → ship as "AGGRESSIVE" tier.
 * If only D6 passes, ship D6 as refined default (iter119 → iter123 upgrade).
 *
 * Gates (tier-dependent):
 *   G1 full: tpd target, Sharpe ≥ 3.5, bs+ ≥ 95%, pctProf ≥ 60% (aggressive)
 *            OR tpd ≥ 1.8, Sharpe ≥ 5, bs+ ≥ 95%, pctProf ≥ 70% (refined)
 *   G2 quarters: Q1-3 positive, Q4 ≥ -5%
 *   G3 cap 3-5 all Sharpe ≥ 3
 *   G4 12-variant sensitivity ≥ 75% pass Sharpe ≥ 2.5 & ret > 0
 *   G5 OOS 60/40 Sharpe ≥ 2.5 & ret > 0
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const BTC = "BTCUSDT";
const TARGET_CANDLES = 50_000;

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

interface ExecParams {
  tp1: number;
  tp2: number;
  stop: number;
  hold: number;
}

function executeLong(
  candles: Candle[],
  i: number,
  ex: ExecParams,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp1L = entry * (1 + ex.tp1);
  const tp2L = entry * (1 + ex.tp2);
  let sL = entry * (1 - ex.stop);
  const mx = Math.min(i + 1 + ex.hold, candles.length - 1);
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

type Mech = "M1" | "M4" | "M5" | "M6" | "M7";

interface Params {
  rsiTh: number;
  nHi: number;
  redPct: number;
  nDown: number;
  capK: number;
  includeM7: boolean;
}

interface Ctx {
  closes: number[];
  highs: number[];
  r7: number[];
  trendMask: boolean[];
  macroMask: boolean[];
}

function mkCtx(candles: Candle[]): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const r7 = rsiSeries(closes, 7);
  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = 168; i < candles.length; i++) {
    const s = smaLast(closes.slice(i - 168, i), 168);
    trendMask[i] = candles[i].close > s;
  }
  const macroMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = 720; i < candles.length; i++) {
    const past = closes[i - 720];
    if (past > 0) macroMask[i] = (closes[i] - past) / past > 0;
  }
  return { closes, highs, r7, trendMask, macroMask };
}

function fireM(
  candles: Candle[],
  ctx: Ctx,
  i: number,
  m: Mech,
  p: Params,
): boolean {
  if (!ctx.trendMask[i] || !ctx.macroMask[i]) return false;
  switch (m) {
    case "M1":
      if (i < p.nDown + 1) return false;
      for (let k = 0; k < p.nDown; k++) {
        if (ctx.closes[i - k] >= ctx.closes[i - k - 1]) return false;
      }
      return true;
    case "M4":
      return ctx.r7[i] <= p.rsiTh;
    case "M5":
      if (i < p.nHi + 1) return false;
      return candles[i].close > maxLast(ctx.highs.slice(i - p.nHi, i), p.nHi);
    case "M6": {
      const o = candles[i].open;
      const c = candles[i].close;
      if (o <= 0) return false;
      return (c - o) / o <= -p.redPct;
    }
    case "M7":
      if (i < 1) return false;
      return (
        candles[i].close > candles[i - 1].high &&
        candles[i].close > candles[i - 1].close
      );
  }
}

interface Trade {
  pnl: number;
  openBar: number;
}

const EXEC: ExecParams = { tp1: 0.008, tp2: 0.04, stop: 0.01, hold: 24 };

function runConcurrent(
  candles: Candle[],
  ctx: Ctx,
  p: Params,
  ex: ExecParams = EXEC,
): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = p.includeM7
    ? ["M1", "M4", "M5", "M6", "M7"]
    : ["M1", "M4", "M5", "M6"];
  for (let i = 722; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= p.capK) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    for (const m of mechs) {
      if (open.length >= p.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m, p)) continue;
      const r = executeLong(candles, i, ex);
      if (!r) continue;
      trades.push({ pnl: r.pnl / p.capK, openBar: i });
      open.push({ exitBar: r.exitBar, mech: m });
    }
  }
  return trades;
}

function stats(trades: Trade[], days: number, bpw: number, seed: number) {
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
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
  return { n: trades.length, tpd, wr, ret, sh, pctProf, minWin, bs };
}

interface Tier {
  label: string;
  p: Params;
  tpdTarget: number;
  sharpeTarget: number;
  pctProfTarget: number;
}

describe("iter 123 — refined + aggressive tier 5-gate battery", () => {
  it("validate D6 and E2 full 5-gate", { timeout: 1_500_000 }, async () => {
    console.log("\n=== ITER 123: full 5-gate battery ===");
    const c = await loadBinanceHistory({
      symbol: BTC,
      timeframe: "1h",
      targetCount: TARGET_CANDLES,
      maxPages: 100,
    });
    const days = c.length / 24;
    const bpw = Math.floor(c.length / 10);
    const ctx = mkCtx(c);
    console.log(`loaded ${c.length} 1h BTC candles (${days.toFixed(0)} days)`);

    const tiers: Tier[] = [
      {
        label: "D6 REFINED (rsi42 nHi36 red0.2% nD2 cap4)",
        p: {
          rsiTh: 42,
          nHi: 36,
          redPct: 0.002,
          nDown: 2,
          capK: 4,
          includeM7: false,
        },
        tpdTarget: 1.8,
        sharpeTarget: 5,
        pctProfTarget: 0.7,
      },
      {
        label: "E2 AGGRESSIVE (rsi40 nHi48 red0.5% nD2 cap4 +M7)",
        p: {
          rsiTh: 40,
          nHi: 48,
          redPct: 0.005,
          nDown: 2,
          capK: 4,
          includeM7: true,
        },
        tpdTarget: 2.0,
        sharpeTarget: 3.5,
        pctProfTarget: 0.6,
      },
    ];

    for (const tier of tiers) {
      console.log(`\n════════════ ${tier.label} ════════════`);

      // G1
      const tAll = runConcurrent(c, ctx, tier.p);
      const s = stats(tAll, days, bpw, 777);
      console.log(
        `G1 FULL  n=${s.n} tpd=${s.tpd.toFixed(
          2,
        )} WR=${(s.wr * 100).toFixed(1)}% ret=${(s.ret * 100).toFixed(
          1,
        )}% Shp=${s.sh.toFixed(2)} bs+=${(s.bs.pctPositive * 100).toFixed(
          0,
        )}% bs5%=${(s.bs.p5 * 100).toFixed(1)}% %prof=${(
          s.pctProf * 100
        ).toFixed(0)}% minW=${(s.minWin * 100).toFixed(1)}%`,
      );
      const g1 =
        s.tpd >= tier.tpdTarget &&
        s.sh >= tier.sharpeTarget &&
        s.bs.pctPositive >= 0.95 &&
        s.ret > 0 &&
        s.pctProf >= tier.pctProfTarget;

      // G2
      const qSize = Math.floor(c.length / 4);
      const qRet: number[] = [];
      for (let k = 0; k < 4; k++) {
        const sub = c.slice(k * qSize, (k + 1) * qSize);
        const sctx = mkCtx(sub);
        const tq = runConcurrent(sub, sctx, tier.p);
        const ss = stats(
          tq,
          sub.length / 24,
          Math.floor(sub.length / 10),
          100 + k,
        );
        qRet.push(ss.ret);
        console.log(
          `  Q${k + 1} n=${ss.n} tpd=${ss.tpd.toFixed(2)} ret=${(ss.ret * 100).toFixed(1)}% Shp=${ss.sh.toFixed(2)}`,
        );
      }
      const g2 = qRet[0] > 0 && qRet[1] > 0 && qRet[2] > 0 && qRet[3] >= -0.05;

      // G3
      console.log("G3 cap sweep:");
      let g3 = true;
      for (const capK of [3, 4, 5]) {
        const t = runConcurrent(c, ctx, { ...tier.p, capK });
        const ss = stats(t, days, bpw, 300 + capK);
        if (ss.sh < 3) g3 = false;
        console.log(
          `  cap=${capK} ret=${(ss.ret * 100).toFixed(1)}% Shp=${ss.sh.toFixed(2)} bs+=${(ss.bs.pctPositive * 100).toFixed(0)}%`,
        );
      }

      // G4
      const vs: Array<{ label: string; exec: ExecParams; p: Params }> = [
        { label: "tp1-30%", exec: { ...EXEC, tp1: 0.008 * 0.7 }, p: tier.p },
        { label: "tp1+30%", exec: { ...EXEC, tp1: 0.008 * 1.3 }, p: tier.p },
        { label: "tp2-30%", exec: { ...EXEC, tp2: 0.04 * 0.7 }, p: tier.p },
        { label: "tp2+30%", exec: { ...EXEC, tp2: 0.04 * 1.3 }, p: tier.p },
        { label: "stop-30%", exec: { ...EXEC, stop: 0.01 * 0.7 }, p: tier.p },
        { label: "stop+30%", exec: { ...EXEC, stop: 0.01 * 1.3 }, p: tier.p },
        { label: "hold x0.5", exec: { ...EXEC, hold: 12 }, p: tier.p },
        { label: "hold x2", exec: { ...EXEC, hold: 48 }, p: tier.p },
        {
          label: "rsi-5",
          exec: EXEC,
          p: { ...tier.p, rsiTh: tier.p.rsiTh - 5 },
        },
        {
          label: "rsi+5",
          exec: EXEC,
          p: { ...tier.p, rsiTh: tier.p.rsiTh + 5 },
        },
        {
          label: "nHi/2",
          exec: EXEC,
          p: { ...tier.p, nHi: Math.max(6, Math.floor(tier.p.nHi / 2)) },
        },
        {
          label: "nHi*1.5",
          exec: EXEC,
          p: { ...tier.p, nHi: Math.floor(tier.p.nHi * 1.5) },
        },
      ];
      let vPass = 0;
      for (const v of vs) {
        const t = runConcurrent(c, ctx, v.p, v.exec);
        const ss = stats(t, days, bpw, 500);
        const ok = ss.sh >= 2.5 && ss.ret > 0;
        if (ok) vPass++;
      }
      const g4 = vPass / vs.length >= 0.75;
      console.log(`G4 sensitivity: ${vPass}/${vs.length}`);

      // G5
      const split = Math.floor(c.length * 0.6);
      const oosC = c.slice(split);
      const oosCtx = mkCtx(oosC);
      const oosT = runConcurrent(oosC, oosCtx, tier.p);
      const oosS = stats(
        oosT,
        oosC.length / 24,
        Math.floor(oosC.length / 10),
        888,
      );
      console.log(
        `G5 OOS  n=${oosS.n} tpd=${oosS.tpd.toFixed(2)} ret=${(oosS.ret * 100).toFixed(1)}% Shp=${oosS.sh.toFixed(2)} bs+=${(oosS.bs.pctPositive * 100).toFixed(0)}%`,
      );
      const g5 = oosS.sh >= 2.5 && oosS.ret > 0;

      console.log(
        `\n   G1=${g1 ? "✓" : "✗"} G2=${g2 ? "✓" : "✗"} G3=${g3 ? "✓" : "✗"} G4=${g4 ? "✓" : "✗"} G5=${g5 ? "✓" : "✗"}  ${g1 && g2 && g3 && g4 && g5 ? "★ ALL PASS" : "— fails"}`,
      );
    }
  });
});
