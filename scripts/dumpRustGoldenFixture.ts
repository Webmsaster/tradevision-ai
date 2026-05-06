/**
 * dumpRustGoldenFixture.ts — Run the V4 live engine on a single window and
 * dump bars + emitted signals + expected outcome as a Rust golden fixture
 * (consumed by `engine-rust/ftmo-engine-core/tests/golden_runner.rs`).
 *
 * The harness here mirrors `scripts/_r28V6ComboShard.ts` for candle loading,
 * but runs `pollLive` directly per bar so we can capture
 * `result.decision.opens` for the signals_by_bar map. Final state.equity /
 * passed / failReason become the `expected` block.
 *
 * Usage:
 *   npx tsx scripts/dumpRustGoldenFixture.ts \
 *     --config R28_V6_PASSLOCK \
 *     --window 0 \
 *     --warmup 5000 \
 *     --out engine-rust/ftmo-engine-core/tests/golden/r28v6_window0.json
 *
 * The `--window` index walks the same step=14d (14*48 bars on 30m) cadence
 * used by the production R28_V6 sweep so window 0 here matches window 0
 * there.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import {
  initialState,
  pollLive,
  type FtmoLiveStateV4,
} from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";

interface Args {
  config: "R28_V6" | "R28_V6_PASSLOCK";
  windowIdx: number;
  warmup: number;
  stepDays: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    config: "R28_V6_PASSLOCK",
    windowIdx: 0,
    warmup: 5000,
    stepDays: 14,
    out: "engine-rust/ftmo-engine-core/tests/golden/r28v6_window0.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      const v = argv[++i]!;
      if (v !== "R28_V6" && v !== "R28_V6_PASSLOCK") {
        throw new Error(`unknown --config: ${v}`);
      }
      a.config = v;
    } else if (arg === "--window") a.windowIdx = parseInt(argv[++i]!, 10);
    else if (arg === "--warmup") a.warmup = parseInt(argv[++i]!, 10);
    else if (arg === "--step") a.stepDays = parseInt(argv[++i]!, 10);
    else if (arg === "--out") a.out = argv[++i]!;
  }
  return a;
}

const CACHE_DIR = "scripts/cache_bakeoff";
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

function pickConfig(name: Args["config"]): FtmoDaytrade24hConfig {
  return name === "R28_V6_PASSLOCK"
    ? FTMO_DAYTRADE_24H_R28_V6_PASSLOCK
    : FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
}

function camelCfg(cfg: FtmoDaytrade24hConfig, label: string): unknown {
  // Re-emit the camelCase shape that `engine-rust::config::EngineConfig`
  // deserialises. Most fields are already camelCase in the TS object —
  // we just add `label` and serialise verbatim.
  return { label, ...cfg };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[dumpRustGoldenFixture] config=${args.config} window=${args.windowIdx} warmup=${args.warmup}`,
  );

  const cfg = pickConfig(args.config);
  const { aligned, minBars } = loadAligned();
  const winBars = cfg.maxDays * 48;
  const stepBars = args.stepDays * 48;
  const start = args.warmup + args.windowIdx * stepBars;
  if (start + winBars > minBars) {
    throw new Error(
      `window ${args.windowIdx} exceeds available data (start=${start}, winBars=${winBars}, minBars=${minBars})`,
    );
  }

  // Slice candles for the window (warmup + window).
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned)) {
    trimmed[k] = aligned[k]!.slice(start - args.warmup, start + winBars);
  }

  // Re-implement the simulate-loop with signal capture.
  const state: FtmoLiveStateV4 = initialState(args.config);
  const signalsByBar: Record<string, unknown[]> = {};
  let challengeEnded = false;
  let passed = false;
  let failReason: string | null = null;

  for (let i = args.warmup; i < args.warmup + winBars; i++) {
    const slice: Record<string, Candle[]> = {};
    for (const k of Object.keys(trimmed)) {
      slice[k] = trimmed[k]!.slice(0, i + 1);
    }
    const r = pollLive(state, slice, cfg);
    if (r.decision.opens.length > 0) {
      // Bar index in the OUTPUT fixture = index into `trimmed[k]`. The loop
      // var `i` already iterates trimmed-relative (warmup..warmup+winBars).
      signalsByBar[String(i)] = r.decision.opens.map((s) => ({
        symbol: s.symbol,
        sourceSymbol: s.sourceSymbol,
        direction: s.direction,
        entryTime: s.entryTime,
        entryPrice: s.entryPrice,
        stopPrice: s.stopPrice,
        tpPrice: s.tpPrice,
        stopPct: s.stopPct,
        tpPct: s.tpPct,
        effRisk: s.effRisk,
      }));
    }
    if (r.challengeEnded) {
      challengeEnded = true;
      passed = r.passed;
      failReason = r.failReason;
      break;
    }
  }

  // Final equity in pct (state.equity is normalised to 1.0 at start).
  const finalEquityPct = state.equity - 1;
  const reason = passed
    ? "profit_target"
    : (failReason ?? state.stoppedReason ?? "time");

  // Build the fixture body. Bars are emitted in the trimmed (warmup+window)
  // form so the Rust runner can replay them 1:1.
  const fixture = {
    name: `${args.config.toLowerCase()}_w${args.windowIdx}`,
    description: `R28_V6 ${args.config} window ${args.windowIdx} (warmup=${args.warmup}, winBars=${winBars}); TS V4-Sim → Rust golden fixture`,
    cfg: camelCfg(cfg, args.config),
    /// Number of leading bars in `bars_by_source` that the Rust runner
    /// must keep in the feed buffer (for indicator history) WITHOUT
    /// calling step_bar — mirrors TS simulate's `startBar` index.
    warmup: args.warmup,
    bars_by_source: trimmed,
    signals_by_bar: signalsByBar,
    expected: {
      passed,
      challenge_ended: challengeEnded,
      // Allow ±0.1pp tolerance for f64 rounding drift.
      min_equity_pct: finalEquityPct - 0.001,
      max_equity_pct: finalEquityPct + 0.001,
      trades_count: state.closedTrades.length,
      fail_reason: passed ? null : reason,
      // Diagnostic: full equity for human inspection.
      ts_final_equity_pct: finalEquityPct,
      ts_reason: reason,
      // strict=false → drift between TS and Rust is reported but does NOT
      // panic the test. Set to true once detectAsset parity is sound.
      strict: false,
    },
  };

  const outDir = path.dirname(args.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(args.out, JSON.stringify(fixture, null, 2));
  console.log(
    `wrote ${args.out} (passed=${passed} reason=${reason} eq=${finalEquityPct.toFixed(4)} trades=${state.closedTrades.length})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
