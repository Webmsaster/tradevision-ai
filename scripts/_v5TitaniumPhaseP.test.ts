/**
 * Phase P — Asset expansion on V5_TITANIUM 30m base.
 * Try 22 FTMO crypto candidates greedy, 30m TF.
 * Each new asset uses tp=2.5% (median 30m optimum from Phase O).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_TITANIUM_PHASE_P_${STAMP}.log`;
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
  return `${r.name.padEnd(40)} 1d=${(r.pass1 * 100).toFixed(2).padStart(6)}% (${r.passes1}/${r.n1}) | 3d=${(r.pass3 * 100).toFixed(2).padStart(6)}% (${r.passes3}/${r.n3}) | wr=${(r.wr3 * 100).toFixed(2).padStart(6)}% TL3=${r.tl3}`;
}
function makeAsset(
  srcSym: string,
  label: string,
  tp: number,
): FtmoDaytrade24hConfig["assets"][number] {
  return {
    symbol: label,
    sourceSymbol: srcSym,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: true,
    stopPct: 0.05,
    tpPct: tp,
    holdBars: 240,
  };
}

const CANDIDATES: Array<{ binance: string; label: string }> = [
  { binance: "DOTUSDT", label: "DOT-TREND" },
  { binance: "UNIUSDT", label: "UNI-TREND" },
  { binance: "MATICUSDT", label: "MATIC-TREND" },
  { binance: "TRXUSDT", label: "TRX-TREND" },
  { binance: "ATOMUSDT", label: "ATOM-TREND" },
  { binance: "FILUSDT", label: "FIL-TREND" },
  { binance: "ALGOUSDT", label: "ALGO-TREND" },
  { binance: "ICPUSDT", label: "ICP-TREND" },
  { binance: "NEARUSDT", label: "NEAR-TREND" },
  { binance: "MANAUSDT", label: "MANA-TREND" },
  { binance: "STXUSDT", label: "STX-TREND" },
  { binance: "MKRUSDT", label: "MKR-TREND" },
  { binance: "GRTUSDT", label: "GRT-TREND" },
  { binance: "GALAUSDT", label: "GALA-TREND" },
  { binance: "OPUSDT", label: "OP-TREND" },
  { binance: "ARBUSDT", label: "ARB-TREND" },
  { binance: "FETUSDT", label: "FET-TREND" },
  { binance: "LDOUSDT", label: "LDO-TREND" },
  { binance: "APTUSDT", label: "APT-TREND" },
  { binance: "IMXUSDT", label: "IMX-TREND" },
  { binance: "SUIUSDT", label: "SUI-TREND" },
  { binance: "TIAUSDT", label: "TIA-TREND" },
];

describe("V5_TITANIUM Phase P", { timeout: 8 * 3600_000 }, () => {
  it("greedy asset expansion on V5_TITANIUM 30m", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_TITANIUM_PHASE_P START ${new Date().toISOString()}\n`,
    );

    const baseSyms = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM);
    const allSyms = [
      ...new Set([...baseSyms, ...CANDIDATES.map((c) => c.binance)]),
    ].sort();
    log(`\nLoading 30m: ${allSyms.length} symbols`);
    const data: Record<string, Candle[]> = {};
    for (const s of allSyms) {
      try {
        const raw = await loadBinanceHistory({
          symbol: s,
          timeframe: "30m",
          targetCount: 100000,
          maxPages: 120,
        });
        data[s] = raw.filter((c) => c.isFinal);
        log(
          `  ${s.padEnd(10)} final=${data[s].length} first=${new Date(data[s][0]?.openTime ?? 0).toISOString().slice(0, 10)}`,
        );
      } catch (e) {
        log(`  ${s.padEnd(10)} LOAD FAILED: ${String(e).slice(0, 80)}`);
      }
    }

    log(`\n========== BASELINE ==========`);
    const baseR = evaluate(
      "V5_TITANIUM baseline",
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
      data,
    );
    log(fmt(baseR));

    log(`\n========== single-asset adds (tp=2.5%) ==========`);
    const singles: Array<{ label: string; binance: string; r: Result }> = [];
    for (const { binance, label } of CANDIDATES) {
      if (!data[binance] || data[binance].length < 5000) {
        log(
          `  skip ${label} (insufficient data ${data[binance]?.length ?? 0})`,
        );
        continue;
      }
      const trial: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
        assets: [
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM.assets,
          makeAsset(binance, label, 0.025),
        ],
      };
      const r = evaluate(`+${label}`, trial, data);
      log(fmt(r));
      singles.push({ label, binance, r });
    }

    log(`\n========== GREEDY STACK (optimize step=1d) ==========`);
    const helpers = singles
      .filter((s) => s.r.pass1 > baseR.pass1 && s.r.med3 <= 4)
      .sort((a, b) => b.r.pass1 - a.r.pass1);
    log(
      `Helpers: ${helpers.map((h) => `${h.label}(${(h.r.pass1 * 100).toFixed(2)}%)`).join(", ")}`,
    );

    let stacked = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM;
    let stackedR = baseR;
    for (const h of helpers) {
      const trial: FtmoDaytrade24hConfig = {
        ...stacked,
        assets: [...stacked.assets, makeAsset(h.binance, h.label, 0.025)],
      };
      const r = evaluate(
        `stack(${stacked.assets.length + 1}): +${h.label}`,
        trial,
        data,
      );
      log(fmt(r));
      if (r.pass1 > stackedR.pass1 && r.med3 <= 4) {
        stacked = trial;
        stackedR = r;
        log(`  ✓ kept`);
      } else {
        log(`  ✗ dropped`);
      }
    }

    log(`\n========== FINAL ==========`);
    log(fmt(stackedR));
    log(`Asset list: ${stacked.assets.map((a) => a.symbol).join(", ")}`);
    log(
      `vs V5_TITANIUM: 1d=+${((stackedR.pass1 - baseR.pass1) * 100).toFixed(2)}pp / 3d=+${((stackedR.pass3 - baseR.pass3) * 100).toFixed(2)}pp`,
    );

    writeFileSync(
      `${LOG_DIR}/V5_TITANIUM_PHASE_P_${STAMP}.json`,
      JSON.stringify(
        {
          baseline: baseR,
          singles: singles.map((s) => ({ label: s.label, ...s.r })),
          finalAssets: stacked.assets.map((a) => ({
            symbol: a.symbol,
            sourceSymbol: a.sourceSymbol,
            tpPct: a.tpPct,
          })),
          finalResult: stackedR,
        },
        null,
        2,
      ),
    );

    expect(stackedR.pass1).toBeGreaterThanOrEqual(baseR.pass1);
  });
});
