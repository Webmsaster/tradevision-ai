# V12_30M_OPT_STOCK Monte-Carlo Bootstrap

- Source: `scripts/cache_bakeoff/r29_iterV12_stock_shard_{0..7}.jsonl`
- N windows: **140**
- Bootstraps: 10000, seed=42

## Headline

- **Point estimate**: 77.14%
- Bootstrap mean: 77.09%
- StdDev: 3.57pp
- 95% CI: [70.00%, 83.57%]
- 99% CI: [67.86%, 85.71%]
- P(rate > 65%) live-target: **100.0%**
- P(rate > 70%) overshoot: 96.8%
- P(rate < 55%) downside: 0.0%

## Final equity %

- P10: -6.86%
- P50 (median): 11.44%
- P90: 26.20%

## Failure reasons

- daily_loss: 16 (11.4%)
- profit_target: 108 (77.1%)
- total_loss: 8 (5.7%)
- time: 8 (5.7%)
