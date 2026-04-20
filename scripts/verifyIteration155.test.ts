/**
 * Iter 155 — 5-gate validation of iter154's leveraged flash-crash daytrade.
 *
 * iter154 winner (tight-stop variant): drop=48b/15%, tp=5%, stop=1.5%, hold=12h.
 * At 5× leverage: effMean 5.72%, maxDD −38%, cumRet +300%, 31 trades in 8.7y.
 *
 * Alternative higher-n: drop=48b/12%, tp=10%, stop=2.0%, hold=12h.
 * Raw: n=54, WR 37%, mean 1.02%, min −2.05%, bs+ 100%.
 * At 5× leverage: effMean 5.11%, maxDD −48%, cumRet +417%.
 *
 * This iter:
 *   G1: base stats — n≥30, mean≥5%, bs+≥90%, cumRet>0
 *   G2: both halves (chronological 50/50) effMean > 0
 *   G3: adjacent-config sensitivity — 6 variants ≥ 60% still effMean ≥ 3%
 *   G4: leverage sensitivity — 4× and 6× both alive (no bankruptcy)
 *   G5: 60/40 OOS — OOS effMean ≥ 3%, no bankruptcy
 *
 * If the higher-n config (n=54) passes all 5 gates, ship it.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

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

interface Trade {
  pnl: number;
  openBar: number;
}

function runFlashCrash(
  candles: Candle[],
  dropBars: number,
  dropPct: number,
  tpPct: number,
  stopPct: number,
  hold: number,
): Trade[] {
  const trades: Trade[] = [];
  let cooldown = -1;
  for (let i = Math.max(dropBars + 1, 1); i < candles.length - 1; i++) {
    if (i < cooldown) continue;
    const prev = candles[i - dropBars].close;
    const cur = candles[i].close;
    if (prev <= 0) continue;
    const drop = (cur - prev) / prev;
    if (drop > -dropPct) continue;
    if (cur <= candles[i - 1].close) continue;
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 + tpPct);
    const stop = entry * (1 - stopPct);
    const mx = Math.min(i + 1 + hold, candles.length - 1);
    let exitBar = mx;
    let exitPrice = candles[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      if (bar.low <= stop) {
        exitBar = j;
        exitPrice = stop;
        break;
      }
      if (bar.high >= tp) {
        exitBar = j;
        exitPrice = tp;
        break;
      }
    }
    const pnl = applyCosts({
      entry,
      exit: exitPrice,
      direction: "long",
      holdingHours: exitBar - (i + 1),
      config: MAKER_COSTS,
    }).netPnlPct;
    trades.push({ pnl, openBar: i });
    cooldown = exitBar + 1;
  }
  return trades;
}

function applyLeverage(
  pnls: number[],
  leverage: number,
): {
  effPnls: number[];
  bankrupt: boolean;
  maxDd: number;
  cumRet: number;
  liquidations: number;
} {
  const effPnls: number[] = [];
  let liquidations = 0;
  for (const p of pnls) {
    const lev = p * leverage;
    if (lev <= -0.9) {
      effPnls.push(-1.0);
      liquidations++;
    } else {
      effPnls.push(lev);
    }
  }
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  let bankrupt = false;
  for (const p of effPnls) {
    eq *= 1 + p;
    if (eq <= 0.01) {
      bankrupt = true;
      break;
    }
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return {
    effPnls,
    bankrupt,
    maxDd,
    cumRet: bankrupt ? -1 : eq - 1,
    liquidations,
  };
}

describe("iter 155 — 5-gate validation of leveraged flash-crash daytrade", () => {
  it(
    "validate and ship flash-crash tier if 5 gates pass",
    { timeout: 600_000 },
    async () => {
      console.log(
        "\n=== ITER 155: 5-gate validation of leveraged flash-crash ===",
      );
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      console.log(`loaded ${c.length} 1h candles`);

      // Primary candidate: higher-n config with decent mean
      const PRIMARY = {
        dropBars: 48,
        dropPct: 0.12,
        tp: 0.1,
        stop: 0.02,
        hold: 12,
        leverage: 5,
      };
      // Alt: the top-mean config
      const ALT = {
        dropBars: 48,
        dropPct: 0.15,
        tp: 0.05,
        stop: 0.02,
        hold: 12,
        leverage: 5,
      };

      for (const CFG of [PRIMARY, ALT]) {
        console.log(
          `\n=== Testing config: drop=${CFG.dropBars}b/${(CFG.dropPct * 100).toFixed(0)}%, tp=${(CFG.tp * 100).toFixed(0)}%, stop=${(CFG.stop * 100).toFixed(1)}%, hold=${CFG.hold}h, lev=${CFG.leverage}× ===`,
        );
        const trades = runFlashCrash(
          c,
          CFG.dropBars,
          CFG.dropPct,
          CFG.tp,
          CFG.stop,
          CFG.hold,
        );
        const rawPnls = trades.map((t) => t.pnl);
        const lev = applyLeverage(rawPnls, CFG.leverage);
        const effMean =
          lev.effPnls.reduce((a, b) => a + b, 0) /
          Math.max(1, lev.effPnls.length);

        // G1: base stats
        const bs = bootstrap(
          lev.effPnls,
          200,
          Math.max(3, Math.floor(lev.effPnls.length / 15)),
          1234,
        );
        const g1 =
          lev.effPnls.length >= 30 &&
          effMean >= 0.05 &&
          bs.pctPositive >= 0.9 &&
          lev.cumRet > 0;
        console.log(
          `G1 base (n≥30, mean≥5%, bs+≥90%, cumRet>0): n=${lev.effPnls.length}, effMean=${(effMean * 100).toFixed(2)}%, bs+=${(bs.pctPositive * 100).toFixed(0)}%, cumRet=${(lev.cumRet * 100).toFixed(0)}% → ${g1 ? "✓" : "✗"}`,
        );

        // G2: both halves (chronological 50/50)
        const mid = Math.floor(trades.length / 2);
        const h1Raw = trades.slice(0, mid).map((t) => t.pnl);
        const h2Raw = trades.slice(mid).map((t) => t.pnl);
        const h1 = applyLeverage(h1Raw, CFG.leverage);
        const h2 = applyLeverage(h2Raw, CFG.leverage);
        const h1Mean =
          h1.effPnls.reduce((a, b) => a + b, 0) /
          Math.max(1, h1.effPnls.length);
        const h2Mean =
          h2.effPnls.reduce((a, b) => a + b, 0) /
          Math.max(1, h2.effPnls.length);
        const g2 = h1Mean > 0 && h2Mean > 0 && !h1.bankrupt && !h2.bankrupt;
        console.log(
          `G2 halves (both mean>0, no bankruptcy): H1 ${(h1Mean * 100).toFixed(2)}% / H2 ${(h2Mean * 100).toFixed(2)}% → ${g2 ? "✓" : "✗"}`,
        );

        // G3: adjacent-config sensitivity (6 variants)
        const variants = [
          { ...CFG, dropPct: Math.max(0.05, CFG.dropPct - 0.02) },
          { ...CFG, dropPct: CFG.dropPct + 0.02 },
          { ...CFG, tp: Math.max(0.02, CFG.tp - 0.02) },
          { ...CFG, tp: CFG.tp + 0.02 },
          { ...CFG, stop: Math.max(0.01, CFG.stop - 0.005) },
          { ...CFG, stop: CFG.stop + 0.005 },
        ];
        let vPass = 0;
        for (const v of variants) {
          const vt = runFlashCrash(
            c,
            v.dropBars,
            v.dropPct,
            v.tp,
            v.stop,
            v.hold,
          );
          if (vt.length < 20) continue;
          const vl = applyLeverage(
            vt.map((t) => t.pnl),
            v.leverage,
          );
          const vMean =
            vl.effPnls.reduce((a, b) => a + b, 0) / vl.effPnls.length;
          if (vMean >= 0.03 && !vl.bankrupt) vPass++;
        }
        const g3 = vPass >= 4;
        console.log(
          `G3 sensitivity (6 variants ≥4 hold mean≥3%): ${vPass}/6 → ${g3 ? "✓" : "✗"}`,
        );

        // G4: leverage robustness (4× and 6× alive)
        const lev4 = applyLeverage(rawPnls, CFG.leverage - 1);
        const lev6 = applyLeverage(rawPnls, CFG.leverage + 1);
        const g4 = !lev4.bankrupt && !lev6.bankrupt;
        console.log(
          `G4 leverage (${CFG.leverage - 1}× and ${CFG.leverage + 1}× alive): ${CFG.leverage - 1}× ${lev4.bankrupt ? "BANKRUPT" : "alive"}, ${CFG.leverage + 1}× ${lev6.bankrupt ? "BANKRUPT" : "alive"} → ${g4 ? "✓" : "✗"}`,
        );

        // G5: 60/40 OOS (chronological)
        const cut60 = Math.floor(c.length * 0.6);
        const inSample = c.slice(0, cut60);
        const oos = c.slice(cut60);
        const isTrades = runFlashCrash(
          inSample,
          CFG.dropBars,
          CFG.dropPct,
          CFG.tp,
          CFG.stop,
          CFG.hold,
        );
        const oosTrades = runFlashCrash(
          oos,
          CFG.dropBars,
          CFG.dropPct,
          CFG.tp,
          CFG.stop,
          CFG.hold,
        );
        const isLev = applyLeverage(
          isTrades.map((t) => t.pnl),
          CFG.leverage,
        );
        const oosLev = applyLeverage(
          oosTrades.map((t) => t.pnl),
          CFG.leverage,
        );
        const isMean =
          isLev.effPnls.reduce((a, b) => a + b, 0) /
          Math.max(1, isLev.effPnls.length);
        const oosMean =
          oosLev.effPnls.reduce((a, b) => a + b, 0) /
          Math.max(1, oosLev.effPnls.length);
        const g5 =
          oosLev.effPnls.length >= 5 && oosMean >= 0.03 && !oosLev.bankrupt;
        console.log(
          `G5 OOS (60/40, OOS mean≥3%, no bankruptcy): IS n=${isLev.effPnls.length} mean=${(isMean * 100).toFixed(2)}% / OOS n=${oosLev.effPnls.length} mean=${(oosMean * 100).toFixed(2)}% bankrupt=${oosLev.bankrupt} → ${g5 ? "✓" : "✗"}`,
        );

        const allPass = g1 && g2 && g3 && g4 && g5;
        console.log(
          `\n${allPass ? "★★★ ALL 5 GATES PASS ★★★" : "✗ Not all gates pass"}`,
        );
      }

      expect(true).toBe(true);
    },
  );
});
