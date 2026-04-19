/**
 * Iter 105: MASSIVE 1000-day multi-asset systematic search.
 *
 * After iter98-104 proved the existing HF system is overfit to 104 days,
 * this iteration searches across BOTH fade AND momentum + many parameter
 * combinations to find ANY config that survives multi-year validation.
 *
 * Data: 1h × 24000 bars (~1000 days = 2.7 years) per asset, 5 assets.
 * Strict criteria per config:
 *   - portfolio cumRet > 0 (net profitable across all 5 assets)
 *   - full-history WR ≥ 80%
 *   - portfolio avgTrades ≥ 1/day (daytrading frequency)
 *   - pctProf ≥ 60% (≥ 60% of 10 disjoint 100-day windows profitable)
 *   - per-asset ret ≥ -2% (no asset deeply negative)
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const ASSETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT", "AVAXUSDT"];

interface Cfg {
  lookback: number;
  volMult: number;
  priceZ: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  mode: "fade" | "momentum";
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
function smaLast(v: number[], n: number) {
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

interface Trade {
  pnl: number;
}

function run(candles: Candle[], cfg: Cfg): Trade[] {
  const trades: Trade[] = [];
  for (let i = cfg.lookback; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0) continue;
    const w = candles.slice(i - cfg.lookback, i);
    const mv = median(w.map((c) => c.volume));
    if (mv <= 0) continue;
    const vZ = cur.volume / mv;
    if (vZ < cfg.volMult) continue;
    const sd = stdReturns(w.map((c) => c.close));
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
    const sma48 = smaLast(
      w.map((c) => c.close),
      Math.min(48, w.length),
    );
    const aligned = cur.close > sma48;
    if (direction === "long" && !aligned) continue;
    if (direction === "short" && aligned) continue;
    const p = candles[i - 1];
    const b = candles[i - 2];
    if (!p || !b) continue;
    if (cfg.mode === "momentum") {
      const pb = direction === "long" ? p.close < b.close : p.close > b.close;
      if (!pb) continue;
    } else {
      const sameDir = ret > 0 ? p.close > b.close : p.close < b.close;
      if (!sameDir) continue;
    }
    if (new Date(cur.openTime).getUTCHours() === 0) continue;
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp1L =
      direction === "long"
        ? entry * (1 + cfg.tp1Pct)
        : entry * (1 - cfg.tp1Pct);
    const tp2L =
      direction === "long"
        ? entry * (1 + cfg.tp2Pct)
        : entry * (1 - cfg.tp2Pct);
    let sL =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);
    const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1Bar = -1;
    let l2P = candles[mx].close;
    let l2B = mx;
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      const sH = direction === "long" ? bar.low <= sL : bar.high >= sL;
      const t1 = direction === "long" ? bar.high >= tp1L : bar.low <= tp1L;
      const t2 = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
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
        const s2 = direction === "long" ? bar.low <= sL : bar.high >= sL;
        const t22 = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
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

describe("iter 105 — 1000-day multi-asset systematic search", () => {
  it(
    "find any config profitable over 1000+ days",
    { timeout: 1_800_000 },
    async () => {
      console.log("\n=== ITER 105: 1000-day systematic search ===");
      const data: Record<string, Candle[]> = {};
      for (const s of ASSETS) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "1h",
            targetCount: 24000,
          });
          console.log(
            `${s}: ${data[s].length} bars = ${(data[s].length / 24).toFixed(0)} days`,
          );
        } catch {
          // skip
        }
      }
      const avail = ASSETS.filter((s) => data[s]);
      const maxBars = Math.max(...avail.map((s) => data[s].length));
      const days = maxBars / 24;
      const barsPerWindow = Math.floor(maxBars / 10); // 10 disjoint ~100-day windows
      console.log(
        `${avail.length} assets, ${days.toFixed(0)} days, 10 × 100-day windows`,
      );

      // GRID: aggressive focused
      const grid: Cfg[] = [];
      for (const mode of ["fade", "momentum"] as const) {
        for (const vm of [1.5, 2.0, 2.5, 3.0]) {
          for (const pZ of [1.0, 1.5, 2.0, 2.5]) {
            for (const tp1 of [0.0015, 0.002, 0.003, 0.005]) {
              for (const tp2Mult of [4, 8, 15]) {
                for (const stop of [0.015, 0.025, 0.04]) {
                  for (const hold of [6, 12, 24]) {
                    grid.push({
                      lookback: 48,
                      volMult: vm,
                      priceZ: pZ,
                      tp1Pct: tp1,
                      tp2Pct: tp1 * tp2Mult,
                      stopPct: stop,
                      holdBars: hold,
                      mode,
                    });
                  }
                }
              }
            }
          }
        }
      }
      console.log(`Grid: ${grid.length} configs × ${avail.length} assets`);

      interface Row {
        cfg: Cfg;
        n: number;
        wr: number;
        ret: number;
        tpd: number;
        pctProf: number;
        minRet: number;
        minPerAssetRet: number;
        medWR: number;
      }
      const results: Row[] = [];

      for (const cfg of grid) {
        // Full-history portfolio aggregate
        let n = 0,
          w = 0,
          sumLog = 0;
        const perAssetRet: number[] = [];
        for (const s of avail) {
          const t = run(data[s], cfg);
          n += t.length;
          w += t.filter((x) => x.pnl > 0).length;
          let aLog = 0;
          for (const x of t) {
            sumLog += Math.log(1 + x.pnl);
            aLog += Math.log(1 + x.pnl);
          }
          perAssetRet.push(Math.exp(aLog) - 1);
        }
        if (n < 500) continue;
        const wr = w / n;
        const ret = Math.exp(sumLog) - 1;
        if (wr < 0.8 || ret < 0) continue;
        // Multi-period portfolio check
        const perWinRet: number[] = [];
        const perWinWR: number[] = [];
        for (let win = 0; win < 10; win++) {
          let wn = 0,
            ww = 0,
            wsl = 0;
          for (const s of avail) {
            const start = win * barsPerWindow;
            const slice = data[s].slice(start, start + barsPerWindow);
            if (slice.length < 200) continue;
            const t = run(slice, cfg);
            wn += t.length;
            ww += t.filter((x) => x.pnl > 0).length;
            for (const x of t) wsl += Math.log(1 + x.pnl);
          }
          if (wn > 0) perWinWR.push(ww / wn);
          perWinRet.push(Math.exp(wsl) - 1);
        }
        const pctProf =
          perWinRet.filter((r) => r > 0).length / perWinRet.length;
        const minRet = Math.min(...perWinRet);
        const minPerAssetRet = Math.min(...perAssetRet);
        const sortedWR = [...perWinWR].sort();
        const medWR = sortedWR[Math.floor(sortedWR.length / 2)] ?? 0;
        const tpd = n / (avail.length * days);
        if (pctProf < 0.6) continue;
        if (minPerAssetRet < -0.02) continue;
        results.push({
          cfg,
          n,
          wr,
          ret,
          tpd,
          pctProf,
          minRet,
          minPerAssetRet,
          medWR,
        });
      }

      console.log(
        `\n${results.length} configs pass strict multi-year filter (portfolio+, WR≥80, pctProf≥60, no asset <-2%)`,
      );

      if (results.length === 0) {
        console.log("\n✗ NO CONFIG SURVIVES 1000-DAY MULTI-ASSET VALIDATION");
        console.log(
          "  Honest conclusion: no simple HF daytrading edge exists over 2.7+ years",
        );
        console.log(
          "  with the current mechanic (volume-spike + scale-out + BE-stop).",
        );
        return;
      }

      console.log(
        "\n── Top 20 by (portfolio ret × pctProf × sqrt(tpd)) ──\n" +
          "mode".padEnd(10) +
          "vm".padStart(5) +
          "pZ".padStart(5) +
          "tp1/tp2".padStart(14) +
          "stop".padStart(6) +
          "h".padStart(4) +
          "n".padStart(5) +
          "tpd".padStart(6) +
          "WR%".padStart(7) +
          "ret%".padStart(8) +
          "medWR".padStart(7) +
          "%prof".padStart(7) +
          "minRet".padStart(8) +
          "minAst".padStart(8),
      );
      const sorted = results.sort(
        (a, b) =>
          b.ret * b.pctProf * Math.sqrt(b.tpd) -
          a.ret * a.pctProf * Math.sqrt(a.tpd),
      );
      for (const r of sorted.slice(0, 20)) {
        const c = r.cfg;
        console.log(
          c.mode.padEnd(10) +
            c.volMult.toFixed(1).padStart(5) +
            c.priceZ.toFixed(1).padStart(5) +
            `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(2)}`.padStart(
              14,
            ) +
            (c.stopPct * 100).toFixed(1).padStart(6) +
            c.holdBars.toString().padStart(4) +
            r.n.toString().padStart(5) +
            r.tpd.toFixed(2).padStart(6) +
            (r.wr * 100).toFixed(1).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(8) +
            (r.medWR * 100).toFixed(1).padStart(7) +
            (r.pctProf * 100).toFixed(0).padStart(7) +
            (r.minRet * 100).toFixed(1).padStart(8) +
            (r.minPerAssetRet * 100).toFixed(1).padStart(8),
        );
      }
    },
  );
});
