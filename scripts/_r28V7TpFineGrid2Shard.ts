/**
 * R28_V7 TP Fine-Grid v2 — sharded runner (Round 60, post-R56-58 honesty).
 *
 * Re-validates the tpMult plateau under the FIXED engine (R57 Day-30 force-close,
 * R56 funding-cost, R58 atomic Lua) to find the new optimum. Round 53 found the
 * plateau at 0.55-0.59 (then 60.29% pre-R56). Post-fixes, R28_V6 ×0.55 dropped
 * to 56.62%, so we re-sweep tpMult ∈ {0.35, 0.40, 0.45, 0.48, 0.50, 0.52, 0.55,
 * 0.58, 0.60, 0.65, 0.70} to find any tpMult ≥ 58%.
 *
 * Args:
 *   process.argv[2] = SHARD_IDX     (0-based)
 *   process.argv[3] = SHARD_COUNT   (e.g. 8)
 *   process.argv[4] = TP_MULT       (float, e.g. "0.50")
 *
 * Output:
 *   /tmp/r28v7_tpfg2_tp{multX100}_shard_{idx}.jsonl  (one line per window)
 *   /tmp/r28v7_tpfg2_tp{multX100}_shard_{idx}.log    (stdout copy)
 *
 * Uses R28_V6 base config but overrides per-asset tpPct = baseTp(R28_V4) × tpMult.
 * R28_V4 is the unmultiplied source (R28_V6 = R28_V4 × 0.55).
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "8", 10);
const TP_MULT = parseFloat(process.argv[4] ?? "0.55");
const TAG = `tp${Math.round(TP_MULT * 100)
  .toString()
  .padStart(2, "0")}`;
const OUT_FILE = `/tmp/r28v7_tpfg2_${TAG}_shard_${SHARD_IDX}.jsonl`;
const LOG_FILE = `/tmp/r28v7_tpfg2_${TAG}_shard_${SHARD_IDX}.log`;
writeFileSync(OUT_FILE, "");
writeFileSync(LOG_FILE, "");

function plog(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
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

// Build a config: same as R28_V6 but with per-asset tpPct = baseV4 × TP_MULT.
const baseV4 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
const baseV6 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
const cfg: FtmoDaytrade24hConfig = {
  ...baseV6,
  assets: baseV4.assets.map((a) => ({
    ...a,
    tpPct: (a.tpPct ?? 0.05) * TP_MULT,
  })),
  liveCaps: baseV6.liveCaps ?? { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  partialTakeProfit: baseV6.partialTakeProfit ?? {
    triggerPct: 0.012,
    closeFraction: 0.7,
  },
};

const { aligned, minBars } = loadAligned();
const winBars = cfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

plog(
  `[shard ${SHARD_IDX}/${SHARD_COUNT} tpMult=${TP_MULT}] setup: ${SYMBOLS.length} syms, minBars=${minBars}, winBars=${winBars}, stepBars=${stepBars}`,
);

let winIdx = 0;
let myCount = 0;
let myPasses = 0;
const t0 = Date.now();
for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
  const r = simulate(
    trimmed,
    cfg,
    WARMUP,
    WARMUP + winBars,
    `R28V7_TPFG2_${TAG}`,
  );
  const out = {
    winIdx,
    tpMult: TP_MULT,
    passed: r.passed,
    reason: r.reason,
    passDay: r.passDay ?? null,
    finalEquityPct: r.finalEquityPct,
    tradeCount: r.trades.length,
  };
  appendFileSync(OUT_FILE, JSON.stringify(out) + "\n");
  myCount++;
  if (r.passed) myPasses++;
  plog(
    `[shard ${SHARD_IDX}/${SHARD_COUNT} ${TAG}] win=${winIdx} passed=${r.passed} reason=${r.reason} eq=${r.finalEquityPct.toFixed(4)} trades=${r.trades.length} t+${Math.round((Date.now() - t0) / 1000)}s (${myPasses}/${myCount} so far)`,
  );
  winIdx++;
}
plog(
  `[shard ${SHARD_IDX}/${SHARD_COUNT} ${TAG}] DONE in ${Math.round((Date.now() - t0) / 1000)}s — ${myPasses}/${myCount} passes`,
);
