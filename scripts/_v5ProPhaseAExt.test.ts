/**
 * Phase A-Extended — try adding MORE assets on top of V5_PRO (10 assets).
 * V5_PRO already added AAVE + XRP - LINK. Maybe ETC, DOT, ALGO, TRX or others
 * help additionally.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_PRO_PHASE_A_EXT_${STAMP}.log`;

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
}
function normalize(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.timeframe = "2h";
  c.profitTarget = 0.08;
  c.maxDailyLoss = 0.05;
  c.maxTotalLoss = 0.1;
  c.minTradingDays = 4;
  c.maxDays = 30;
  c.pauseAtTargetReached = true;
  c.liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
  return c;
}
function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
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
  passRate: number;
  passes: number;
  windows: number;
  tl: number;
  dl: number;
  med: number;
  p90: number;
  winrate: number;
}

function evaluate(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
): Result {
  const c = normalize(cfg);
  const symbols = syms(c);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = c.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0,
    totalTrades = 0,
    totalWins = 0;
  const days: number[] = [];
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, c);
    windows++;
    if (res.passed) {
      passes++;
      days.push(res.passDay ?? 0);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
    for (const t of res.trades) {
      totalTrades++;
      if (t.effPnl > 0) totalWins++;
    }
  }
  days.sort((a, b) => a - b);
  return {
    name,
    passRate: passes / windows,
    passes,
    windows,
    tl,
    dl,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    winrate: totalTrades > 0 ? totalWins / totalTrades : 0,
  };
}
function fmt(r: Result): string {
  return `${r.name.padEnd(40)} pass=${(r.passRate * 100).toFixed(2).padStart(6)}% (${r.passes}/${r.windows}) wr=${(r.winrate * 100).toFixed(2).padStart(6)}% med=${String(r.med).padStart(2)}d p90=${String(r.p90).padStart(2)}d TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)}`;
}

function makeAsset(
  srcSym: string,
  label: string,
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
    tpPct: 0.04,
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
  { binance: "ETCUSDT", label: "ETC-TREND" },
  { binance: "ALGOUSDT", label: "ALGO-TREND" },
  { binance: "ICPUSDT", label: "ICP-TREND" },
  { binance: "NEARUSDT", label: "NEAR-TREND" },
  { binance: "SANDUSDT", label: "SAND-TREND" },
  { binance: "MANAUSDT", label: "MANA-TREND" },
  { binance: "INJUSDT", label: "INJ-TREND" },
  { binance: "RUNEUSDT", label: "RUNE-TREND" },
  { binance: "GALAUSDT", label: "GALA-TREND" },
  { binance: "SUIUSDT", label: "SUI-TREND" },
  { binance: "OPUSDT", label: "OP-TREND" },
  { binance: "ARBUSDT", label: "ARB-TREND" },
  { binance: "LDOUSDT", label: "LDO-TREND" },
  { binance: "FETUSDT", label: "FET-TREND" },
];

describe("V5_PRO Phase A-Ext", { timeout: 6 * 3600_000 }, () => {
  it("greedy add MORE assets to V5_PRO", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_PRO_PHASE_A_EXT START ${new Date().toISOString()}\n`,
    );

    const baseSyms = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO);
    const allSyms = [
      ...new Set([...baseSyms, ...CANDIDATES.map((c) => c.binance)]),
    ].sort();

    log(`\nLoading 2h candles for ${allSyms.length} symbols...`);
    const data: Record<string, Candle[]> = {};
    for (const s of allSyms) {
      try {
        const raw = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
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
      "V5_PRO baseline",
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
      data,
    );
    log(fmt(baseR));

    log(`\n========== single-asset adds ==========`);
    const singles: Array<{ label: string; binance: string; r: Result }> = [];
    for (const { binance, label } of CANDIDATES) {
      if (!data[binance] || data[binance].length < 5000) {
        log(`  skip ${label} (insufficient data)`);
        continue;
      }
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
        assets: [
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO.assets,
          makeAsset(binance, label),
        ],
      };
      const r = evaluate(`+${label}`, cfg, data);
      log(fmt(r));
      singles.push({ label, binance, r });
    }

    log(`\n========== GREEDY STACK ==========`);
    const helpers = singles
      .filter((s) => s.r.passRate > baseR.passRate && s.r.med <= 4)
      .sort((a, b) => b.r.passRate - a.r.passRate);
    log(`Helpers (sorted by pass): ${helpers.map((h) => h.label).join(", ")}`);

    let stacked = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO;
    let stackedR = baseR;
    for (const h of helpers) {
      const trial: FtmoDaytrade24hConfig = {
        ...stacked,
        assets: [...stacked.assets, makeAsset(h.binance, h.label)],
      };
      const r = evaluate(
        `stack(${stacked.assets.length + 1}): +${h.label}`,
        trial,
        data,
      );
      log(fmt(r));
      if (r.passRate > stackedR.passRate && r.med <= 4) {
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
      `vs V5_PRO baseline: ${(stackedR.passRate * 100).toFixed(2)}% vs ${(baseR.passRate * 100).toFixed(2)}% = +${((stackedR.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    writeFileSync(
      `${LOG_DIR}/V5_PRO_PHASE_A_EXT_${STAMP}.json`,
      JSON.stringify(
        {
          baseline: baseR,
          singles: singles.map((s) => ({ label: s.label, ...s.r })),
          finalAssets: stacked.assets.map((a) => ({
            symbol: a.symbol,
            sourceSymbol: a.sourceSymbol,
          })),
          finalResult: stackedR,
        },
        null,
        2,
      ),
    );

    expect(stackedR.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
