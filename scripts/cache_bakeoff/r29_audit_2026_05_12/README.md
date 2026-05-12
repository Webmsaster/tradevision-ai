# R29 Audit Snapshots — 2026-05-12

Ephemeral `/tmp/` snapshots persisted here so they survive reboot. Generated during the 2026-05-12 deep-scan / cache-staleness audit on branch `feature/r28-deploy` with Rust commit `9fb066f` (or newer) and TS engine post-R9 `46d9bb3`.

## Purpose

These files are **evidence artifacts** for three findings:

1. **Cache-staleness debunk** — fresh Rust runs (NOPHANTOM) disagree with cached `scripts/cache_bakeoff/*.jsonl` claims. Honest pass-rates are materially lower than the memory headlines.
2. **Phantom-suppress drift** — toggling `phantom-suppress` shifts R28_V6_PASSLOCK from 41.18% → 32.35% on the same windowing. The phantom-suppress code path is not behaviour-preserving; it silently drops would-be passes.
3. **AMBER champion confirm** — independent Rust re-run reproduces AMBER PASSLOCK at 55.79% step=1, supporting its sister-champion status.

## File Index

| File | Engine | Config | Windowing | Pass-Rate | Role |
|------|--------|--------|-----------|-----------|------|
| `rust_r28v6_passlock_step14_NOPHANTOM.jsonl` | Rust `9fb066f`+ | R28_V6_PASSLOCK | step=14d, full 5.55y, no phantom-suppress | **41.18%** | Honest baseline (vs memory 55.88% claim) |
| `rust_r28v6_passlock_step14.jsonl` | Rust `9fb066f`+ | R28_V6_PASSLOCK | step=14d, full 5.55y, **WITH** phantom-suppress | **32.35%** | Bug evidence — phantom-suppress drops -8.83pp |
| `rust_titanium_passlock_step1_NOPHANTOM.jsonl` | Rust `9fb066f`+ | V5_TITANIUM_PASSLOCK (14 assets, 5.52y) | step=1d, 1985 windows, no phantom-suppress | **49.54%** | TITANIUM sister re-baseline (vs memory 58.24%) |
| `rust_amber_passlock_step1_NOPHANTOM.jsonl` | Rust `9fb066f`+ | V5_AMBER_PASSLOCK (14 assets, 3.04y) | step=1d, 1103 windows, no phantom-suppress | **55.79%** | AMBER champion confirm (vs memory 62.83%) |
| `ts_passlock_today_step14.jsonl` | TS V4-Engine post-R9 `46d9bb3` | R28_V6_PASSLOCK | step=14d, partial 38 windows | **36.84%** | TS-parity check vs Rust 41.18% — drift -4.34pp |
| `ts_passlock_today_step14_resume.jsonl` | TS V4-Engine post-R9 `46d9bb3` | R28_V6_PASSLOCK | step=14d, resume run (background, ~30min) | running | Will replace partial when finished; copy current state |
| `ts_win3_trades.jsonl` | TS | R28_V6_PASSLOCK | winIdx=3, trade-level dump | n/a | Audit detail for cross-engine trade-by-trade comparison |
| `ts_win5_trades.jsonl` | TS | R28_V6_PASSLOCK | winIdx=5, trade-level dump | n/a | Pairs with `rust_win5_trades.jsonl` (engine drift forensics) |
| `ts_win17_trades.jsonl` | TS | R28_V6_PASSLOCK | winIdx=17, trade-level dump | n/a | Audit detail |
| `ts_win23_trades.jsonl` | TS | R28_V6_PASSLOCK | winIdx=23, trade-level dump | n/a | Audit detail |
| `rust_win5_trades.jsonl` | Rust `9fb066f`+ | R28_V6_PASSLOCK | winIdx=5, trade-level dump | n/a | Rust counterpart of `ts_win5_trades.jsonl` |

## Key Numbers (post-R29 honest cross-check)

- R28_V6_PASSLOCK step=14 NOPHANTOM: **Rust 41.18% vs TS-partial 36.84%** (vs memory headline 55.88%).
- Phantom-suppress delta on R28_V6_PASSLOCK step=14: **-8.83pp** (41.18% → 32.35%).
- V5_TITANIUM_PASSLOCK step=1 NOPHANTOM: **49.54%** (vs memory 58.24%).
- V5_AMBER_PASSLOCK step=1 NOPHANTOM: **55.79%** (vs memory 62.83%).

All three configs are below their cached headline numbers, suggesting either (a) cache-staleness from earlier engine bugs or (b) phantom-suppress / windowing differences that were not honest. Multi-account stack math must be recomputed from these honest baselines.

## Reproduction

Rust engine binary at `rust-engine/` (commit `9fb066f` or newer). Run flags:
```
--no-phantom-suppress --step=<1|14> --config=<R28_V6_PASSLOCK|V5_TITANIUM_PASSLOCK|V5_AMBER_PASSLOCK>
```
TS engine via `scripts/_r28V6Shard.ts` × 8 parallel (post-R9 `46d9bb3` gap-fix engine).

## Status

Snapshots only — do NOT treat these as the final 2026-05-12 audit numbers until the TS resume run completes and is committed alongside the deep-scan summary.
