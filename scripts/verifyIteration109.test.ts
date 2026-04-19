/**
 * Iter 109: After iter108 proved every symmetric BTC config loses money
 * over 1000d (best Sharpe -2.49), try directional bias: LONG-ONLY BTC.
 *
 * Premise: BTC has structural uptrend. Fade-both-sides gets killed by
 * upside squeezes. Long-only scalps may capture the asymmetric upside.
 *
 * Strategy: buy dips. Small pullback in uptrend (HTF SMA aligned) →
 * momentum long entry (rebound bar after decline), or fade long (buy
 * after red bar in uptrend).
 *
 * Filters (relaxed, realistic):
 *   - cumRet > 0 over 1000d
 *   - Sharpe > 0.5
 *   - WR ≥ 55%
 *   - ≥ 50% of 10 windows profitable
 *   - tpd ≥ 0.3
 *   - minRet ≥ -5%
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Cfg {
  lookback: number;
  trigger: "rsi_extreme" | "nBars_down" | "vol_dip";
  rsiLen: number;
  rsiBuyMax: number;
  nBarsDown: number;
  volMult: number;
  priceZ: number;
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
function rsi(closes: number[], len: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < len + 1) return out;
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
function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function stdReturns(c: number[]) {
  if (c.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i - 1] <= 0) continue;
    r.push((c[i] - c[i - 1]) / c[i - 1]);
  }
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}

interface Trade {
  pnl: number;
}

function run(candles: Candle[], cfg: Cfg): Trade[] {
  const trades: Trade[] = [];
  const closes = candles.map((c) => c.close);
  const rsiArr = cfg.trigger === "rsi_extreme" ? rsi(closes, cfg.rsiLen) : [];
  const start = Math.max(
    cfg.lookback,
    cfg.htfLen,
    cfg.rsiLen + 2,
    cfg.nBarsDown + 1,
  );
  for (let i = start; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    // HTF trend filter: only long in uptrend
    const sma = smaLast(closes.slice(i - cfg.htfLen, i), cfg.htfLen);
    if (cur.close <= sma) continue;

    let entryOK = false;
    if (cfg.trigger === "rsi_extreme") {
      const r = rsiArr[i];
      if (!Number.isFinite(r)) continue;
      if (r <= cfg.rsiBuyMax) entryOK = true;
    } else if (cfg.trigger === "nBars_down") {
      // require N consecutive red bars (pullback)
      let allRed = true;
      for (let k = 0; k < cfg.nBarsDown; k++) {
        if (candles[i - k].close >= candles[i - k - 1].close) {
          allRed = false;
          break;
        }
      }
      if (allRed) entryOK = true;
    } else {
      // vol_dip: down-bar with volume spike in uptrend
      const ret = (cur.close - candles[i - 1].close) / candles[i - 1].close;
      if (ret >= 0) continue;
      const w = candles.slice(i - cfg.lookback, i);
      const mv = median(w.map((c) => c.volume));
      if (mv <= 0) continue;
      const vZ = cur.volume / mv;
      if (vZ < cfg.volMult) continue;
      const sd = stdReturns(w.map((c) => c.close));
      if (sd <= 0) continue;
      const pZ = Math.abs(ret) / sd;
      if (pZ >= cfg.priceZ) entryOK = true;
    }
    if (!entryOK) continue;
    if (new Date(cur.openTime).getUTCHours() === 0) continue;
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const direction: "long" = "long";
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
      direction,
      holdingHours: l2B - (i + 1),
      config: MAKER_COSTS,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction,
        holdingHours: tp1Bar - (i + 1),
        config: MAKER_COSTS,
      });
      leg1 = l1c.netPnlPct;
    } else {
      leg1 = leg2;
    }
    trades.push({ pnl: 0.5 * leg1 + 0.5 * leg2 });
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

describe("iter 109 — BTC LONG-ONLY 1000-day search", () => {
  it(
    "find BTC long-only configs profitable over 1000d",
    { timeout: 1_800_000 },
    async () => {
      console.log("\n=== ITER 109: BTC LONG-ONLY search ===");
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 24000,
      });
      const days = btc.length / 24;
      const bpw = Math.floor(btc.length / 10);
      console.log(`BTC: ${btc.length} bars = ${days.toFixed(0)} days`);

      const grid: Cfg[] = [];
      // RSI-extreme trigger
      for (const rsiBuy of [25, 30, 35, 40]) {
        for (const tp1 of [0.002, 0.003, 0.005, 0.008]) {
          for (const tp2Mult of [3, 6]) {
            for (const stop of [0.015, 0.02, 0.03]) {
              for (const hold of [6, 12, 24]) {
                for (const htfLen of [48, 96, 168]) {
                  grid.push({
                    lookback: 48,
                    trigger: "rsi_extreme",
                    rsiLen: 14,
                    rsiBuyMax: rsiBuy,
                    nBarsDown: 0,
                    volMult: 0,
                    priceZ: 0,
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
      // nBars_down trigger
      for (const nBars of [2, 3, 4, 5]) {
        for (const tp1 of [0.002, 0.003, 0.005, 0.008]) {
          for (const tp2Mult of [3, 6]) {
            for (const stop of [0.015, 0.02, 0.03]) {
              for (const hold of [6, 12, 24]) {
                for (const htfLen of [48, 96, 168]) {
                  grid.push({
                    lookback: 48,
                    trigger: "nBars_down",
                    rsiLen: 14,
                    rsiBuyMax: 0,
                    nBarsDown: nBars,
                    volMult: 0,
                    priceZ: 0,
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
      // vol_dip trigger
      for (const vm of [1.5, 2.0, 2.5]) {
        for (const pZ of [1.0, 1.5]) {
          for (const tp1 of [0.002, 0.003, 0.005, 0.008]) {
            for (const tp2Mult of [3, 6]) {
              for (const stop of [0.015, 0.02, 0.03]) {
                for (const hold of [6, 12, 24]) {
                  for (const htfLen of [48, 96, 168]) {
                    grid.push({
                      lookback: 48,
                      trigger: "vol_dip",
                      rsiLen: 14,
                      rsiBuyMax: 0,
                      nBarsDown: 0,
                      volMult: vm,
                      priceZ: pZ,
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
      }
      console.log(`Grid: ${grid.length} configs (3 triggers × params)`);

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
        if (wr < 0.55 || ret <= 0 || sh < 0.5 || tpd < 0.3) continue;
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
        if (pctProf < 0.5) continue;
        const minRet = Math.min(...perRet);
        if (minRet < -0.05) continue;
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
        `\n${results.length} BTC LONG-ONLY configs pass (WR≥55, Shp≥0.5, pctProf≥50, minRet≥-5%, tpd≥0.3)`,
      );
      if (results.length === 0) {
        console.log(
          "\n✗ Even LONG-ONLY BTC fails 1000-day multi-period validation.",
        );
        return;
      }
      console.log(
        "\n── Top 30 by (Sharpe × sqrt(tpd) × pctProf) ──\n" +
          "trig".padEnd(12) +
          "param".padStart(8) +
          "tp1/tp2".padStart(14) +
          "stop".padStart(6) +
          "h".padStart(4) +
          "htf".padStart(5) +
          "n".padStart(6) +
          "tpd".padStart(6) +
          "WR%".padStart(7) +
          "ret%".padStart(9) +
          "Shp".padStart(6) +
          "medWR".padStart(7) +
          "%prof".padStart(7) +
          "minRet".padStart(8),
      );
      const sorted = results.sort(
        (a, b) =>
          b.sharpe * Math.sqrt(b.tpd) * b.pctProf -
          a.sharpe * Math.sqrt(a.tpd) * a.pctProf,
      );
      for (const r of sorted.slice(0, 30)) {
        const c = r.cfg;
        const paramStr =
          c.trigger === "rsi_extreme"
            ? `rsi≤${c.rsiBuyMax}`
            : c.trigger === "nBars_down"
              ? `${c.nBarsDown}red`
              : `v${c.volMult}z${c.priceZ}`;
        console.log(
          c.trigger.padEnd(12) +
            paramStr.padStart(8) +
            `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(2)}`.padStart(
              14,
            ) +
            (c.stopPct * 100).toFixed(1).padStart(6) +
            c.holdBars.toString().padStart(4) +
            c.htfLen.toString().padStart(5) +
            r.n.toString().padStart(6) +
            r.tpd.toFixed(2).padStart(6) +
            (r.wr * 100).toFixed(1).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(9) +
            r.sharpe.toFixed(2).padStart(6) +
            (r.medWR * 100).toFixed(1).padStart(7) +
            (r.pctProf * 100).toFixed(0).padStart(7) +
            (r.minRet * 100).toFixed(1).padStart(8),
        );
      }
    },
  );
});
