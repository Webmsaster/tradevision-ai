#!/usr/bin/env python3
"""
True-sequential FTMO funded-rate audit.

Inputs are ftmo-sweep JSONL files with at least:
  - win_idx
  - passed
  - final_day

For one account, "funded" means:
  P1 at window i passes, then P2 at the next valid start after P1 ended passes.

For a stack, the reported rate is per-start-window OR:
  at least one account in the stack becomes funded.

Usage:
  python3 scripts/true_seq_stack_audit.py \
    amber=/tmp/amber_p1.jsonl,/tmp/amber_p2.jsonl \
    mixed=/tmp/mixed_p1.jsonl,/tmp/mixed_p2.jsonl

By default the P2 start has a 1-day gap after P1 final_day to avoid same-day
join overlap. Use --phase-gap-days 0 to reproduce older j=i+D scripts.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class WindowRow:
    passed: bool
    final_day: int
    fail_reason: str | None


@dataclass(frozen=True)
class AccountSpec:
    label: str
    p1_path: Path
    p2_path: Path


@dataclass
class AccountData:
    spec: AccountSpec
    p1: dict[int, WindowRow]
    p2: dict[int, WindowRow]


def load_jsonl(path: Path) -> dict[int, WindowRow]:
    rows: dict[int, WindowRow] = {}
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
                win_idx = int(raw["win_idx"])
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                raise SystemExit(f"{path}:{line_no}: invalid ftmo-sweep row: {exc}") from exc
            rows[win_idx] = WindowRow(
                passed=bool(raw.get("passed", False)),
                final_day=int(raw.get("final_day") or 0),
                fail_reason=raw.get("fail_reason"),
            )
    if not rows:
        raise SystemExit(f"{path}: no rows found")
    return rows


def parse_account_spec(raw: str) -> AccountSpec:
    if "=" in raw:
        label, files = raw.split("=", 1)
        parts = files.split(",", 1)
        if len(parts) != 2 or not label or not all(parts):
            raise argparse.ArgumentTypeError(
                "account must be label=p1_jsonl,p2_jsonl"
            )
        return AccountSpec(label=label, p1_path=Path(parts[0]), p2_path=Path(parts[1]))

    # Backward-compatible shorthand for POSIX paths. Prefer label=p1,p2 so
    # Windows drive letters like C:\... do not collide with the separator.
    parts = raw.split(":")
    if len(parts) != 3 or not all(parts):
        raise argparse.ArgumentTypeError(
            "account must be label=p1_jsonl,p2_jsonl"
        )
    label, p1_path, p2_path = parts
    return AccountSpec(label=label, p1_path=Path(p1_path), p2_path=Path(p2_path))


def p2_start_idx(
    p1_idx: int,
    final_day: int,
    *,
    step_days: int,
    phase_gap_days: int,
) -> int:
    days_after_start = max(0, final_day + phase_gap_days)
    return p1_idx + math.ceil(days_after_start / step_days)


def funded_at(
    account: AccountData,
    p1_idx: int,
    *,
    step_days: int,
    phase_gap_days: int,
) -> bool | None:
    p1_row = account.p1.get(p1_idx)
    if p1_row is None:
        return None
    if not p1_row.passed:
        return False
    p2_idx = p2_start_idx(
        p1_idx,
        p1_row.final_day,
        step_days=step_days,
        phase_gap_days=phase_gap_days,
    )
    p2_row = account.p2.get(p2_idx)
    if p2_row is None:
        return None
    return p2_row.passed


def pct(numer: int, denom: int) -> float:
    return 100.0 * numer / denom if denom else 0.0


def iter_common_p1_keys(accounts: Iterable[AccountData]) -> list[int]:
    iterator = iter(accounts)
    first = next(iterator, None)
    if first is None:
        return []
    common = set(first.p1)
    for account in iterator:
        common &= set(account.p1)
    return sorted(common)


def print_account_summary(
    account: AccountData,
    *,
    step_days: int,
    phase_gap_days: int,
) -> None:
    p1_keys = sorted(account.p1)
    p1_pass = sum(1 for row in account.p1.values() if row.passed)
    funded = 0
    eval_n = 0
    missing_after_p1_pass = 0
    p1_fail_reasons = Counter(
        row.fail_reason or "none" for row in account.p1.values() if not row.passed
    )

    for p1_idx in p1_keys:
        result = funded_at(
            account,
            p1_idx,
            step_days=step_days,
            phase_gap_days=phase_gap_days,
        )
        if result is None:
            row = account.p1[p1_idx]
            if row.passed:
                missing_after_p1_pass += 1
            continue
        eval_n += 1
        funded += 1 if result else 0

    print(f"  {account.spec.label}")
    print(f"    P1 marginal       : {p1_pass}/{len(account.p1)} = {pct(p1_pass, len(account.p1)):6.2f}%")
    print(f"    true-seq funded   : {funded}/{eval_n} = {pct(funded, eval_n):6.2f}%")
    print(f"    P1-pass missing P2: {missing_after_p1_pass}/{p1_pass}")
    if p1_fail_reasons:
        top = ", ".join(f"{k}={v}" for k, v in p1_fail_reasons.most_common(4))
        print(f"    P1 fail reasons   : {top}")


def print_stack_summary(
    accounts: list[AccountData],
    *,
    step_days: int,
    phase_gap_days: int,
) -> None:
    keys = iter_common_p1_keys(accounts)
    per_account = {account.spec.label: 0 for account in accounts}
    funded_count_dist: Counter[int] = Counter()
    eval_n = 0
    skipped = 0

    for p1_idx in keys:
        results: list[tuple[str, bool]] = []
        for account in accounts:
            funded = funded_at(
                account,
                p1_idx,
                step_days=step_days,
                phase_gap_days=phase_gap_days,
            )
            if funded is None:
                skipped += 1
                results = []
                break
            results.append((account.spec.label, funded))
        if not results:
            continue
        eval_n += 1
        funded_count = sum(1 for _, funded in results if funded)
        funded_count_dist[funded_count] += 1
        for label, funded in results:
            if funded:
                per_account[label] += 1

    stack_funded = sum(v for k, v in funded_count_dist.items() if k > 0)
    print("\nStack OR")
    print(f"  evaluable starts   : {eval_n}")
    print(f"  skipped starts     : {skipped}")
    print(f"  >=1 funded         : {stack_funded}/{eval_n} = {pct(stack_funded, eval_n):6.2f}%")
    print("  per-account in stack sample:")
    for label, count in per_account.items():
        print(f"    {label:<18} {count}/{eval_n} = {pct(count, eval_n):6.2f}%")
    print("  funded-count distribution:")
    for funded_count in range(0, len(accounts) + 1):
        count = funded_count_dist.get(funded_count, 0)
        print(f"    {funded_count} funded: {count}/{eval_n} = {pct(count, eval_n):6.2f}%")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "accounts",
        nargs="+",
        type=parse_account_spec,
        help="account spec as label=p1_jsonl,p2_jsonl",
    )
    parser.add_argument(
        "--step-days",
        type=int,
        default=1,
        help="days between successive win_idx starts in the JSONL sweep (default: 1)",
    )
    parser.add_argument(
        "--phase-gap-days",
        type=int,
        default=1,
        help="extra days between P1 end and P2 start; 1 avoids join-day overlap (default: 1)",
    )
    args = parser.parse_args()

    if args.step_days <= 0:
        parser.error("--step-days must be positive")
    if args.phase_gap_days < 0:
        parser.error("--phase-gap-days must be non-negative")

    accounts = [
        AccountData(spec=spec, p1=load_jsonl(spec.p1_path), p2=load_jsonl(spec.p2_path))
        for spec in args.accounts
    ]

    print("True-sequential funded audit")
    print(f"  accounts       : {len(accounts)}")
    print(f"  step_days      : {args.step_days}")
    print(f"  phase_gap_days : {args.phase_gap_days}")
    print("\nSingle accounts")
    for account in accounts:
        print_account_summary(
            account,
            step_days=args.step_days,
            phase_gap_days=args.phase_gap_days,
        )
    if len(accounts) > 1:
        print_stack_summary(
            accounts,
            step_days=args.step_days,
            phase_gap_days=args.phase_gap_days,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
