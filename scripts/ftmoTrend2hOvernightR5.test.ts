/**
 * OVERNIGHT R5 — cross-asset filters + extra gates + filter combo
 *
 * V: BTC-as-secondary cross-asset filter (longs only when BTC uptrend)
 * W: SPY/Total-market proxy (multiple secondaries)
 * X: crossAssetFiltersExtra stacking
 * Y: filter sweep on combined config
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import {
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";

const TF_HOURS = 2;
const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R5_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

interface BatchResult {
  windows: number;
  passes: number;
  passRate: number;
  medianDays: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
  ev: number;
}

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  stepDays = 3,
): BatchResult {
  const winBars = 30 * BARS_PER_DAY;
  const stepBars = stepDays * BARS_PER_DAY;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  for (const r of out)
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: pick(0.5),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
}

function fmt(label: string, r: BatchResult) {
  return `${label.padEnd(40)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

function score(a: BatchResult, b: BatchResult) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

const ASSET_SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];

describe(
  "Overnight R5 — cross-asset filters",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R5", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `OVERNIGHT R5 START ${new Date().toISOString()}\n`,
      );

      log(`Loading 2h data...`);
      const data: Record<string, Candle[]> = {};
      for (const s of ASSET_SOURCES) {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        log(`  ${s}: ${data[s].length} bars`);
      }
      const n = Math.min(...Object.values(data).map((c) => c.length));
      for (const s of ASSET_SOURCES) data[s] = data[s].slice(-n);
      log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

      const order = [
        "R4_FINAL_CONFIG.json",
        "R3_FINAL_CONFIG.json",
        "R2_FINAL_CONFIG.json",
        "R1_FINAL_CONFIG.json",
      ];
      let cur: FtmoDaytrade24hConfig = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5;
      for (const f of order) {
        const p = `${LOG_DIR}/${f}`;
        if (existsSync(p)) {
          cur = JSON.parse(readFileSync(p, "utf-8"));
          log(`Loaded base from ${f}`);
          break;
        }
      }
      const baseR = runWalkForward(data, cur);
      log(fmt("R5 BASELINE", baseR));

      // V: BTC as secondary, skipLongsIfSecondaryDowntrend
      log(`\n--- V: BTC cross-asset (skipLongs if BTC down) ---`);
      let vBest = { cfg: cur, r: baseR, label: "off" };
      for (const fast of [4, 8, 12, 24]) {
        for (const slow of [12, 24, 48, 96, 168]) {
          if (slow <= fast) continue;
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            crossAssetFilter: {
              symbol: "BTCUSDT",
              emaFastPeriod: fast,
              emaSlowPeriod: slow,
              skipLongsIfSecondaryDowntrend: true,
            },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, vBest.r) < 0) {
            vBest = { cfg, r, label: `BTC f=${fast} s=${slow}` };
            log(fmt(`  ${vBest.label}`, r));
          }
        }
      }
      log(fmt(`V WINNER (${vBest.label})`, vBest.r));
      cur = vBest.cfg;

      // W: BTC + momentum gate
      log(`\n--- W: BTC + momentum ---`);
      let wBest = { cfg: cur, r: vBest.r, label: "current" };
      if (cur.crossAssetFilter) {
        for (const mb of [4, 6, 8, 12, 24]) {
          for (const ml of [-0.05, -0.03, -0.02, -0.01, 0]) {
            const cfg: FtmoDaytrade24hConfig = {
              ...cur,
              crossAssetFilter: {
                ...cur.crossAssetFilter,
                momentumBars: mb,
                momSkipLongBelow: ml,
              },
            };
            const r = runWalkForward(data, cfg);
            if (score(r, wBest.r) < 0) {
              wBest = { cfg, r, label: `mom mb=${mb} ml=${ml}` };
              log(fmt(`  ${wBest.label}`, r));
            }
          }
        }
      }
      log(fmt(`W WINNER (${wBest.label})`, wBest.r));
      cur = wBest.cfg;

      // X: secondary BTC dominance check via ETH cross-asset extra
      log(`\n--- X: ETH crossAssetExtra ---`);
      let xBest = { cfg: cur, r: wBest.r, label: "off" };
      for (const fast of [8, 12, 24]) {
        for (const slow of [24, 48, 96]) {
          if (slow <= fast) continue;
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            crossAssetFiltersExtra: [
              {
                symbol: "ETHUSDT",
                emaFastPeriod: fast,
                emaSlowPeriod: slow,
                skipLongsIfSecondaryDowntrend: true,
              },
            ],
          };
          const r = runWalkForward(data, cfg);
          if (score(r, xBest.r) < 0) {
            xBest = { cfg, r, label: `ETH f=${fast} s=${slow}` };
            log(fmt(`  ${xBest.label}`, r));
          }
        }
      }
      log(fmt(`X WINNER (${xBest.label})`, xBest.r));
      cur = xBest.cfg;

      // Y: combined filter sweep (re-tune ADX/HTF after CAF)
      log(`\n--- Y: re-tune ADX after CAF ---`);
      let yBest = { cfg: cur, r: xBest.r, label: "current" };
      for (const period of [8, 10, 14, 20]) {
        for (const minAdx of [8, 10, 12, 15, 20]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            adxFilter: { period, minAdx },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, yBest.r) < 0) {
            yBest = { cfg, r, label: `adx p=${period} m=${minAdx}` };
            log(fmt(`  ${yBest.label}`, r));
          }
        }
      }
      log(fmt(`Y WINNER (${yBest.label})`, yBest.r));
      cur = yBest.cfg;

      log(`\n========== R5 FINAL ==========`);
      log(fmt("R5 baseline", baseR));
      log(fmt("After V (BTC CAF)", vBest.r));
      log(fmt("After W (mom)", wBest.r));
      log(fmt("After X (ETH extra)", xBest.r));
      log(fmt("After Y (re-ADX)", yBest.r));
      log(
        `\nΔ baseline → R5: +${((yBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
      );

      writeFileSync(
        `${LOG_DIR}/R5_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );

      expect(yBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
    });
  },
);
