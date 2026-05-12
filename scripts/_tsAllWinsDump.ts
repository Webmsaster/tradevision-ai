// Run TS V4-Sim PASSLOCK over ALL 136 windows (step=14d, 60d window) and
// produce a fresh per-window jsonl to compare with both the stale cache
// 2026-05-05 (claimed 55.88% / 76 PASS) and the Rust dump (32.35% / 44 PASS).
import { FTMO_DAYTRADE_24H_R28_V6_PASSLOCK } from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const RESUME = process.env.TS_RESUME_FROM
  ? parseInt(process.env.TS_RESUME_FROM, 10)
  : 0;
const OUT = process.env.TS_OUT ?? "/tmp/ts_passlock_today_step14.jsonl";
if (RESUME === 0) writeFileSync(OUT, "");

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

const cfg = FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;
const { aligned, minBars } = loadAligned();
const winBars = cfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

let winIdx = 0;
let passed = 0;
let total = 0;
const t0 = Date.now();
for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (winIdx < RESUME) {
    winIdx++;
    continue;
  }
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
  const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, "TS_TODAY");
  total++;
  if (r.passed) passed++;
  const row = {
    winIdx,
    passed: r.passed,
    reason: r.reason,
    passDay: r.passDay ?? null,
    finalEquityPct: r.finalEquityPct,
    trades: r.trades.length,
  };
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  if (winIdx % 10 === 0) {
    process.stdout.write(
      `[${winIdx}] passed=${r.passed} reason=${r.reason} eq=${r.finalEquityPct.toFixed(4)} t+${Math.round((Date.now() - t0) / 1000)}s — running ${passed}/${total} = ${((passed / total) * 100).toFixed(2)}%\n`,
    );
  }
  winIdx++;
}
console.log(
  `TS-TODAY DONE: ${passed}/${total} = ${((passed / total) * 100).toFixed(2)}% in ${Math.round((Date.now() - t0) / 1000)}s`,
);
