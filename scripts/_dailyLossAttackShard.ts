/**
 * Daily-Loss-Attack sweep — Round 66.
 *
 * Attacks the ~31% of R28_V6_PASSLOCK fail-windows that fail with reason
 * "daily_loss". Sweeps two engine params NOT blocked by liveCaps:
 *
 *   dailyPeakTrailingStop.trailDistance ∈ {0.008, 0.010, 0.012, 0.015, 0.018}
 *   peakDrawdownThrottle ∈ {none, 0.03/0.3, 0.04/0.2, 0.04/0.15}
 *
 * Total 5×4=20 configs/window. R28_V6_PASSLOCK base = 0.012/none.
 *
 * Output JSONL row per (window, trail, throttle):
 *   { win_idx, trail, pdt_from, pdt_factor, passed, eq, reason }
 *
 * Usage: npx tsx scripts/_dailyLossAttackShard.ts [shard] [shardCount]
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import {
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
const OUT = `${CACHE_DIR}/daily_loss_attack_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT, "");

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

const TRAIL_DISTS = [0.008, 0.01, 0.012, 0.015, 0.018];
const PDT_VARIANTS = [
  { name: "none", from: null, factor: null },
  { name: "0.03/0.3", from: 0.03, factor: 0.3 },
  { name: "0.04/0.2", from: 0.04, factor: 0.2 },
  { name: "0.04/0.15", from: 0.04, factor: 0.15 },
];

function loadAligned() {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
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

function makeCfg(
  trail: number,
  pdt: (typeof PDT_VARIANTS)[number],
): FtmoDaytrade24hConfig {
  const cfg: FtmoDaytrade24hConfig = {
    ...FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
    dailyPeakTrailingStop: { trailDistance: trail },
  };
  if (pdt.from !== null && pdt.factor !== null) {
    cfg.peakDrawdownThrottle = { fromPeak: pdt.from, factor: pdt.factor };
  } else {
    cfg.peakDrawdownThrottle = undefined;
  }
  return cfg;
}

const { aligned, minBars } = loadAligned();
const cfgBase = FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;
const winBars = cfgBase.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

console.log(
  `[dl-attack ${SHARD_IDX}/${SHARD_COUNT}] ${TRAIL_DISTS.length}×${PDT_VARIANTS.length} = ${TRAIL_DISTS.length * PDT_VARIANTS.length} configs/window`,
);

let winIdx = 0;
const t0 = Date.now();
for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);

  for (const trail of TRAIL_DISTS) {
    for (const pdt of PDT_VARIANTS) {
      const cfg = makeCfg(trail, pdt);
      const r = simulate(
        trimmed,
        cfg,
        WARMUP,
        WARMUP + winBars,
        `DLA_${trail}_${pdt.name}`,
      );
      appendFileSync(
        OUT,
        JSON.stringify({
          win_idx: winIdx,
          trail,
          pdt: pdt.name,
          pdt_from: pdt.from,
          pdt_factor: pdt.factor,
          passed: r.passed,
          eq: r.finalEquityPct,
          reason: r.reason,
        }) + "\n",
      );
    }
  }
  if (winIdx % 5 === 0) {
    const t = Math.round((Date.now() - t0) / 1000);
    console.log(`  win ${winIdx}: 20 configs done, t+${t}s`);
  }
  winIdx++;
}

console.log(`[dl-attack ${SHARD_IDX}/${SHARD_COUNT}] DONE → ${OUT}`);
