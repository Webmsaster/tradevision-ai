/**
 * R28_V5 Fine-Tune — sweep TP multipliers around the 0.5 winner +
 * combined regime-gate variants.
 *
 * Variants:
 *   - tpMult ∈ {0.4, 0.5, 0.6, 0.7, 0.8} (find optimum)
 *   - tpMult=0.5 + regime-gate trend-down
 *   - tpMult=0.5 + regime-gate trend-down + high-vol
 *   - tpMult=0.5 + DROP worst asset (per-asset analysis)
 */
import { describe, it } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = "scripts/cache_bakeoff/r28v5_finetune.log";
writeFileSync(LOG_FILE, `[${new Date().toISOString()}] start\n`);
function plog(s: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`);
  console.log(s);
}

const SYMBOLS = [
  "AAVEUSDT",
  "ADAUSDT",
  "BCHUSDT",
  "BNBUSDT",
  "BTCUSDT",
  "ETCUSDT",
  "ETHUSDT",
  "LTCUSDT",
  "XRPUSDT",
];

function loadAligned(): { aligned: Record<string, Candle[]>; minBars: number } {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
  }
  const sets = SYMBOLS.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  return {
    aligned,
    minBars: Math.min(...SYMBOLS.map((s) => aligned[s]!.length)),
  };
}

type Regime = "trend-up" | "trend-down" | "chop" | "high-vol" | "calm";
function classifyAt(candles: Candle[], i: number): Regime {
  const lookback = 7 * 48;
  const slice = candles.slice(Math.max(0, i - lookback), i);
  if (slice.length < 100) return "chop";
  const trend =
    (slice[slice.length - 1]!.close - slice[0]!.close) / slice[0]!.close;
  const rets: number[] = [];
  for (let k = 1; k < slice.length; k++) {
    if (slice[k - 1]!.close > 0)
      rets.push(Math.log(slice[k]!.close / slice[k - 1]!.close));
  }
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v =
    rets.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, rets.length);
  const annualVol = Math.sqrt(v) * Math.sqrt(48 * 365);
  if (annualVol >= 0.6) return "high-vol";
  if (Math.abs(trend) <= 0.02 && annualVol < 0.15) return "calm";
  if (trend > 0.05) return "trend-up";
  if (trend < -0.05) return "trend-down";
  return "chop";
}

function makeTightCfg(
  tpMult: number,
  dropAsset?: string,
): FtmoDaytrade24hConfig {
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
  let assets = base.assets.map((a) => ({
    ...a,
    tpPct: (a.tpPct ?? 0.05) * tpMult,
  }));
  if (dropAsset) {
    assets = assets.filter((a) => (a.sourceSymbol ?? a.symbol) !== dropAsset);
  }
  return {
    ...base,
    assets,
    liveCaps: base.liveCaps ?? { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  };
}

interface Result {
  name: string;
  passes: number;
  windows: number;
  rate: number;
  med: number;
}

function run(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  minBars: number,
  regimeBlock?: Set<Regime>,
): Result {
  const winBars = cfg.maxDays * 48;
  const stepBars = 14 * 48;
  const WARMUP = 5000;
  let passes = 0,
    windows = 0;
  const passDays: number[] = [];
  const t0 = Date.now();
  for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
    if (
      regimeBlock?.size &&
      regimeBlock.has(classifyAt(aligned.BTCUSDT!, start))
    )
      continue;
    windows++;
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned))
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, name);
    if (r.passed) {
      passes++;
      if (r.passDay) passDays.push(r.passDay);
    }
  }
  passDays.sort((a, b) => a - b);
  const med =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const rate = (passes / windows) * 100;
  plog(
    `[done] ${name}: ${passes}/${windows} = ${rate.toFixed(2)}% / med=${med}d / ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return { name, passes, windows, rate, med };
}

describe("R28_V5 Fine-Tune", { timeout: 90 * 60_000 }, () => {
  it("sweeps tpMult + combined variants", () => {
    const { aligned, minBars } = loadAligned();
    plog(`[setup] ${SYMBOLS.length} syms, ${minBars} bars`);

    const results: Result[] = [];
    // 1. tpMult sweep
    for (const m of [0.4, 0.5, 0.6, 0.7, 0.8, 1.0]) {
      results.push(
        run(`tpMult=${m.toFixed(1)}`, makeTightCfg(m), aligned, minBars),
      );
    }
    // 2. tpMult=0.5 + regime-gate trend-down
    results.push(
      run(
        "tpMult=0.5 + regime[trend-down]",
        makeTightCfg(0.5),
        aligned,
        minBars,
        new Set<Regime>(["trend-down"]),
      ),
    );
    // 3. tpMult=0.5 + regime-gate trend-down + high-vol
    results.push(
      run(
        "tpMult=0.5 + regime[trend-down,high-vol]",
        makeTightCfg(0.5),
        aligned,
        minBars,
        new Set<Regime>(["trend-down", "high-vol"]),
      ),
    );
    // 4. tpMult=0.5 + drop worst asset (use ETC-TREND from prior sweep, or BCH)
    for (const dropSym of ["ETCUSDT", "BCHUSDT", "AAVEUSDT", "AVAXUSDT"]) {
      results.push(
        run(
          `tpMult=0.5 + drop ${dropSym}`,
          makeTightCfg(0.5, dropSym),
          aligned,
          minBars,
        ),
      );
    }

    plog("\n=== R28_V5 FINE-TUNE RANKING ===");
    plog("variant                              | pass% | med | windows");
    plog("-------------------------------------+-------+-----+--------");
    const sorted = [...results].sort((a, b) => b.rate - a.rate);
    for (const r of sorted) {
      plog(
        `${r.name.padEnd(36)} | ${r.rate.toFixed(2).padStart(5)} | ${String(r.med).padStart(3)} | ${String(r.windows).padStart(7)}`,
      );
    }
    const winner = sorted[0]!;
    plog(
      `\n>>> BEST: ${winner.name} → ${winner.rate.toFixed(2)}% / ${winner.med}d`,
    );
  });
});
