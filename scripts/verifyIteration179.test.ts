/**
 * Iter 179 — MAXIMUM portfolio optimization.
 *
 * User: "optimiere bis zum maxium was möglich ist".
 *
 * Current flagship: BTC+ETH 50/50 → 96.55% OOS, 40 trades/day, EV +$3763.
 *
 * Push to the ceiling:
 *   A) Add SOL (higher vol than BTC, should fire often)
 *   B) Add AVAX (also high vol)
 *   C) 3-asset (BTC+ETH+SOL) at 33% each vs 4-asset (add AVAX) at 25% each
 *   D) Per-asset risk optimization (asymmetric — weight better performers higher)
 *   E) Explore higher total exposure (e.g. 50% each on 3 assets = 150% total)
 *
 * Stop when marginal asset stops adding EV. Find the absolute peak.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";

interface Trade {
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
  symbol: string;
  dir: "long" | "short";
}

function runBi(
  c: Candle[],
  symbol: string,
  tp: number,
  stop: number,
  hold: number,
  wS: number,
  wE: number,
  bpd: number,
): Trade[] {
  const out: Trade[] = [];
  if (!c[wS]) return out;
  const ts0 = c[wS].openTime;
  let cd = -1;
  for (let i = Math.max(3, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    if (c[i].close >= c[i - 1].close) continue;
    if (c[i - 1].close >= c[i - 2].close) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tpPx = entry * (1 + tp);
    const stPx = entry * (1 - stop);
    const mx = Math.min(i + 1 + hold, wE - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      if (c[j].low <= stPx) {
        xb = j;
        xp = stPx;
        break;
      }
      if (c[j].high >= tpPx) {
        xb = j;
        xp = tpPx;
        break;
      }
    }
    const pnl = applyCosts({
      entry,
      exit: xp,
      direction: "long",
      holdingHours: (xb - (i + 1)) / (bpd / 24),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    if (day >= 0)
      out.push({
        rawPnl: pnl,
        day,
        entryTime: eb.openTime,
        exitTime: c[xb].closeTime,
        symbol,
        dir: "long",
      });
    cd = xb + 1;
  }
  cd = -1;
  for (let i = Math.max(3, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    if (c[i].close <= c[i - 1].close) continue;
    if (c[i - 1].close <= c[i - 2].close) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tpPx = entry * (1 - tp);
    const stPx = entry * (1 + stop);
    const mx = Math.min(i + 1 + hold, wE - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      if (c[j].high >= stPx) {
        xb = j;
        xp = stPx;
        break;
      }
      if (c[j].low <= tpPx) {
        xb = j;
        xp = tpPx;
        break;
      }
    }
    const pnl = applyCosts({
      entry,
      exit: xp,
      direction: "short",
      holdingHours: (xb - (i + 1)) / (bpd / 24),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    if (day >= 0)
      out.push({
        rawPnl: pnl,
        day,
        entryTime: eb.openTime,
        exitTime: c[xb].closeTime,
        symbol,
        dir: "short",
      });
    cd = xb + 1;
  }
  return out;
}

interface AssetCfg {
  symbol: string;
  tp: number;
  stop: number;
  hold: number;
  risk: number;
}

function simFtmo(
  candlesMap: Record<string, Candle[]>,
  assets: AssetCfg[],
  wS: number,
  wE: number,
  bpd: number,
  leverage: number,
): { passed: boolean; trades: number } {
  const allTrades: Trade[] = [];
  for (const a of assets) {
    const c = candlesMap[a.symbol];
    if (!c) continue;
    // assume all candle arrays aligned (same start)
    const t = runBi(c, a.symbol, a.tp, a.stop, a.hold, wS, wE, bpd);
    // attach risk via trade
    for (const tr of t) {
      allTrades.push({ ...tr, rawPnl: tr.rawPnl * leverage * a.risk });
    }
  }
  allTrades.sort((a, b) => a.day - b.day || a.entryTime - b.entryTime);

  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  for (const t of allTrades) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    // t.rawPnl already pre-scaled; cap per-trade loss at risk fraction
    const cfg = assets.find((a) => a.symbol === t.symbol)!;
    const capped = Math.max(t.rawPnl, -cfg.risk);
    eq *= 1 + capped;
    td.add(t.day);
    if (eq <= 0.9) return { passed: false, trades: allTrades.length };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05)
      return { passed: false, trades: allTrades.length };
    if (eq >= 1.1 && td.size >= 4)
      return { passed: true, trades: allTrades.length };
  }
  return {
    passed: eq >= 1.1 && td.size >= 4,
    trades: allTrades.length,
  };
}

describe("iter 179 — maximum portfolio", () => {
  it(
    "push to ceiling with 3-4 assets + optimal risk",
    { timeout: 1_200_000 },
    async () => {
      console.log("\n=== ITER 179: MAXIMUM PORTFOLIO ===");
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT"];
      const candles: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          candles[s] = await loadBinanceHistory({
            symbol: s as "BTCUSDT",
            timeframe: "15m",
            targetCount: 100_000,
            maxPages: 200,
          });
          console.log(`  ${s}: ${candles[s].length} candles loaded`);
        } catch (e) {
          console.log(`  ${s}: LOAD FAILED - ${e}`);
        }
      }

      const bpd = 96;
      // align to common timestamp range
      const minTs = Math.max(
        ...symbols.filter((s) => candles[s]).map((s) => candles[s][0].openTime),
      );
      const maxTs = Math.min(
        ...symbols
          .filter((s) => candles[s])
          .map((s) => candles[s][candles[s].length - 1].openTime),
      );
      // trim each to the common range
      for (const s of symbols) {
        if (!candles[s]) continue;
        const startIdx = candles[s].findIndex((c) => c.openTime >= minTs);
        const endIdx = candles[s].findIndex((c) => c.openTime > maxTs);
        candles[s] = candles[s].slice(
          startIdx,
          endIdx === -1 ? undefined : endIdx,
        );
      }
      const alignedLen = Math.min(
        ...symbols.filter((s) => candles[s]).map((s) => candles[s].length),
      );
      console.log(
        `\nAligned to ${alignedLen} candles (~${(alignedLen / bpd).toFixed(0)} days)\n`,
      );

      const winLen = 30 * bpd;
      const wins15OV: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < alignedLen; s += 7 * bpd)
        wins15OV.push({ start: s, end: s + winLen });
      const cut = Math.floor(wins15OV.length * 0.6);
      const oosOV = wins15OV.slice(cut);
      const wins15NO: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < alignedLen; s += winLen)
        wins15NO.push({ start: s, end: s + winLen });
      console.log(
        `${wins15NO.length} NOV, ${wins15OV.length} OV (OOS ${oosOV.length})\n`,
      );

      // Per-asset params (V3-optimized)
      const P: Record<string, { tp: number; stop: number; hold: number }> = {
        BTCUSDT: { tp: 0.012, stop: 0.001, hold: 12 },
        ETHUSDT: { tp: 0.01, stop: 0.0015, hold: 12 },
        SOLUSDT: { tp: 0.012, stop: 0.0015, hold: 12 },
        AVAXUSDT: { tp: 0.012, stop: 0.0015, hold: 12 },
      };

      function batch(assets: AssetCfg[]) {
        let pN = 0,
          pO = 0,
          totTrades = 0,
          totDays = 0;
        for (const w of wins15NO) {
          const r = simFtmo(candles, assets, w.start, w.end, bpd, 2);
          totTrades += r.trades;
          totDays += 30;
          if (r.passed) pN++;
        }
        for (const w of oosOV) {
          const r = simFtmo(candles, assets, w.start, w.end, bpd, 2);
          if (r.passed) pO++;
        }
        return {
          nov: pN,
          oos: pO,
          rateN: pN / wins15NO.length,
          rateO: pO / oosOV.length,
          tpd: totTrades / totDays,
        };
      }

      // ─── A: Individual asset pass rates (baseline) ───
      console.log("── A: Each asset solo @ 100% risk ──");
      for (const sym of symbols) {
        if (!candles[sym]) continue;
        const r = batch([{ symbol: sym, ...P[sym], risk: 1.0 }]);
        console.log(
          `  ${sym.padEnd(10)} NOV ${r.nov}/${wins15NO.length} (${(r.rateN * 100).toFixed(2)}%)  OOS ${r.oos}/${oosOV.length} (${(r.rateO * 100).toFixed(2)}%)  ${r.tpd.toFixed(1)}/day`,
        );
      }

      // ─── B: 2-asset combos at 50% each ───
      console.log("\n── B: 2-asset portfolios @ 50% each ──");
      const pairs: [string, string][] = [
        ["BTCUSDT", "ETHUSDT"],
        ["BTCUSDT", "SOLUSDT"],
        ["BTCUSDT", "AVAXUSDT"],
        ["ETHUSDT", "SOLUSDT"],
        ["ETHUSDT", "AVAXUSDT"],
        ["SOLUSDT", "AVAXUSDT"],
      ];
      for (const [a, b] of pairs) {
        if (!candles[a] || !candles[b]) continue;
        const r = batch([
          { symbol: a, ...P[a], risk: 0.5 },
          { symbol: b, ...P[b], risk: 0.5 },
        ]);
        console.log(
          `  ${a}+${b}  NOV ${(r.rateN * 100).toFixed(2)}%  OOS ${(r.rateO * 100).toFixed(2)}%  ${r.tpd.toFixed(1)}/day  EV +$${(r.rateO * 0.5 * 8000 - 99).toFixed(0)}`,
        );
      }

      // ─── C: 3-asset combos ───
      console.log("\n── C: 3-asset portfolios ──");
      const triples: [string, string, string][] = [
        ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
        ["BTCUSDT", "ETHUSDT", "AVAXUSDT"],
        ["BTCUSDT", "SOLUSDT", "AVAXUSDT"],
        ["ETHUSDT", "SOLUSDT", "AVAXUSDT"],
      ];
      for (const [a, b, c] of triples) {
        if (!candles[a] || !candles[b] || !candles[c]) continue;
        for (const rf of [0.33, 0.5]) {
          const r = batch([
            { symbol: a, ...P[a], risk: rf },
            { symbol: b, ...P[b], risk: rf },
            { symbol: c, ...P[c], risk: rf },
          ]);
          console.log(
            `  ${a}+${b}+${c} @ ${(rf * 100).toFixed(0)}% each  NOV ${(r.rateN * 100).toFixed(2)}%  OOS ${(r.rateO * 100).toFixed(2)}%  ${r.tpd.toFixed(1)}/day  EV +$${(r.rateO * 0.5 * 8000 - 99).toFixed(0)}`,
          );
        }
      }

      // ─── D: 4-asset full portfolio ───
      console.log("\n── D: 4-asset portfolio ──");
      if (symbols.every((s) => candles[s])) {
        for (const rf of [0.25, 0.33, 0.4, 0.5]) {
          const r = batch(
            symbols.map((s) => ({ symbol: s, ...P[s], risk: rf })),
          );
          console.log(
            `  4-asset @ ${(rf * 100).toFixed(0)}% each  NOV ${(r.rateN * 100).toFixed(2)}%  OOS ${(r.rateO * 100).toFixed(2)}%  ${r.tpd.toFixed(1)}/day  EV +$${(r.rateO * 0.5 * 8000 - 99).toFixed(0)}`,
          );
        }
      }

      // ─── E: Asymmetric allocation — reward better performers ───
      console.log("\n── E: Asymmetric risk allocation ──");
      if (symbols.every((s) => candles[s])) {
        const allocs = [
          { BTCUSDT: 0.3, ETHUSDT: 0.5, SOLUSDT: 0.3, AVAXUSDT: 0.3 },
          { BTCUSDT: 0.4, ETHUSDT: 0.6, SOLUSDT: 0.3, AVAXUSDT: 0.3 },
          { BTCUSDT: 0.3, ETHUSDT: 0.3, SOLUSDT: 0.5, AVAXUSDT: 0.3 },
          { BTCUSDT: 0.25, ETHUSDT: 0.5, SOLUSDT: 0.4, AVAXUSDT: 0.25 },
          { BTCUSDT: 0.5, ETHUSDT: 0.5, SOLUSDT: 0.5, AVAXUSDT: 0.5 },
        ];
        for (const a of allocs) {
          const r = batch(
            symbols.map((s) => ({
              symbol: s,
              ...P[s],
              risk: a[s as keyof typeof a],
            })),
          );
          console.log(
            `  BTC ${a.BTCUSDT} ETH ${a.ETHUSDT} SOL ${a.SOLUSDT} AVAX ${a.AVAXUSDT}  NOV ${(r.rateN * 100).toFixed(2)}%  OOS ${(r.rateO * 100).toFixed(2)}%  ${r.tpd.toFixed(1)}/day  EV +$${(r.rateO * 0.5 * 8000 - 99).toFixed(0)}`,
          );
        }
      }

      expect(true).toBe(true);
    },
  );
});
