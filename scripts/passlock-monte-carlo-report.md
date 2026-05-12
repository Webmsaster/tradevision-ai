# PASSLOCK Monte-Carlo Bootstrap Robustness Report

Generated: 2026-05-12T07:32:12.220Z | Bootstrap iterations: 10000 | RNG seed: 42

## Source Data

- Source: `scripts/cache_bakeoff/r28v6_v60_passlock_shard_{0..7}.jsonl`
- Total windows: **136**
- Raw passes: **76 / 136 = 55.88%**

### IMPORTANT: Pre-R9 vs Post-R9 drift

The cached jsonl files reflect the **POST-R9 engine state** (gap-fill bugfix in commit 46d9bb3).
The documented PASSLOCK champion claim was **86/136 = 63.24% PRE-R9** (recorded in `scripts/cache_bakeoff/r60_runall_resume.log`).
Current cache: **76/136 = 55.88% POST-R9**. Drift due to engine bugfix: **-7.36pp**.
This means the 63.24% claim is itself sensitive to engine semantics. Bootstrap confidence intervals below apply to the POST-R9 sample.

## Pass-Rate Bootstrap

| Metric                          | Value                            |
| ------------------------------- | -------------------------------- |
| Point estimate (raw)            | **55.88%**                       |
| Bootstrap mean                  | 55.95%                           |
| Bootstrap stdDev                | 4.25pp                           |
| 95% CI                          | [47.79%, 63.97%] (width 16.18pp) |
| 99% CI                          | [44.85%, 66.91%]                 |
| P(rate < 50%)                   | 6.92%                            |
| P(rate < 55%) — live floor      | 38.90%                           |
| P(rate > 65%)                   | 1.55%                            |
| P(rate > 70%) — overfit ceiling | 0.03%                            |

### Pass-Rate Histogram (1pp buckets)

| % bucket | count |     iterations |
| -------- | ----: | -------------: |
| 41-42%   |     8 |              █ |
| 42-43%   |     4 |              █ |
| 43-44%   |    11 |              █ |
| 44-45%   |    32 |              █ |
| 45-46%   |    29 |              █ |
| 46-47%   |    62 |              █ |
| 47-48%   |   196 |             ██ |
| 48-49%   |   155 |             ██ |
| 49-50%   |   195 |             ██ |
| 50-51%   |   603 |         ██████ |
| 51-52%   |   381 |           ████ |
| 52-53%   |   999 |     ██████████ |
| 53-54%   |   591 |         ██████ |
| 54-55%   |   624 |         ██████ |
| 55-56%   |  1379 | ██████████████ |
| 56-57%   |   654 |        ███████ |
| 57-58%   |   669 |        ███████ |
| 58-59%   |  1208 |   ████████████ |
| 59-60%   |   465 |          █████ |
| 60-61%   |   419 |           ████ |
| 61-62%   |   572 |         ██████ |
| 62-63%   |   231 |             ██ |
| 63-64%   |   284 |            ███ |
| 64-65%   |    74 |              █ |
| 65-66%   |    64 |              █ |
| 66-67%   |    49 |              █ |
| 67-68%   |    20 |              █ |
| 68-69%   |    10 |              █ |
| 69-70%   |     9 |              █ |
| 70-71%   |     1 |              █ |
| 71-72%   |     1 |              █ |
| 72-73%   |     1 |              █ |

## Final-Equity-Pct Bootstrap

Each bootstrap iteration samples 136 windows with replacement
from the observed equity distribution and computes the percentile.

| Percentile | Point   | Bootstrap mean | 95% CI            | StdDev |
| ---------- | ------- | -------------- | ----------------- | ------ |
| Median     | 8.18%   | 7.36%          | [-2.13%, 8.50%]   | 2.67pp |
| P10        | -10.54% | -10.47%        | [-12.34%, -8.09%] | 0.97pp |
| P90        | 10.24%  | 10.21%         | [9.66%, 11.06%]   | 0.33pp |

## Fail-Reason Breakdown (raw)

| Reason        | Count |     % |
| ------------- | ----: | ----: |
| profit_target |    76 | 55.9% |
| daily_loss    |    43 | 31.6% |
| total_loss    |    17 | 12.5% |

## Interpretation

- **CI width**: 16.18pp — moderate (a tight CI suggests the point estimate is well-supported by the sample)
- **P(rate < 55% live-floor)**: 38.90% — moderate downside risk
- **P(rate > 70% overfit-ceiling)**: 0.03% — no overfit signal

**Verdict**: Sweet-spot evidence is moderately robust within this 136-window sample. The bootstrap distribution clusters below the original 63.24% claim, indicating the claim is sensitive to engine semantics (R9 fix).

## Reproduce

```bash
node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts scripts/passlockMonteCarlo.test.ts
```
