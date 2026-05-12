# Round 60 — Time-of-Day Gate Sweep on R28_V6

**Status: RUNNING** (results pending — final numbers will overwrite this skeleton)

## Hypothesis

Crypto trading has known low-liquidity hours (00-04 UTC = Asia early hours,
often choppy false breakouts). Filtering these may improve win-rate without
losing too many trades. Untested previously on R28_V6.

## Base Config

`FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6` — 56.62% V4-Engine
pass-rate (5.55y / 136 windows / 9-asset crypto basket).

Inherited `allowedHoursUtc: [4, 6, 8, 10, 14, 18, 22]` from V5_QUARTZ.

## Variants Tested

(Hours are intersected with the R28_V6 base set above.)

| Variant | Filter spec                      | Allowed UTC hours     | Allowed DOW (0=Sun..6=Sat) |
| ------- | -------------------------------- | --------------------- | -------------------------- |
| V0      | baseline (control)               | [4,6,8,10,14,18,22]   | all                        |
| V1      | skip 00-04 UTC (Asia early)      | [4,6,8,10,14,18,22]\* | all                        |
| V2      | skip 22-04 UTC (Asia all night)  | [6,8,10,14,18]        | all                        |
| V3      | only 08-22 UTC (London + NY)     | [8,10,14,18]          | all                        |
| V4      | only 12-20 UTC (NY core)         | [14,18]               | all                        |
| V5      | only Mon-Fri (skip weekend chop) | [4,6,8,10,14,18,22]   | [1,2,3,4,5]                |

\*V1 ≡ V0: R28_V6 baseline already excludes 00-03 UTC. V1 retained for parity
with the brief.

## Results

(Filled in by `_r28V7TodGateAggregate.ts`.)

| Variant | Windows | Passes | Pass-rate | Drift vs V0 | Med pass | p90 pass |
| ------- | ------- | ------ | --------- | ----------- | -------- | -------- |
| V0      | 136     | 77     | 56.62%    | (baseline)  | 4d       | 4d       |
| V1      | TBD     | TBD    | TBD       | TBD         | TBD      | TBD      |
| V2      | TBD     | TBD    | TBD       | TBD         | TBD      | TBD      |
| V3      | TBD     | TBD    | TBD       | TBD         | TBD      | TBD      |
| V4      | TBD     | TBD    | TBD       | TBD         | TBD      | TBD      |
| V5      | TBD     | TBD    | TBD       | TBD         | TBD      | TBD      |

## Verdict

(TBD — written after aggregation.)

## Files

- `scripts/_r28V7TodGateShard.ts` — sharded V4-Engine simulator runner
- `scripts/_r28V7TodGateAggregate.ts` — aggregator + pass-rate report
- `scripts/cache_bakeoff/r28v7_tod_V<N>_shard_<I>.jsonl` — per-window outputs
- `/tmp/r28v7_tod_v<N>_shard_<I>.log` — per-shard runtime logs
- `/tmp/r28v7_tod_progress.log` — orchestrator progress
- `/tmp/r28v7_tod_aggregate.log` — final aggregator stdout
