# Stack-4 Deep-Engine Refactor — Implementation Plan

**Status:** Plan-only. Foundational module `multi_account_state.rs` created
but unwired. Full integration deferred to a dedicated sprint (estimated
3-5 focused days).

**Why this is its own sprint:** the current single-account `EngineState`
is referenced by ~30 modules (harness, exit, pnl, reconcile, sweep, hunter,
PASSLOCK, mutex, regime-flip). A naive find-replace would touch ~150
call-sites and break all 451 unit tests without a parallel test-suite
re-baseline. Splitting the refactor into the 6 steps below keeps each
commit shippable.

## Goal

A single `ftmo-sweep` invocation can run 4 independent stacks (AMBER +
RUBIN + TITANIUM + BIDIR) against the SAME candle/funding feeds, with:

- per-account `equity`, `day_peak`, `day_start`, `open_positions`,
  `closed_trades`, `paused_at_target`, `consec_stops_paused`
- per-account `daily_loss_floor` / `total_loss_floor` checks (one breach
  doesn't kill all 4 accounts)
- per-account PASSLOCK / mutex / regime-flip evaluation
- shared candle/atr/funding/cross-asset feeds (no copy)
- one consolidated `BarStepResult` per bar listing per-account decisions

Net win: 4 stacks on shared data = ~4× wall-clock savings per sweep,
correct independence (no false collisions), enables Step-2-only stacks
on FundingPips while Step-1 runs on FTMO.

## Steps (in order)

### Step 1 — Foundational types (THIS COMMIT)

- `engine-rust/ftmo-engine-core/src/multi_account_state.rs` — new module
  with `MultiAccountState` wrapper around `Vec<EngineState>` keyed by
  `account_id: String`. Includes `get`, `get_mut`, `each_mut` helpers.
- `engine-rust/ftmo-engine-core/src/lib.rs` — `pub mod multi_account_state;`
- 4 unit tests for the wrapper.
- **NOT WIRED into harness yet.** Existing single-account path unchanged.

### Step 2 — Per-account config (NEXT SPRINT)

- `AccountConfig { account_id: String, template: EngineConfig, magic_offset: u32 }`.
- `SweepConfig::accounts: Vec<AccountConfig>` (was single template).
- CLI flag `--account-config <file.json>` reads array of AccountConfig.
- Backward-compat: `--template <name>` still works → wraps in 1-element vec.
- Test: 1-element vec produces bit-identical sweep output vs old path.

### Step 3 — Harness multi-account step_bar

- New `step_bar_multi(states: &mut [EngineState], cfgs: &[EngineConfig],
input: &BarInput) -> Vec<BarStepResult>` running existing single-account
  step_bar in a loop. THIS IS NOT YET TRUE MULTI-ACCOUNT — just a parallel
  wrapper that ensures shared `input` is observed identically.
- Property test: for any sweep, `step_bar_multi(&[s], &[cfg], input)`
  equals `vec![step_bar(s, cfg, input)]`.

### Step 4 — Sweep loop + parallelism

- Rewrite `run_window` in `sweep.rs` to loop over accounts.
- Use `rayon::par_iter_mut` over accounts (independent state → safe).
- Aggregate per-account `final_equity`, `trades_count`, `passed` into a
  per-window per-account row. CSV/JSON output gets `account_id` column.
- Tests: 4-account run with identical configs == 4× the same single-account
  result (within tolerance).

### Step 5 — Live executor multi-stack support

- `tools/ftmo_executor.py`: per-stack `AccountState` already exists via
  `STATE_DIR`. NEW: `FTMO_STACK_CONFIG=<file.json>` enables multi-stack
  in a single process — one MT5 connection, N independent strategies.
  Magic disambiguation already in place (Wave2 fix: tf_offset in
  `_compute_magic_id`).
- Per-stack signal-history, per-stack passlock state, per-stack DL/TL
  checks. Operator can still run separate-process-per-stack (current
  ecosystem) as a fallback.

### Step 6 — Test parity sweep + cutover

- Replay last 6 months of live trades through both old single-account
  loop and new multi-account loop with N=1 → bit-identical results.
- Replay against N=4 stack → final equity = independent product
  of per-stack winrates (sanity check no cross-talk).
- Update CLAUDE.md → mark Step-6 complete, remove "deferred" from
  Stack-4 in MEMORY.md.

## Files Touched (estimate)

| Module                                                    | Step    | Risk   |
| --------------------------------------------------------- | ------- | ------ |
| `multi_account_state.rs` (NEW)                            | 1       | low    |
| `lib.rs`                                                  | 1       | low    |
| `config.rs` (add AccountConfig)                           | 2       | medium |
| `sweep.rs` (loop over accounts)                           | 2,4     | HIGH   |
| `harness.rs` (step_bar_multi wrapper)                     | 3       | medium |
| `pnl.rs` (no change — bar-level math is per-state)        | –       | –      |
| `exit.rs` (no change — per-position)                      | –       | –      |
| `reconcile.rs` (per-account file paths)                   | 5       | medium |
| `tools/ftmo_executor.py` (multi-stack mode)               | 5       | HIGH   |
| `tools/ecosystem*.config.js`                              | 5       | low    |
| Tests: 4 new unit + 1 property + 1 integration + 1 parity | 1,3,4,6 | –      |

## Dependencies & Risks

- **`rayon` already in workspace** (used by sweep). Per-account parallel
  iteration is straightforward.
- **`serde_json::from_str` for AccountConfig**: schema versioning needed
  (per the schema-migration audit pattern Wave2 added to ml_gate.rs).
- **PASSLOCK race across accounts**: per-account `paused_at_target` is
  independent — no shared global. Verify in Step-3 property test.
- **Live executor**: 4 stacks × 5 positions = 20 concurrent MT5 orders
  per bar. Validate `place_market_order` retry-loop (Wave2 batch 1 fix)
  scales — the 3-retry × 200ms backoff × 20 positions = ~4s worst case,
  inside the 30s poll budget but tight.

## Acceptance Criteria

- `cargo test -p ftmo-engine-core` shows ≥10 new tests for multi-account
  paths, all green.
- Single-account sweep output (CSV) bit-identical to pre-refactor (use
  fixed seed + replay).
- 4-stack sweep on shared data completes in ≤1.4× single-stack wall-clock
  (target: 4× shared work amortization).
- No regression in live executor: existing single-stack ecosystem
  configs continue to work without code changes (FTMO_STACK_CONFIG opt-in).

## Out-of-Scope (also deferred)

- Cross-account portfolio risk caps (combined DL across 4 accounts =
  "stop trading whole stack at -5% total"). The original Stack-4 design
  treats accounts as INDEPENDENT for survival probability, so a portfolio
  cap would reduce the math benefit. Add only if a future FTMO rule
  requires it.
- Cross-account correlation hedging (account A holds long, account B
  hedge-shorts). Out of scope — multi-strategy hedge would defeat the
  orthogonal-class purpose of the 4-stack.
