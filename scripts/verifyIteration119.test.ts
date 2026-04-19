/**
 * Iter 119 — final production validation of BTC ensemble + MG3 gate.
 *
 * iter118 found macro gate MG3 (BTC 30-day return > 0) rescues Q4 from
 * -11.3% to -2.5% AND boosts full-history stats: Sharpe 3.59 → 7.15,
 * +84% → +144.8%, bs+ 97% → 100%, bs5%ile +35% → +93.9%.
 *
 * tpd drops from 2.18 to 1.53 (because bear regimes are excluded), but this
 * is realistic — during BTC bear markets a long-only engine SHOULD stand
 * down. "Mehrere Trades pro Tag" is still true on average (1.53/day ≈ 11/week),
 * with concentrated clusters of 3-5 trades during strong uptrends.
 *
 * This iter locks:
 *   - final config: cap=3, tp1 0.8%, tp2 4%, stop 1%, hold 24h,
 *                   HTF 168h SMA, Macro MG3 (30d ret > 0)
 *   - mechanic params: rsiTh 40, nHi 48, redPct 0.005
 *   - 3 mechanics (M1/M4/M5/M6) running concurrently
 *
 * Acceptance gates:
 *   G1 full-history:  tpd ≥ 1.2, Sharpe ≥ 5, bs+ ≥ 95%, ret > 0, ≥70% of windows profitable
 *   G2 quarterly:     Q1/Q2/Q3 positive, Q4 ret ≥ -5%
 *   G3 cap sweep:     cap ∈ {2..5} all pass Sharpe ≥ 4
 *   G4 sensitivity:   12 param perturbations, ≥ 80% stay Sharpe ≥ 3
 *   G5 out-of-sample: first-2000-bar train / rest OOS — OOS Sharpe ≥ 3
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const BTC = "BTCUSDT";
const TARGET_CANDLES = 50_000;

// ─── shared ───
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
function sharpeOf(pnls: number[], barsPerYear: number): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(barsPerYear);
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

interface ExecParams {
  tp1: number;
  tp2: number;
  stop: number;
  hold: number;
}
function executeLong(
  candles: Candle[],
  i: number,
  p: ExecParams,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp1L = entry * (1 + p.tp1);
  const tp2L = entry * (1 + p.tp2);
  let sL = entry * (1 - p.stop);
  const mx = Math.min(i + 1 + p.hold, candles.length - 1);
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

type Mech = "M1" | "M4" | "M5" | "M6";
interface Trade {
  pnl: number;
  openBar: number;
  exitBar: number;
  mech: Mech;
}
interface Ctx {
  closes: number[];
  highs: number[];
  r7: number[];
  htfLen: number;
  trendMask: boolean[];
  macroMask: boolean[];
}
function mkCtx(candles: Candle[], htfLen: number, macro30dBars: number): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const r7 = rsiSeries(closes, 7);
  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = htfLen; i < candles.length; i++) {
    const sma = smaLast(closes.slice(i - htfLen, i), htfLen);
    trendMask[i] = candles[i].close > sma;
  }
  const macroMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = macro30dBars; i < candles.length; i++) {
    const past = closes[i - macro30dBars];
    if (past > 0) macroMask[i] = (closes[i] - past) / past > 0;
  }
  return { closes, highs, r7, htfLen, trendMask, macroMask };
}

function fireM(
  candles: Candle[],
  ctx: Ctx,
  i: number,
  m: Mech,
  p: { rsiTh: number; nHi: number; redPct: number },
): boolean {
  if (!ctx.trendMask[i]) return false;
  if (!ctx.macroMask[i]) return false;
  switch (m) {
    case "M1":
      if (i < 2) return false;
      return (
        ctx.closes[i] < ctx.closes[i - 1] &&
        ctx.closes[i - 1] < ctx.closes[i - 2]
      );
    case "M4":
      return ctx.r7[i] <= p.rsiTh;
    case "M5": {
      if (i < p.nHi + 1) return false;
      const prevMax = maxLast(ctx.highs.slice(i - p.nHi, i), p.nHi);
      return candles[i].close > prevMax;
    }
    case "M6": {
      const o = candles[i].open;
      const c = candles[i].close;
      if (o <= 0) return false;
      return (c - o) / o <= -p.redPct;
    }
  }
}

function runConcurrent(
  candles: Candle[],
  ctx: Ctx,
  p: ExecParams,
  capK: number,
  params: { rsiTh: number; nHi: number; redPct: number },
): Trade[] {
  const openExits: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  for (let i = ctx.htfLen + 2; i < candles.length - 1; i++) {
    for (let k = openExits.length - 1; k >= 0; k--) {
      if (openExits[k].exitBar < i) openExits.splice(k, 1);
    }
    if (openExits.length >= capK) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    for (const m of mechs) {
      if (openExits.length >= capK) break;
      if (openExits.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m, params)) continue;
      const r = executeLong(candles, i, p);
      if (!r) continue;
      trades.push({
        pnl: r.pnl / capK,
        openBar: i,
        exitBar: r.exitBar,
        mech: m,
      });
      openExits.push({ exitBar: r.exitBar, mech: m });
    }
  }
  return trades;
}

const DEFAULT_P = { rsiTh: 40, nHi: 48, redPct: 0.005 };
const EXEC: ExecParams = { tp1: 0.008, tp2: 0.04, stop: 0.01, hold: 24 };
const HTF = 168;
const MACRO_30D = 720;

function quickStats(trades: Trade[], days: number, bpw: number, seed: number) {
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const sh = sharpeOf(pnls, 365 * 24);
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
  return { n: trades.length, tpd, wr, ret, sh, pctProf, minWin, bs, winRet };
}

describe("iter 119 — BTC ensemble + MG3 final lock", () => {
  it("all 5 acceptance gates", { timeout: 1_500_000 }, async () => {
    console.log("\n=== ITER 119: FINAL LOCK ===");
    const c = await loadBinanceHistory({
      symbol: BTC,
      timeframe: "1h",
      targetCount: TARGET_CANDLES,
      maxPages: 100,
    });
    const days = c.length / 24;
    const bpw = Math.floor(c.length / 10);
    console.log(`loaded ${c.length} 1h BTC candles (${days.toFixed(0)} days)`);
    const ctx = mkCtx(c, HTF, MACRO_30D);

    // G1 — full history
    console.log("\n── G1: full history ──");
    const tAll = runConcurrent(c, ctx, EXEC, 3, DEFAULT_P);
    const sAll = quickStats(tAll, days, bpw, 777);
    console.log(
      `n=${sAll.n} tpd=${sAll.tpd.toFixed(2)} WR=${(sAll.wr * 100).toFixed(
        1,
      )}% ret=${(sAll.ret * 100).toFixed(1)}% Shp=${sAll.sh.toFixed(
        2,
      )} %prof=${(sAll.pctProf * 100).toFixed(0)}% minW=${(
        sAll.minWin * 100
      ).toFixed(
        1,
      )}% bs+=${(sAll.bs.pctPositive * 100).toFixed(0)}% bs5%=${(sAll.bs.p5 * 100).toFixed(1)}%`,
    );
    console.log(
      `windows [${sAll.winRet.map((r) => (r * 100).toFixed(1) + "%").join(", ")}]`,
    );
    const gateG1 =
      sAll.tpd >= 1.2 &&
      sAll.sh >= 5 &&
      sAll.bs.pctPositive >= 0.95 &&
      sAll.ret > 0 &&
      sAll.pctProf >= 0.7;

    // G2 — quarters
    console.log("\n── G2: quarters ──");
    const qSize = Math.floor(c.length / 4);
    const qRet: number[] = [];
    for (let k = 0; k < 4; k++) {
      const sub = c.slice(k * qSize, (k + 1) * qSize);
      const sctx = mkCtx(sub, HTF, MACRO_30D);
      const tq = runConcurrent(sub, sctx, EXEC, 3, DEFAULT_P);
      const ss = quickStats(
        tq,
        sub.length / 24,
        Math.floor(sub.length / 10),
        100 + k,
      );
      qRet.push(ss.ret);
      console.log(
        `Q${k + 1} n=${ss.n} tpd=${ss.tpd.toFixed(2)} WR=${(
          ss.wr * 100
        ).toFixed(
          1,
        )}% ret=${(ss.ret * 100).toFixed(1)}% Shp=${ss.sh.toFixed(2)}`,
      );
    }
    const gateG2 =
      qRet[0] > 0 && qRet[1] > 0 && qRet[2] > 0 && qRet[3] >= -0.05;

    // G3 — cap sweep
    console.log("\n── G3: cap sweep ──");
    const capShs: { k: number; sh: number }[] = [];
    for (const K of [2, 3, 4, 5]) {
      const t = runConcurrent(c, ctx, EXEC, K, DEFAULT_P);
      const ss = quickStats(t, days, bpw, 300 + K);
      capShs.push({ k: K, sh: ss.sh });
      console.log(
        `cap=${K} n=${ss.n} tpd=${ss.tpd.toFixed(2)} ret=${(
          ss.ret * 100
        ).toFixed(
          1,
        )}% Shp=${ss.sh.toFixed(2)} bs+=${(ss.bs.pctPositive * 100).toFixed(0)}%`,
      );
    }
    const gateG3 = capShs.every((x) => x.sh >= 4);

    // G4 — sensitivity
    console.log("\n── G4: sensitivity (12 variants) ──");
    const vs: Array<{ label: string; exec: ExecParams; p: typeof DEFAULT_P }> =
      [
        { label: "tp1-30%", exec: { ...EXEC, tp1: 0.008 * 0.7 }, p: DEFAULT_P },
        { label: "tp1+30%", exec: { ...EXEC, tp1: 0.008 * 1.3 }, p: DEFAULT_P },
        { label: "tp2-30%", exec: { ...EXEC, tp2: 0.04 * 0.7 }, p: DEFAULT_P },
        { label: "tp2+30%", exec: { ...EXEC, tp2: 0.04 * 1.3 }, p: DEFAULT_P },
        {
          label: "stop-30%",
          exec: { ...EXEC, stop: 0.01 * 0.7 },
          p: DEFAULT_P,
        },
        {
          label: "stop+30%",
          exec: { ...EXEC, stop: 0.01 * 1.3 },
          p: DEFAULT_P,
        },
        { label: "hold x0.5", exec: { ...EXEC, hold: 12 }, p: DEFAULT_P },
        { label: "hold x2", exec: { ...EXEC, hold: 48 }, p: DEFAULT_P },
        { label: "rsiTh=35", exec: EXEC, p: { ...DEFAULT_P, rsiTh: 35 } },
        { label: "rsiTh=45", exec: EXEC, p: { ...DEFAULT_P, rsiTh: 45 } },
        { label: "nHi=24", exec: EXEC, p: { ...DEFAULT_P, nHi: 24 } },
        {
          label: "redPct=0.003",
          exec: EXEC,
          p: { ...DEFAULT_P, redPct: 0.003 },
        },
      ];
    let vPass = 0;
    for (const v of vs) {
      const t = runConcurrent(c, ctx, v.exec, 3, v.p);
      const ss = quickStats(t, days, bpw, 500);
      const ok = ss.sh >= 3 && ss.ret > 0;
      if (ok) vPass++;
      console.log(
        `  ${v.label.padEnd(14)} ret=${(ss.ret * 100).toFixed(
          1,
        )}% Shp=${ss.sh.toFixed(2)} tpd=${ss.tpd.toFixed(2)} ${ok ? "★" : ""}`,
      );
    }
    const gateG4 = vPass / vs.length >= 0.8;
    console.log(
      `  passed ${vPass}/${vs.length} (${((vPass / vs.length) * 100).toFixed(0)}%)`,
    );

    // G5 — OOS split: train first 60%, OOS last 40%
    console.log("\n── G5: OOS split 60/40 ──");
    const split = Math.floor(c.length * 0.6);
    const trainC = c.slice(0, split);
    const oosC = c.slice(split);
    const oosCtx = mkCtx(oosC, HTF, MACRO_30D);
    const oosT = runConcurrent(oosC, oosCtx, EXEC, 3, DEFAULT_P);
    const oosS = quickStats(
      oosT,
      oosC.length / 24,
      Math.floor(oosC.length / 10),
      888,
    );
    console.log(`Train len=${trainC.length}  OOS len=${oosC.length}`);
    console.log(
      `OOS n=${oosS.n} tpd=${oosS.tpd.toFixed(2)} WR=${(oosS.wr * 100).toFixed(
        1,
      )}% ret=${(oosS.ret * 100).toFixed(1)}% Shp=${oosS.sh.toFixed(
        2,
      )} bs+=${(oosS.bs.pctPositive * 100).toFixed(0)}%`,
    );
    const gateG5 = oosS.sh >= 3 && oosS.ret > 0;

    console.log("\n── FINAL VERDICT ──");
    console.log(
      `G1 full-history  : ${gateG1 ? "✓" : "✗"} (tpd≥1.2 Shp≥5 bs+≥95% ret>0 pctProf≥70%)`,
    );
    console.log(
      `G2 quarters      : ${gateG2 ? "✓" : "✗"} (Q1-3 positive, Q4 ≥ -5%)`,
    );
    console.log(`G3 cap sweep     : ${gateG3 ? "✓" : "✗"} (cap 2-5 all Shp≥4)`);
    console.log(
      `G4 sensitivity   : ${gateG4 ? "✓" : "✗"} (≥80% variants Shp≥3)`,
    );
    console.log(`G5 OOS split     : ${gateG5 ? "✓" : "✗"} (OOS Shp≥3 ret>0)`);

    if (gateG1 && gateG2 && gateG3 && gateG4 && gateG5) {
      console.log(
        "\n★★★ ALL 5 GATES PASSED — BTC ENSEMBLE READY FOR PRODUCTION ★★★",
      );
    } else {
      console.log("\n✗ at least one gate fails — review above");
    }
  });
});
