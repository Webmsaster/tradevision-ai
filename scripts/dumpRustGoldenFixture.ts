/**
 * dumpRustGoldenFixture.ts — Dump a V4-Sim run as a JSON golden fixture
 * consumable by `engine-rust/ftmo-engine-core/tests/golden_runner.rs`.
 *
 * Status: SKELETON — written alongside the Rust port to define the
 * dump-side contract. The TODOs below need wiring once the real V4-Sim
 * harness path is settled.
 *
 * Usage:
 *   npx tsx scripts/dumpRustGoldenFixture.ts \
 *     --config 2h-trend-v5-r28-v6-passlock \
 *     --window 0 \
 *     --out engine-rust/ftmo-engine-core/tests/golden/r28v6_window0.json
 *
 * Output schema (matches Rust `golden_runner::Fixture`):
 *   {
 *     "name": "...",
 *     "description": "...",
 *     "cfg": EngineConfig,                      // camelCase JSON, V4-canonical
 *     "bars_by_source": { "<symbol>": [Candle, ...] },
 *     "signals_by_bar": { "<bar_idx>": [PollSignal, ...] },
 *     "expected": {
 *       "passed": true|false,
 *       "challenge_ended": true|false,
 *       "min_equity_pct": ..., "max_equity_pct": ...,
 *       "trades_count": N,
 *       "fail_reason": "TotalLoss"|"DailyLoss"|"Time"|"FeedLost"|null
 *     }
 *   }
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface Args {
  config: string;
  windowIdx: number;
  out: string;
  // Allow ±tolerance% bands around the actual final_equity_pct so the
  // Rust runner doesn't false-alarm on f64 rounding drift.
  equityTolerance: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    config: "2h-trend-v5-r28-v6-passlock",
    windowIdx: 0,
    out: "engine-rust/ftmo-engine-core/tests/golden/dumped.json",
    equityTolerance: 0.001, // ±0.1pp on equity_pct
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") out.config = argv[++i]!;
    else if (a === "--window") out.windowIdx = parseInt(argv[++i]!, 10);
    else if (a === "--out") out.out = argv[++i]!;
    else if (a === "--tol") out.equityTolerance = parseFloat(argv[++i]!);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[dumpRustGoldenFixture] config=${args.config} window=${args.windowIdx} → ${args.out}`,
  );

  // TODO(rust-port): wire the actual V4-Sim run path here. Pseudocode:
  //
  //   const cfg = resolveCfgBySelector(args.config);
  //   const candles = await loadAlignedCandlesForWindow(cfg, args.windowIdx);
  //   const signalLog: Record<string, PollSignal[]> = {};
  //   const state = initialState(cfg.label);
  //   for (let i = 0; i < candles[firstSym].length; i++) {
  //     const slices = sliceAll(candles, i);
  //     const sigs = detectAsset(...);
  //     if (sigs.length) signalLog[String(i)] = sigs;
  //     pollLive(state, slices, cfg);
  //   }
  //   const result = endOfWindowResult(state);
  //
  // The real `simulate()` from `ftmoLiveEngineV4.ts` already returns a
  // SimulateResult with all required fields. We just need to dump the
  // input candles + emitted entry signals AND the expected result.

  const stub = {
    name: `${args.config}_w${args.windowIdx}`,
    description:
      "STUB — dump path not yet wired. Replace this file with a real dump once the TS V4-Sim hookup lands.",
    cfg: {
      label: "STUB",
      leverage: 2.0,
      tpPct: 0.04,
      stopPct: 0.02,
      holdBars: 24,
      profitTarget: 0.1,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      maxDays: 30,
      assets: [],
    },
    bars_by_source: {} as Record<string, unknown[]>,
    signals_by_bar: {} as Record<string, unknown[]>,
    expected: {
      passed: false,
      challenge_ended: false,
    },
    // Marker so the Rust runner can detect-and-skip stubs.
    __stub: true,
  };

  const outDir = path.dirname(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(stub, null, 2));
  console.log(`wrote stub to ${args.out}`);
  console.log(
    "Note: this is a placeholder. The real V4-Sim hookup needs to import simulate() " +
      "from src/utils/ftmoLiveEngineV4 and replace the stub block above.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
