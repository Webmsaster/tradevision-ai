# engine-rust performance notes

## Current state (post optimisation pass)

`step_bar` throughput on 2000-bar synthetic candle stream:

| Profile                | Before optimisations | After      | Speedup   |
| ---------------------- | -------------------- | ---------- | --------- |
| idle (no signals)      | 708 µs               | **220 µs** | **3.2×**  |
| breakout signals       | 728 µs               | **241 µs** | **3.0×**  |
| mean-reversion signals | 6370 µs              | **363 µs** | **17.5×** |

Two changes delivered the gains:

1. **`prague_offset_ms` allocation removal.** The original implementation
   called `format("%H").to_string()` on a chrono datetime twice per
   invocation, then parsed the resulting Strings back to integers. With
   `day_index` running ~3 times per bar, that's 6 String allocs per bar
   = ~12k allocs per 2000-bar window. Replaced with direct `.hour()`
   reads — zero allocations. Single biggest win across all profiles.

2. **RSI pre-cache for mean-reversion detector.** Original
   `detect_mean_reversion` recomputed the full RSI series O(N) per bar,
   making it O(N²) over a window. New `detect_mean_reversion_with_rsi`
   takes a pre-computed series and just reads two indices. 8× win on
   mean-reversion alone.

## Already in (Phase 1-7)

- mimalloc as global allocator on all binaries (`ftmo-engine`, `ftmo-bench`,
  `ftmo-sweep`, criterion bench harness). Marginal here (~1-2%) because
  the engine is not allocator-bound, but the dependency is wired.
- ATR pre-computation: bench / sweep / golden_runner / drift_summary all
  precompute once per window.
- Smallvec workspace dep wired (used in harness internals).
- `trim_inline` per step keeps state.kelly_pnls / closed_trades bounded.

## Likely-next wins (criterion-gated)

1. **`SmallVec<[PollSignal; 2]>` for `BarInput.signals`** — typical
   per-bar emission is 0-1 signals. Current Vec on every call has small
   alloc overhead. Internal-only refactor; should be safe.

2. **Pass `&[Candle]` instead of `&HashMap<String, Vec<Candle>>`** —
   would require BarInput type signature change and a CandleSource trait
   abstraction. Estimated 2× win on top of current state. Defer until
   after the obvious low-hanging fruit is exhausted.

3. **SIMD ATR / RSI via `wide` crate** — would help full-history Kelly
   and chandelier ATR recomputation. Diminishing returns now that
   pre-cache is done.

4. **Object pool for `ExitOutcome` / `PollSignal` allocations** — the
   `apply_exits` internal Vec gets reallocated per bar. SmallVec or a
   reusable scratch buffer would eliminate it.

## Run criterion to track progress

```bash
cd engine-rust && cargo bench --bench step_bar_throughput
```

Compare `target/criterion/step_bar_*/report/index.html` between commits.
