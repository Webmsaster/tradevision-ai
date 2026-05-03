/**
 * Phase T — per-asset TP retune on V5_ZIRKON (post-mct=10 + hour-drop change).
 * Phase O tuned TPs on V5_PLATINUM_30M; ZIRKON shifted them all by -0.005.
 * Re-tune per asset on the new ZIRKON config.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_ZIRKON_PHASE_T_${STAMP}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
}
function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}
function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}
interface Result {
  name: string;
  pass1: number;
  pass3: number;
  passes1: number;
  passes3: number;
  n1: number;
  n3: number;
  tl3: number;
  med3: number;
  wr3: number;
}
function evaluate(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
): Result {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const compute = (stepBars: number) => {
    let windows = 0,
      passes = 0,
      tl = 0,
      totalT = 0,
      totalW = 0;
    const days: number[] = [];
    for (let start = 0; start + winBars <= n; start += stepBars) {
      const slice: Record<string, Candle[]> = {};
      for (const s of symbols)
        slice[s] = aligned[s].slice(start, start + winBars);
      const res = runFtmoDaytrade24h(slice, cfg);
      windows++;
      if (res.passed) {
        passes++;
        days.push(res.passDay ?? 0);
      } else if (res.reason === "total_loss") tl++;
      for (const t of res.trades) {
        totalT++;
        if (t.effPnl > 0) totalW++;
      }
    }
    days.sort((a, b) => a - b);
    return {
      passes,
      windows,
      tl,
      med: days[Math.floor(days.length * 0.5)] ?? 0,
      wr: totalT > 0 ? totalW / totalT : 0,
    };
  };
  const r1 = compute(BARS_PER_DAY);
  const r3 = compute(3 * BARS_PER_DAY);
  return {
    name,
    pass1: r1.passes / r1.windows,
    pass3: r3.passes / r3.windows,
    passes1: r1.passes,
    passes3: r3.passes,
    n1: r1.windows,
    n3: r3.windows,
    tl3: r3.tl,
    med3: r3.med,
    wr3: r3.wr,
  };
}
function fmt(r: Result): string {
  return `${r.name.padEnd(36)} 1d=${(r.pass1 * 100).toFixed(2).padStart(6)}% (${r.passes1}/${r.n1}) | 3d=${(r.pass3 * 100).toFixed(2).padStart(6)}% (${r.passes3}/${r.n3}) | wr=${(r.wr3 * 100).toFixed(2).padStart(6)}% TL3=${r.tl3}`;
}
function setAssetTp(
  cfg: FtmoDaytrade24hConfig,
  label: string,
  tp: number,
): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    assets: cfg.assets.map((a) =>
      a.symbol === label ? { ...a, tpPct: tp } : a,
    ),
  };
}

describe("V5_ZIRKON Phase T", { timeout: 6 * 3600_000 }, () => {
  it("per-asset TP retune on V5_ZIRKON 30m", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_ZIRKON_PHASE_T START ${new Date().toISOString()}\n`,
    );

    const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON);
    log(`\nLoading 30m: ${symbols.join(", ")}`);
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const raw = await loadBinanceHistory({
        symbol: s,
        timeframe: "30m",
        targetCount: 100000,
        maxPages: 120,
      });
      data[s] = raw.filter((c) => c.isFinal);
    }

    const baseR = evaluate(
      "V5_ZIRKON baseline",
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON,
      data,
    );
    log(fmt(baseR));

    const TPs = [0.02, 0.025, 0.03, 0.035, 0.04, 0.045, 0.05, 0.055];
    let best = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON;
    let bestR = baseR;
    const perAssetBest: Record<string, number> = {};

    for (const asset of best.assets.map((a) => a.symbol)) {
      log(`\n========== ${asset} ==========`);
      let aBest = bestR;
      let aBestTp = best.assets.find((a) => a.symbol === asset)?.tpPct ?? 0.025;
      for (const tp of TPs) {
        const trial = setAssetTp(best, asset, tp);
        const r = evaluate(
          `${asset} tp=${(tp * 100).toFixed(1)}%`,
          trial,
          data,
        );
        log(fmt(r));
        if (r.pass1 > aBest.pass1 && r.med3 <= 4) {
          aBest = r;
          aBestTp = tp;
        }
      }
      best = setAssetTp(best, asset, aBestTp);
      bestR = aBest;
      perAssetBest[asset] = aBestTp;
      log(
        `  → ${asset} best tp=${(aBestTp * 100).toFixed(1)}% (running 1d=${(bestR.pass1 * 100).toFixed(2)}%)`,
      );
    }

    log(`\n========== FINAL ==========`);
    log(fmt(bestR));
    for (const a of best.assets)
      log(`  ${a.symbol.padEnd(15)} tp=${((a.tpPct ?? 0) * 100).toFixed(1)}%`);
    log(
      `vs baseline: 1d=+${((bestR.pass1 - baseR.pass1) * 100).toFixed(2)}pp / 3d=+${((bestR.pass3 - baseR.pass3) * 100).toFixed(2)}pp`,
    );

    writeFileSync(
      `${LOG_DIR}/V5_ZIRKON_PHASE_T_${STAMP}.json`,
      JSON.stringify(
        {
          baseline: baseR,
          perAssetBestTp: perAssetBest,
          finalAssets: best.assets.map((a) => ({
            symbol: a.symbol,
            sourceSymbol: a.sourceSymbol,
            tpPct: a.tpPct,
          })),
          finalResult: bestR,
        },
        null,
        2,
      ),
    );

    expect(bestR.pass1).toBeGreaterThanOrEqual(baseR.pass1);
  });
});
