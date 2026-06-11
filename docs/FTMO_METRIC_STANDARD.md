# FTMO Metric Standard

Status: active standard from 2026-05-25.

## Accepted Funded Metric

For any FTMO 2-Step strategy or stack, report funded probability only as:

```text
P1 at start window i passes
-> P2 starts at i + final_day + phase_gap
-> P2 passes
-> account funded
```

Default `phase_gap = 1 day` to avoid same-day join overlap. Use
`phase_gap = 0` only to reproduce older reports, and label it explicitly.

For stacks, aggregate per start window:

```text
stack funded = at least one account is funded under the true-sequential rule
```

## Tooling

Use:

```bash
python3 scripts/true_seq_stack_audit.py \
  amber=path/to/amber_p1.jsonl,path/to/amber_p2.jsonl \
  mixed=path/to/mixed_p1.jsonl,path/to/mixed_p2.jsonl
```

Optional:

```bash
--phase-gap-days 0
```

Only for reproducing legacy `j = i + final_day` reports.

## Rejected Metrics

Do not use these as funded probability:

- P1-only pass rate
- P2-only pass rate
- same-window `P1[i] AND P2[i]`
- `P1 * P2` independence multiplication
- qualified-subset pass rate without a live-valid start mechanism
- OOS/GA-best headline without the exact window set, phase gap, and stack membership

Those can still be diagnostic metrics, but they must not be called pass rate,
funded rate, or deploy expectancy.
