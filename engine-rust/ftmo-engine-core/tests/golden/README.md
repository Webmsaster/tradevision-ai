# Golden fixtures

JSON fixtures consumed by `golden_runner.rs`. Each fixture is a single
end-to-end scenario with a hand-defined `expected` outcome that the Rust
harness must reproduce.

## Schema

```jsonc
{
  "name": "fixture-id",
  "description": "human-readable",
  "cfg": EngineConfig,                          // camelCase JSON
  "bars_by_source": {
    "BTCUSDT": [Candle, ...]                    // each Candle = openTime/open/high/low/close/...
  },
  "signals_by_bar": {
    "<bar_index>": [PollSignal, ...]            // optional — externally supplied entries
  },
  "expected": {
    "passed": true | false,
    "challenge_ended": true | false,
    "min_equity_pct": 0.039,                    // both bounds optional, both inclusive
    "max_equity_pct": 0.041,
    "trades_count": 1,
    "fail_reason": "TotalLoss"                  // substring match on the Debug repr
  }
}
```

## Adding fixtures

### From a TS V4-Sim run (preferred)

The dump script lives at `scripts/dumpRustGoldenFixture.ts` (deferred — to
be implemented). Once present:

```
node scripts/dumpRustGoldenFixture.ts \
  --config R28_V6_PASSLOCK \
  --window 0 \
  --out engine-rust/ftmo-engine-core/tests/golden/r28_v6_window0.json
```

The script will run the TS V4 simulator on the chosen window, capture
`bars_by_source`, the emitted entry signals from `detectAsset`, and the
final `SimulateResult`, then write the fixture in the schema above with
the actual `passed` / `final_equity_pct` from the sim as the expected
outcome.

### By hand

For unit-style fixtures (small, deterministic, illustrative) — see
`passlock_minimal.json`.
