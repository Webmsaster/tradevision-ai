# engine-rust performance notes

Phase 8 of the roadmap (zero-copy slices + SmallVec adoption) is partially
landed. The dependency is wired (`smallvec` workspace dep) so future
adoptions don't require Cargo changes. Concrete optimisation work is
**deferred until criterion benchmarks identify real hotspots** — premature
SmallVec / lifetime gymnastics for hand-waved gains is the wrong order.

## Already in (Phase 1-7)

- Pre-allocation: bench/sweep call `Vec::with_capacity(hi - lo)` for
  per-window feed buffers.
- `trim_inline` runs every step_bar so `state.kelly_pnls` /
  `state.closed_trades` stay bounded.
- `chrono-tz` Prague-offset is computed via `Intl`-style lookup once per
  bar (not per-position).

## Measured (rough)

- `target/release/ftmo-bench --signals breakout`: ~2-4M bars/sec on 8 threads
- `target/release/ftmo-bench --signals none`: ~8M bars/sec on 8 threads
- `target/release/ftmo-sweep --signals breakout`: ~3M bars/sec; ~1ms per
  300-bar window

## Likely-next wins (criterion will confirm)

1. **Pass `&[Candle]` instead of `&HashMap<String, Vec<Candle>>`** —
   touching BarInput type signature breaks all callers, so should be done
   together with a CandleSource trait abstraction. Estimated win 2-5×.
2. **`SmallVec<[PollSignal; 2]>` for `BarInput.signals`** — typical
   per-bar emission is 0-1 signals. Same as (1), needs API plumbing.
3. **`SmallVec<[(usize, ExitOutcome); 4]>` for internal apply_exits**
   buffers. Internal-only; safe to land first. Estimated 5-10% win.
4. **Replace `BTreeMap` in `engine::run_window` with `HashMap`** for
   non-deterministic-key but faster-lookup paths.
5. **Vectorise ATR / RSI computation** with `wide` SIMD crate. Likely
   20-40% on indicator-heavy detectors.

Run criterion to baseline before optimising:

```bash
cd engine-rust && cargo bench --bench step_bar_throughput
```

Compare `target/criterion/step_bar_*/report/index.html` between baseline
and optimised commits.
