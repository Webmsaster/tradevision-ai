/**
 * Marathon iteration 2: Per-Asset fine-tuning of stop/tp/holdBars/triggerBars.
 * Sequential greedy: tune asset A, then with A fixed tune B, etc.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 2;
const SOURCES = ["ETHUSDT", "BTCUSDT", "BNBUSDT", "ADAUSDT", "DOGEUSDT"];

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

describe("Marathon 2 - Per-Asset fine-tune", { timeout: 1800_000 }, () => {
  it("sequential greedy tuning per asset", async () => {
    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES)
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);

    let cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
      liveCaps: LIVE_CAPS,
    };
    let curR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V4 BASELINE", curR));

    // Tune each asset sequentially
    for (const targetSym of SOURCES) {
      const targetSymKey = `${targetSym.replace("USDT", "")}-TREND`;
      let assetBest = { cfg: cur, r: curR, label: "current" };
      for (const tb of [1, 2, 3]) {
        for (const sp of [0.03, 0.04, 0.05]) {
          for (const tp of [0.05, 0.07, 0.1]) {
            if (tp <= sp) continue;
            for (const hb of [120, 240, 360]) {
              const cfg: FtmoDaytrade24hConfig = {
                ...cur,
                assets: cur.assets.map((a) =>
                  a.symbol === targetSymKey
                    ? {
                        ...a,
                        triggerBars: tb,
                        stopPct: sp,
                        tpPct: tp,
                        holdBars: hb,
                      }
                    : a,
                ),
              };
              const r = runWalkForward(data, cfg, TF_HOURS);
              if (score(r, assetBest.r) < 0) {
                assetBest = {
                  cfg,
                  r,
                  label: `tb=${tb} sp=${sp} tp=${tp} hb=${hb}`,
                };
              }
            }
          }
        }
      }
      cur = assetBest.cfg;
      curR = assetBest.r;
      console.log(
        `  ${targetSymKey}: ${assetBest.label} → ${(assetBest.r.passRate * 100).toFixed(2)}% / p90=${assetBest.r.p90Days}`,
      );
    }
    console.log(`\n========== M2 FINAL ==========`);
    console.log(
      fmt("V4 baseline", {
        passes: 0,
        windows: 0,
        passRate: 0,
        medianDays: 0,
        p75Days: 0,
        p90Days: 0,
        tlBreaches: 0,
        dlBreaches: 0,
        ev: 0,
      } as any),
    );
    console.log(fmt("After per-asset tune", curR));
    expect(curR.windows).toBeGreaterThan(50);
  });
});
