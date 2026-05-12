/**
 * Multi-Strategy-Combo harness — measures joint pass-rate of running 3
 * configs in parallel on the same windows.
 *
 * Memory math (3-Strategy ≈ 94% min-1-pass) is computed assuming
 * INDEPENDENCE. This harness measures the ACTUAL correlation by running
 * R28_V6_PASSLOCK + V5_TITANIUM + V5_AMBER on identical windows and
 * counting min-1-pass per window.
 *
 * Output JSONL per window:
 *   { win_idx, passlock_passed, titanium_passed, amber_passed, any_pass }
 *
 * Aggregate:
 *   - Per-strategy pass-rate
 *   - Joint min-1-pass
 *   - Pairwise correlation (which 2 strategies fail together?)
 *
 * Usage: npx tsx scripts/_multiStrategyComboShard.ts [shard] [shardCount]
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import {
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
const OUT = `${CACHE_DIR}/multi_strategy_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT, "");

// Each strategy needs its own basket. Use the union of all symbols cached.
const ALL_SYMBOLS = [
  "AAVEUSDT",
  "ADAUSDT",
  "BCHUSDT",
  "BNBUSDT",
  "BTCUSDT",
  "ETCUSDT",
  "ETHUSDT",
  "LTCUSDT",
  "XRPUSDT",
  "SOLUSDT",
  "DOGEUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "RUNEUSDT",
];

function loadAligned(symbols: string[]) {
  const data: Record<string, Candle[]> = {};
  for (const s of symbols)
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
  const sets = symbols.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  return {
    aligned,
    minBars: Math.min(...symbols.map((s) => aligned[s]!.length)),
  };
}

const { aligned, minBars } = loadAligned(ALL_SYMBOLS);
const winBars = 30 * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

console.log(
  `[combo ${SHARD_IDX}/${SHARD_COUNT}] R28_V6_PASSLOCK + V5_TITANIUM + V5_AMBER joint pass-rate`,
);

let winIdx = 0;
const stats = { passlock: 0, titanium: 0, amber: 0, any: 0, all: 0, total: 0 };

function runStrat(
  cfg: FtmoDaytrade24hConfig,
  start: number,
  label: string,
): boolean {
  const winB = cfg.maxDays * 48;
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned)) {
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winB);
  }
  const r = simulate(trimmed, cfg, WARMUP, WARMUP + winB, label);
  return r.passed;
}

for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }
  const passlock = runStrat(
    FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
    start,
    "R28_V6_PASSLOCK",
  );
  const titanium = runStrat(
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
    start,
    "V5_TITANIUM",
  );
  const amber = runStrat(
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
    start,
    "V5_AMBER",
  );

  if (passlock) stats.passlock++;
  if (titanium) stats.titanium++;
  if (amber) stats.amber++;
  const any = passlock || titanium || amber;
  const all = passlock && titanium && amber;
  if (any) stats.any++;
  if (all) stats.all++;
  stats.total++;

  appendFileSync(
    OUT,
    JSON.stringify({
      win_idx: winIdx,
      passlock_passed: passlock,
      titanium_passed: titanium,
      amber_passed: amber,
      any_pass: any,
      all_pass: all,
    }) + "\n",
  );
  if (winIdx % 5 === 0) {
    console.log(
      `  win ${winIdx}: PL=${passlock ? "✓" : "✗"} TI=${titanium ? "✓" : "✗"} AM=${amber ? "✓" : "✗"} → any=${any ? "✓" : "✗"}`,
    );
  }
  winIdx++;
}

const summary = {
  marker: "summary",
  total: stats.total,
  passlock_pass_rate: stats.passlock / stats.total,
  titanium_pass_rate: stats.titanium / stats.total,
  amber_pass_rate: stats.amber / stats.total,
  any_pass_rate: stats.any / stats.total,
  all_pass_rate: stats.all / stats.total,
  // Theoretical independence: 1 - (1-p1)(1-p2)(1-p3)
  theoretical_any_indep:
    1 -
    (1 - stats.passlock / stats.total) *
      (1 - stats.titanium / stats.total) *
      (1 - stats.amber / stats.total),
};
appendFileSync(OUT, JSON.stringify(summary) + "\n");

console.log("\n=== Multi-Strategy Joint Pass-Rate ===");
console.log(
  `  PASSLOCK: ${stats.passlock}/${stats.total} = ${(summary.passlock_pass_rate * 100).toFixed(2)}%`,
);
console.log(
  `  TITANIUM: ${stats.titanium}/${stats.total} = ${(summary.titanium_pass_rate * 100).toFixed(2)}%`,
);
console.log(
  `  AMBER:    ${stats.amber}/${stats.total} = ${(summary.amber_pass_rate * 100).toFixed(2)}%`,
);
console.log(
  `  ANY pass:  ${stats.any}/${stats.total} = ${(summary.any_pass_rate * 100).toFixed(2)}%`,
);
console.log(
  `  ALL pass:  ${stats.all}/${stats.total} = ${(summary.all_pass_rate * 100).toFixed(2)}%`,
);
console.log(
  `  Theoretical (independence): ${(summary.theoretical_any_indep * 100).toFixed(2)}%`,
);
console.log(
  `  Observed-vs-indep gap: ${((summary.any_pass_rate - summary.theoretical_any_indep) * 100).toFixed(2)}pp`,
);
console.log(
  `\n  → If observed >> indep: strategies are anti-correlated (great).`,
);
console.log(`  → If observed ~ indep: strategies are roughly independent.`);
console.log(
  `  → If observed << indep: strategies are correlated (bad — same windows fail).`,
);
console.log(`\n[combo ${SHARD_IDX}/${SHARD_COUNT}] DONE → ${OUT}`);
