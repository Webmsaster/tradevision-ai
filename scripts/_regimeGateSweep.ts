/**
 * Regime-Detection-Gate sweep — measure pass-rate conditional on BTC regime.
 *
 * BTC regime classifier (matches ftmo_executor.py:classify_btc_regime):
 *   - Bull: BTC EMA(short) > EMA(long) AND price > both EMAs
 *   - Bear: opposite
 *   - Range: otherwise
 *
 * For each window of R28_V6_PASSLOCK:
 *   1. Classify BTC regime at challenge-start.
 *   2. Run simulation.
 *   3. Bucket pass/fail by regime.
 *
 * Output: per-regime pass-rate. If one regime is markedly worse → gate it
 * out (skip challenges started in that regime).
 *
 * Usage: npx tsx scripts/_regimeGateSweep.ts [shard] [shardCount]
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import {
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import { ema } from "../src/utils/indicators";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
const OUT = `${CACHE_DIR}/regime_gate_shard_${SHARD_IDX}.jsonl`;
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

type Regime = "bull" | "bear" | "range";

/**
 * Match Python executor's classify_btc_regime: EMA(short=24, long=120) on
 * BTC closes; bull if EMA-short > EMA-long AND last_close > EMA-long;
 * bear if mirror; else range.
 */
function btcRegime(btcCandles: Candle[], atIdx: number): Regime {
  const closes = btcCandles.slice(0, atIdx + 1).map((c) => c.close);
  if (closes.length < 200) return "range";
  const fast = ema(closes, 24);
  const slow = ema(closes, 120);
  const f = fast[atIdx];
  const s = slow[atIdx];
  if (f == null || s == null) return "range";
  const lastClose = closes[atIdx]!;
  if (f > s && lastClose > s) return "bull";
  if (f < s && lastClose < s) return "bear";
  return "range";
}

const { aligned, minBars } = loadAligned();
const cfg: FtmoDaytrade24hConfig = FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;
const winBars = cfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

console.log(
  `[regime ${SHARD_IDX}/${SHARD_COUNT}] R28_V6_PASSLOCK bucketed by BTC regime at challenge-start`,
);

let winIdx = 0;
const buckets: Record<
  Regime,
  { pass: number; total: number; equity: number[] }
> = {
  bull: { pass: 0, total: 0, equity: [] },
  bear: { pass: 0, total: 0, equity: [] },
  range: { pass: 0, total: 0, equity: [] },
};

for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }
  const regime = btcRegime(aligned["BTCUSDT"]!, start);
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned)) {
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
  }
  const r = simulate(
    trimmed,
    cfg,
    WARMUP,
    WARMUP + winBars,
    `R28_V6_${regime}`,
  );
  buckets[regime].total++;
  buckets[regime].equity.push(r.finalEquityPct);
  if (r.passed) buckets[regime].pass++;

  appendFileSync(
    OUT,
    JSON.stringify({
      win_idx: winIdx,
      regime,
      passed: r.passed,
      reason: r.reason,
      final_equity_pct: r.finalEquityPct,
    }) + "\n",
  );
  if (winIdx % 10 === 0) {
    console.log(
      `  win ${winIdx}: regime=${regime} passed=${r.passed} eq=${r.finalEquityPct.toFixed(4)}`,
    );
  }
  winIdx++;
}

const summary = {
  marker: "summary",
  bull: {
    n: buckets.bull.total,
    pass: buckets.bull.pass,
    pass_rate: buckets.bull.total ? buckets.bull.pass / buckets.bull.total : 0,
  },
  bear: {
    n: buckets.bear.total,
    pass: buckets.bear.pass,
    pass_rate: buckets.bear.total ? buckets.bear.pass / buckets.bear.total : 0,
  },
  range: {
    n: buckets.range.total,
    pass: buckets.range.pass,
    pass_rate: buckets.range.total
      ? buckets.range.pass / buckets.range.total
      : 0,
  },
};
appendFileSync(OUT, JSON.stringify(summary) + "\n");
console.log("\n=== Regime-conditional pass-rates ===");
for (const r of ["bull", "bear", "range"] as Regime[]) {
  const b = buckets[r];
  const pct = b.total ? (b.pass / b.total) * 100 : 0;
  console.log(`  ${r.padEnd(5)}: ${b.pass}/${b.total} = ${pct.toFixed(2)}%`);
}
console.log(`\n[regime ${SHARD_IDX}/${SHARD_COUNT}] DONE → ${OUT}`);
console.log(
  "Recommendation: gate-out the regime with > 5pp lower pass-rate vs others.",
);
