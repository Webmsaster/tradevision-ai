/**
 * Iter 110: Zoom around iter109 winner + bootstrap validation.
 *
 * Winner: nBars_down=3 + htf48 uptrend filter + tp0.8/4.8 + stop1.5 +
 * hold24 = Sharpe 4.72 / ret +20.1% / 66% WR / 60% pctProf.
 *
 * Goals:
 *   1. Zoom fine grid around winner (tp/stop/hold/htf/nBars)
 *   2. Bootstrap validation: 15 block-bootstrap resamples
 *   3. Find higher-frequency variants (hold shorter, more trades/day)
 *   4. Report variants by Sharpe × sqrt(tpd) × pctProf composite
 *
 * Filters tightened where possible:
 *   - WR ≥ 58%
 *   - Sharpe ≥ 1.5
 *   - pctProf ≥ 60% (tighter than winner's 60)
 *   - bootstrap: ≥ 80% of 15 resamples profitable
 *   - minRet ≥ -4%
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Cfg {
  nBarsDown: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  htfLen: number;
}

function smaLast(v: number[], n: number): number {
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

interface Trade {
  pnl: number;
  bar: number;
}

function run(candles: Candle[], cfg: Cfg): Trade[] {
  const trades: Trade[] = [];
  const closes = candles.map((c) => c.close);
  const start = Math.max(cfg.htfLen, cfg.nBarsDown + 1);
  for (let i = start; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const sma = smaLast(closes.slice(i - cfg.htfLen, i), cfg.htfLen);
    if (cur.close <= sma) continue;
    let allRed = true;
    for (let k = 0; k < cfg.nBarsDown; k++) {
      if (candles[i - k].close >= candles[i - k - 1].close) {
        allRed = false;
        break;
      }
    }
    if (!allRed) continue;
    if (new Date(cur.openTime).getUTCHours() === 0) continue;
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp1L = entry * (1 + cfg.tp1Pct);
    const tp2L = entry * (1 + cfg.tp2Pct);
    let sL = entry * (1 - cfg.stopPct);
    const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
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
        if ((t1 && sH) || sH) {
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
        const s2 = bar.low <= sL;
        const t22 = bar.high >= tp2L;
        if ((t22 && s2) || s2) {
          l2B = j;
          l2P = sL;
          break;
        }
        if (t22) {
          l2B = j;
          l2P = tp2L;
          break;
        }
      }
    }
    const l2c = applyCosts({
      entry,
      exit: l2P,
      direction: "long",
      holdingHours: l2B - (i + 1),
      config: MAKER_COSTS,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction: "long",
        holdingHours: tp1Bar - (i + 1),
        config: MAKER_COSTS,
      });
      leg1 = l1c.netPnlPct;
    } else {
      leg1 = leg2;
    }
    trades.push({ pnl: 0.5 * leg1 + 0.5 * leg2, bar: i });
    i = l2B;
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

// block-bootstrap over trade sequence
function bootstrapProfitable(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): { pctPositive: number; medRet: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, medRet: 0 };
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
      const start = Math.floor(rng() * (pnls.length - blockLen));
      for (let k = 0; k < blockLen; k++) sampled.push(pnls[start + k]);
    }
    const ret = sampled.reduce((a, p) => a * (1 + p), 1) - 1;
    rets.push(ret);
  }
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    pctPositive: rets.filter((r) => r > 0).length / rets.length,
    medRet: sorted[Math.floor(sorted.length / 2)],
  };
}

describe("iter 110 — BTC long-only zoom + bootstrap", () => {
  it("validate buy-dip in uptrend edge", { timeout: 1_800_000 }, async () => {
    console.log("\n=== ITER 110: zoom around iter109 winner ===");
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1h",
      targetCount: 24000,
    });
    const days = btc.length / 24;
    const bpw = Math.floor(btc.length / 10);
    console.log(`BTC: ${btc.length} bars = ${days.toFixed(0)} days`);

    const grid: Cfg[] = [];
    for (const nBars of [2, 3, 4]) {
      for (const htfLen of [24, 36, 48, 72, 96]) {
        for (const tp1 of [0.003, 0.005, 0.006, 0.008, 0.01, 0.012]) {
          for (const tp2Mult of [3, 4, 5, 6, 8]) {
            for (const stop of [0.01, 0.012, 0.015, 0.018, 0.02, 0.025]) {
              for (const hold of [8, 12, 18, 24, 36]) {
                grid.push({
                  nBarsDown: nBars,
                  tp1Pct: tp1,
                  tp2Pct: tp1 * tp2Mult,
                  stopPct: stop,
                  holdBars: hold,
                  htfLen,
                });
              }
            }
          }
        }
      }
    }
    console.log(`Grid: ${grid.length} configs`);

    interface Row {
      cfg: Cfg;
      n: number;
      wr: number;
      ret: number;
      sharpe: number;
      tpd: number;
      pctProf: number;
      minRet: number;
      medWR: number;
      bootstrapPos?: number;
      bootstrapMedRet?: number;
    }
    const results: Row[] = [];
    for (const cfg of grid) {
      const trades = run(btc, cfg);
      const n = trades.length;
      if (n < 100) continue;
      const pnls = trades.map((t) => t.pnl);
      const w = pnls.filter((p) => p > 0).length;
      const wr = w / n;
      const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
      const sh = sharpeOf(pnls);
      const tpd = n / days;
      if (wr < 0.58 || ret <= 0 || sh < 1.5 || tpd < 0.3) continue;
      const perWR: number[] = [];
      const perRet: number[] = [];
      for (let win = 0; win < 10; win++) {
        const startI = win * bpw;
        const slice = btc.slice(startI, startI + bpw);
        const t = run(slice, cfg);
        if (t.length > 0)
          perWR.push(t.filter((x) => x.pnl > 0).length / t.length);
        perRet.push(t.reduce((a, x) => a * (1 + x.pnl), 1) - 1);
      }
      const pctProf = perRet.filter((r) => r > 0).length / perRet.length;
      if (pctProf < 0.6) continue;
      const minRet = Math.min(...perRet);
      if (minRet < -0.04) continue;
      const sortedWR = [...perWR].sort();
      const medWR = sortedWR[Math.floor(sortedWR.length / 2)] ?? 0;
      results.push({
        cfg,
        n,
        wr,
        ret,
        sharpe: sh,
        tpd,
        pctProf,
        minRet,
        medWR,
      });
    }
    console.log(
      `\n${results.length} configs pass strict survival filter (WR≥58, Shp≥1.5, pctProf≥60, minRet≥-4%, tpd≥0.3)`,
    );
    if (results.length === 0) {
      console.log(
        "\n✗ Zoom found no equivalent — iter109 winner may be knife-edge.",
      );
      return;
    }
    // bootstrap-validate top 30 by composite
    const sorted = results.sort(
      (a, b) =>
        b.sharpe * Math.sqrt(b.tpd) * b.pctProf -
        a.sharpe * Math.sqrt(a.tpd) * a.pctProf,
    );
    const topN = Math.min(30, sorted.length);
    for (let k = 0; k < topN; k++) {
      const t = run(btc, sorted[k].cfg).map((x) => x.pnl);
      const blockLen = Math.max(5, Math.floor(t.length / 20));
      const bs = bootstrapProfitable(t, 15, blockLen, 42 + k);
      sorted[k].bootstrapPos = bs.pctPositive;
      sorted[k].bootstrapMedRet = bs.medRet;
    }
    // Filter: require bootstrap ≥ 80% positive
    const survivors = sorted
      .slice(0, topN)
      .filter((r) => (r.bootstrapPos ?? 0) >= 0.8);
    console.log(
      `\n${survivors.length}/${topN} survive bootstrap ≥80% positive (15 resamples, block ~5% trades)\n`,
    );
    const printTop = (rows: Row[]) => {
      console.log(
        "nB".padStart(3) +
          "htf".padStart(5) +
          "tp1/tp2".padStart(14) +
          "stop".padStart(6) +
          "h".padStart(4) +
          "n".padStart(6) +
          "tpd".padStart(6) +
          "WR%".padStart(7) +
          "ret%".padStart(9) +
          "Shp".padStart(6) +
          "medWR".padStart(7) +
          "%prof".padStart(7) +
          "minRet".padStart(8) +
          "bsPos".padStart(7) +
          "bsMed".padStart(8),
      );
      for (const r of rows) {
        const c = r.cfg;
        console.log(
          c.nBarsDown.toString().padStart(3) +
            c.htfLen.toString().padStart(5) +
            `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(2)}`.padStart(
              14,
            ) +
            (c.stopPct * 100).toFixed(1).padStart(6) +
            c.holdBars.toString().padStart(4) +
            r.n.toString().padStart(6) +
            r.tpd.toFixed(2).padStart(6) +
            (r.wr * 100).toFixed(1).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(9) +
            r.sharpe.toFixed(2).padStart(6) +
            (r.medWR * 100).toFixed(1).padStart(7) +
            (r.pctProf * 100).toFixed(0).padStart(7) +
            (r.minRet * 100).toFixed(1).padStart(8) +
            ((r.bootstrapPos ?? 0) * 100).toFixed(0).padStart(7) +
            ((r.bootstrapMedRet ?? 0) * 100).toFixed(1).padStart(8),
        );
      }
    };
    console.log(
      "── Top 30 candidates (sorted by composite, with bootstrap) ──",
    );
    printTop(sorted.slice(0, topN));
    if (survivors.length > 0) {
      console.log("\n── BOOTSTRAP SURVIVORS (bsPos≥80%) ──");
      printTop(survivors);
    }
  });
});
