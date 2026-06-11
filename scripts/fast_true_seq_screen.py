#!/usr/bin/env python3
"""
Fast FTMO true-seq candidate screener.

This is a funnel, not a final metric reporter:

  L0: P1-only, tiny sample, broad candidate kill pass.
  L1: P1+P2 true-seq on a small sample.
  L2: P1+P2 true-seq on a larger sample.
  Full: optional step-days=1 promotion for final evidence.

All generated sweep artifacts default to /tmp so normal repo state stays clean.
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import csv
import json
import math
import os
import random
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
SWEEP = ROOT / "engine-rust/target/release/ftmo-sweep"

P1_TARGET = "0.10"
P1_MAX_DAYS = "30"
P2_TARGET = "0.05"
P2_MAX_DAYS = "60"


@dataclass(frozen=True)
class ConfigDef:
    key: str
    selector: str
    slow: bool = False


@dataclass(frozen=True)
class BasketDef:
    key: str
    symbols: str
    slow: bool = False


@dataclass(frozen=True)
class KnobPack:
    key: str
    flags: tuple[str, ...] = ()


@dataclass(frozen=True)
class Candidate:
    label: str
    config: ConfigDef
    basket: BasketDef
    knob: KnobPack


@dataclass(frozen=True)
class WindowRow:
    passed: bool
    final_day: int
    fail_reason: str | None


@dataclass
class SingleScore:
    label: str
    funded: int = 0
    eval_n: int = 0
    funded_pct: float = 0.0
    p1_pass: int = 0
    p1_n: int = 0
    p1_pct: float = 0.0
    p2_pass: int = 0
    p2_n: int = 0
    p2_pct: float = 0.0
    missing_after_p1_pass: int = 0
    p1_fail_top: str = ""


@dataclass
class StageResult:
    name: str
    stage_dir: Path
    scores: list[SingleScore] = field(default_factory=list)
    vectors: dict[str, dict[int, bool]] = field(default_factory=dict)
    stack_rows: list[dict[str, object]] = field(default_factory=list)


CONFIGS: tuple[ConfigDef, ...] = (
    ConfigDef("amber", "2h-trend-v5-amber-max-passlock"),
    ConfigDef("mixed_v2", "2h-trend-v5-amber-max-passlock-mixed-v2"),
    ConfigDef("mixed_v4_cvd", "2h-trend-v5-amber-max-passlock-mixed-v4-cvd-only"),
    ConfigDef("agg_tight", "2h-trend-v5-amber-max-passlock-agg-kr-tight-stop"),
    ConfigDef("agg_lowtp", "2h-trend-v5-amber-max-passlock-agg-kr-low-tp"),
    ConfigDef("agg_combo", "2h-trend-v5-amber-max-passlock-agg-kr-combo"),
    ConfigDef("agg_adapt", "2h-trend-v5-amber-max-passlock-agg-kr-adaptive"),
    ConfigDef("agg_be", "2h-trend-v5-amber-max-passlock-agg-kr-be-early"),
    ConfigDef("agg_ptp", "2h-trend-v5-amber-max-passlock-agg-kr-ptp"),
    ConfigDef("p2_grinder", "2h-trend-v5-amber-max-passlock-p2-grinder"),
    ConfigDef("p2_defender", "2h-trend-v5-amber-max-passlock-p2-defender"),
    ConfigDef("bidir_safe", "2h-trend-v5-amber-max-passlock-bidir-safe"),
    ConfigDef("plus_shorts", "2h-trend-v5-amber-max-passlock-amber-plus-shorts"),
    ConfigDef("sharpe_tight", "2h-trend-v5-amber-max-passlock-sharpe-tight"),
    ConfigDef("mptp_v04a", "2h-trend-v5-amber-max-passlock-mptp-v04a"),
    ConfigDef("scheduled", "2h-trend-v5-amber-max-passlock-scheduled-split"),
    ConfigDef("obsidian", "2h-trend-v5-obsidian-passlock"),
    ConfigDef("rubin", "2h-trend-v5-rubin-passlock"),
    ConfigDef("diamond", "2h-trend-v5-diamond-passlock"),
    ConfigDef("shorts_only", "2h-trend-v5-amber-max-passlock-shorts-only", slow=True),
)

BASKETS: tuple[BasketDef, ...] = (
    BasketDef("maj3_bes", "BTCUSDT,ETHUSDT,SOLUSDT"),
    BasketDef("maj6", "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,LINKUSDT,LTCUSDT"),
    BasketDef("defi4", "AAVEUSDT,LINKUSDT,UNIUSDT,ETHUSDT"),
    BasketDef("old4", "BCHUSDT,ETCUSDT,LTCUSDT,XRPUSDT"),
    BasketDef("btc_only", "BTCUSDT"),
    BasketDef("btc_eth", "BTCUSDT,ETHUSDT"),
    BasketDef("alt5_beta", "AAVEUSDT,ARBUSDT,AVAXUSDT,NEARUSDT,SOLUSDT"),
    BasketDef("l1_beta", "AVAXUSDT,DOTUSDT,NEARUSDT,SOLUSDT"),
    BasketDef(
        "full18",
        "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,"
        "BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,"
        "NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT",
        slow=True,
    ),
)

KNOBS: tuple[KnobPack, ...] = (
    KnobPack("base"),
    KnobPack("tp095", ("--override-tp-mult", "0.95")),
    KnobPack("tp105", ("--override-tp-mult", "1.05")),
    KnobPack("tp115", ("--override-tp-mult", "1.15")),
    KnobPack("votes1", ("--regime-min-votes", "1")),
    KnobPack("votes3", ("--regime-min-votes", "3")),
    KnobPack(
        "cross_bnb_9_21",
        ("--cross-asset-sym", "BNBUSDT", "--cross-asset-fast", "9", "--cross-asset-slow", "21"),
    ),
    KnobPack(
        "cross_bnb_21_55",
        ("--cross-asset-sym", "BNBUSDT", "--cross-asset-fast", "21", "--cross-asset-slow", "55"),
    ),
    KnobPack(
        "kelly04",
        ("--kelly-sizing", "--kelly-fraction", "0.40", "--kelly-window", "60", "--kelly-min-trades", "20"),
    ),
    KnobPack(
        "kelly06",
        ("--kelly-sizing", "--kelly-fraction", "0.60", "--kelly-window", "60", "--kelly-min-trades", "20"),
    ),
)

PRESET_KNOBS = {
    "base": ("base",),
    "quick": ("base", "tp105", "tp115", "votes1"),
    "broad": tuple(k.key for k in KNOBS),
}


def pct(numer: int, denom: int) -> float:
    return 100.0 * numer / denom if denom else 0.0


def parse_csv_set(raw: str | None) -> set[str] | None:
    if not raw:
        return None
    return {part.strip() for part in raw.split(",") if part.strip()}


def select_defs[T](defs: Iterable[T], include: set[str] | None, key_fn) -> list[T]:
    selected = [item for item in defs if include is None or key_fn(item) in include]
    if include is not None:
        known = {key_fn(item) for item in defs}
        unknown = sorted(include - known)
        if unknown:
            raise SystemExit(f"unknown selector(s): {', '.join(unknown)}")
    return selected


def build_candidates(args: argparse.Namespace) -> list[Candidate]:
    config_keys = parse_csv_set(args.configs)
    basket_keys = parse_csv_set(args.baskets)
    knob_keys = parse_csv_set(args.knobs)
    if knob_keys is None:
        knob_keys = set(PRESET_KNOBS[args.preset])

    configs = select_defs(CONFIGS, config_keys, lambda c: c.key)
    baskets = select_defs(BASKETS, basket_keys, lambda b: b.key)
    knobs = select_defs(KNOBS, knob_keys, lambda k: k.key)

    if not args.include_slow:
        configs = [c for c in configs if not c.slow]
        baskets = [b for b in baskets if not b.slow]

    candidates: list[Candidate] = []
    for config in configs:
        for basket in baskets:
            for knob in knobs:
                label = f"{config.key}__{basket.key}__{knob.key}"
                candidates.append(Candidate(label=label, config=config, basket=basket, knob=knob))

    rng = random.Random(args.seed)
    if args.shuffle:
        rng.shuffle(candidates)
    if args.max_candidates:
        candidates = candidates[: args.max_candidates]
    return candidates


def result_path(stage_dir: Path, candidate: Candidate, phase: str) -> Path:
    return stage_dir / f"{candidate.label}_{phase}.jsonl"


def count_lines(path: Path) -> int:
    try:
        with path.open("r", encoding="utf-8") as fh:
            return sum(1 for _ in fh)
    except FileNotFoundError:
        return 0


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
                raise SystemExit(f"{path}:{line_no}: invalid sweep row: {exc}") from exc
            rows[win_idx] = WindowRow(
                passed=bool(raw.get("passed", False)),
                final_day=int(raw.get("final_day") or 0),
                fail_reason=raw.get("fail_reason"),
            )
    return rows


def p2_start_idx(p1_idx: int, final_day: int, step_days: int, phase_gap_days: int) -> int:
    days_after_start = max(0, final_day + phase_gap_days)
    return p1_idx + math.ceil(days_after_start / step_days)


def true_seq_vector(
    p1: dict[int, WindowRow],
    p2: dict[int, WindowRow],
    *,
    step_days: int,
    phase_gap_days: int,
) -> tuple[dict[int, bool], int, int, int]:
    vector: dict[int, bool] = {}
    funded = 0
    eval_n = 0
    missing_after_p1_pass = 0
    for p1_idx in sorted(p1):
        p1_row = p1[p1_idx]
        if not p1_row.passed:
            vector[p1_idx] = False
            eval_n += 1
            continue
        p2_idx = p2_start_idx(
            p1_idx,
            p1_row.final_day,
            step_days=step_days,
            phase_gap_days=phase_gap_days,
        )
        p2_row = p2.get(p2_idx)
        if p2_row is None:
            missing_after_p1_pass += 1
            continue
        ok = p2_row.passed
        vector[p1_idx] = ok
        eval_n += 1
        funded += int(ok)
    return vector, funded, eval_n, missing_after_p1_pass


def phase_params(phase: str) -> tuple[str, str]:
    if phase == "p1":
        return P1_TARGET, P1_MAX_DAYS
    if phase == "p2":
        return P2_TARGET, P2_MAX_DAYS
    raise ValueError(f"unknown phase: {phase}")


def sweep_cmd(
    candidate: Candidate,
    phase: str,
    out_path: Path,
    *,
    windows: int,
    step_days: int,
    threads: int,
) -> list[str]:
    target, max_days = phase_params(phase)
    return [
        str(SWEEP),
        "--candles-dir",
        "scripts/cache_bakeoff",
        "--funding-dir",
        "scripts/cache_bakeoff",
        "--symbols",
        candidate.basket.symbols,
        "--windows",
        str(windows),
        "--step-days",
        str(step_days),
        "--threads",
        str(threads),
        "--signals",
        "regime",
        "--config",
        candidate.config.selector,
        "--strict-pass",
        "--profit-target",
        target,
        "--max-days",
        max_days,
        *candidate.knob.flags,
        "--out",
        str(out_path),
    ]


def run_one_sweep(
    candidate: Candidate,
    phase: str,
    stage_dir: Path,
    *,
    windows: int,
    step_days: int,
    threads: int,
    resume: bool,
    dry_run: bool,
) -> tuple[str, str, int, float]:
    out_path = result_path(stage_dir, candidate, phase)
    log_path = stage_dir / f"{candidate.label}_{phase}.log"
    if resume and count_lines(out_path) > 0:
        return candidate.label, phase, 0, 0.0

    cmd = sweep_cmd(
        candidate,
        phase,
        out_path,
        windows=windows,
        step_days=step_days,
        threads=threads,
    )
    if dry_run:
        log_path.write_text(" ".join(cmd) + "\n", encoding="utf-8")
        return candidate.label, phase, 0, 0.0

    started = time.time()
    with log_path.open("w", encoding="utf-8") as log:
        proc = subprocess.run(
            cmd,
            cwd=ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )
    return candidate.label, phase, proc.returncode, time.time() - started


def run_sweeps(
    name: str,
    stage_dir: Path,
    candidates: list[Candidate],
    phases: tuple[str, ...],
    *,
    windows: int,
    step_days: int,
    jobs: int,
    threads: int,
    resume: bool,
    dry_run: bool,
    progress_every: int,
) -> None:
    stage_dir.mkdir(parents=True, exist_ok=True)
    tasks = [(candidate, phase) for candidate in candidates for phase in phases]
    print(
        f"[{name}] candidates={len(candidates)} sweeps={len(tasks)} "
        f"windows={windows} step_days={step_days} jobs={jobs} threads={threads}",
        flush=True,
    )
    if not tasks:
        return

    started = time.time()
    failures: list[tuple[str, str, int]] = []
    done = 0
    with futures.ThreadPoolExecutor(max_workers=jobs) as executor:
        futs = [
            executor.submit(
                run_one_sweep,
                candidate,
                phase,
                stage_dir,
                windows=windows,
                step_days=step_days,
                threads=threads,
                resume=resume,
                dry_run=dry_run,
            )
            for candidate, phase in tasks
        ]
        for fut in futures.as_completed(futs):
            label, phase, rc, elapsed = fut.result()
            done += 1
            if rc:
                failures.append((label, phase, rc))
                print(f"[{name}] FAILED {label} {phase} rc={rc}", flush=True)
            elif done % progress_every == 0 or done == len(tasks):
                print(
                    f"[{name}] done={done}/{len(tasks)} elapsed={time.time() - started:.1f}s",
                    flush=True,
                )
    if failures:
        preview = ", ".join(f"{label}:{phase}:rc{rc}" for label, phase, rc in failures[:8])
        raise SystemExit(f"{name}: {len(failures)} sweep(s) failed: {preview}")


def score_p1(stage_dir: Path, candidates: list[Candidate], name: str) -> list[SingleScore]:
    scores: list[SingleScore] = []
    for candidate in candidates:
        p1_path = result_path(stage_dir, candidate, "p1")
        rows = load_jsonl(p1_path)
        if not rows:
            continue
        p1_pass = sum(1 for row in rows.values() if row.passed)
        fail_top = Counter(
            row.fail_reason or "none" for row in rows.values() if not row.passed
        ).most_common(3)
        scores.append(
            SingleScore(
                label=candidate.label,
                p1_pass=p1_pass,
                p1_n=len(rows),
                p1_pct=pct(p1_pass, len(rows)),
                p1_fail_top=";".join(f"{key}:{count}" for key, count in fail_top),
            )
        )
    scores.sort(key=lambda s: (s.p1_pct, s.p1_pass), reverse=True)
    write_single_scores(stage_dir / f"{name}_p1_leaderboard.tsv", scores, p1_only=True)
    return scores


def score_true_seq(
    stage_dir: Path,
    candidates: list[Candidate],
    name: str,
    *,
    step_days: int,
    phase_gap_days: int,
) -> StageResult:
    result = StageResult(name=name, stage_dir=stage_dir)
    for candidate in candidates:
        p1 = load_jsonl(result_path(stage_dir, candidate, "p1"))
        p2 = load_jsonl(result_path(stage_dir, candidate, "p2"))
        if not p1 or not p2:
            continue
        vector, funded, eval_n, missing = true_seq_vector(
            p1,
            p2,
            step_days=step_days,
            phase_gap_days=phase_gap_days,
        )
        p1_pass = sum(1 for row in p1.values() if row.passed)
        p2_pass = sum(1 for row in p2.values() if row.passed)
        fail_top = Counter(
            row.fail_reason or "none" for row in p1.values() if not row.passed
        ).most_common(3)
        result.vectors[candidate.label] = vector
        result.scores.append(
            SingleScore(
                label=candidate.label,
                funded=funded,
                eval_n=eval_n,
                funded_pct=pct(funded, eval_n),
                p1_pass=p1_pass,
                p1_n=len(p1),
                p1_pct=pct(p1_pass, len(p1)),
                p2_pass=p2_pass,
                p2_n=len(p2),
                p2_pct=pct(p2_pass, len(p2)),
                missing_after_p1_pass=missing,
                p1_fail_top=";".join(f"{key}:{count}" for key, count in fail_top),
            )
        )
    result.scores.sort(key=lambda s: (s.funded_pct, s.funded, s.p1_pct), reverse=True)
    result.stack_rows = greedy_stack4(result.vectors)
    write_single_scores(stage_dir / f"{name}_leaderboard.tsv", result.scores)
    write_stack_rows(stage_dir / f"{name}_greedy_stack4.tsv", result.stack_rows)
    return result


def greedy_stack4(vectors: dict[str, dict[int, bool]]) -> list[dict[str, object]]:
    if not vectors:
        return []
    common = sorted(set.intersection(*(set(v) for v in vectors.values())))
    covered = {idx: False for idx in common}
    remaining = set(vectors)
    rows: list[dict[str, object]] = []
    for slot in range(1, 5):
        current_hits = sum(1 for value in covered.values() if value)
        best: tuple[int, int, str] | None = None
        for label in remaining:
            vector = vectors[label]
            hits = sum(1 for idx in common if covered[idx] or vector.get(idx, False))
            gain = hits - current_hits
            candidate = (gain, hits, label)
            if best is None or candidate > best:
                best = candidate
        if best is None:
            break
        gain, hits, label = best
        for idx in common:
            covered[idx] = covered[idx] or vectors[label].get(idx, False)
        remaining.remove(label)
        rows.append(
            {
                "slot": slot,
                "label": label,
                "gain": gain,
                "hits": hits,
                "eval_n": len(common),
                "pct": pct(hits, len(common)),
            }
        )
    return rows


def write_manifest(path: Path, candidates: list[Candidate]) -> None:
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=["label", "config_key", "selector", "basket_key", "symbols", "knob_key", "flags"],
            delimiter="\t",
        )
        writer.writeheader()
        for candidate in candidates:
            writer.writerow(
                {
                    "label": candidate.label,
                    "config_key": candidate.config.key,
                    "selector": candidate.config.selector,
                    "basket_key": candidate.basket.key,
                    "symbols": candidate.basket.symbols,
                    "knob_key": candidate.knob.key,
                    "flags": " ".join(candidate.knob.flags),
                }
            )


def write_single_scores(path: Path, scores: list[SingleScore], *, p1_only: bool = False) -> None:
    if p1_only:
        fields = ["label", "p1_pass", "p1_n", "p1_pct", "p1_fail_top"]
    else:
        fields = [
            "label",
            "funded",
            "eval_n",
            "funded_pct",
            "p1_pass",
            "p1_n",
            "p1_pct",
            "p2_pass",
            "p2_n",
            "p2_pct",
            "missing_after_p1_pass",
            "p1_fail_top",
        ]
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, delimiter="\t")
        writer.writeheader()
        for score in scores:
            row = score.__dict__.copy()
            row["p1_pct"] = f"{score.p1_pct:.4f}"
            row["p2_pct"] = f"{score.p2_pct:.4f}"
            row["funded_pct"] = f"{score.funded_pct:.4f}"
            writer.writerow({field: row[field] for field in fields})


def write_stack_rows(path: Path, rows: list[dict[str, object]]) -> None:
    fields = ["slot", "label", "gain", "hits", "eval_n", "pct"]
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, delimiter="\t")
        writer.writeheader()
        for row in rows:
            out = dict(row)
            out["pct"] = f"{float(row['pct']):.4f}"
            writer.writerow(out)


def labels_to_candidates(candidates: list[Candidate], labels: Iterable[str]) -> list[Candidate]:
    by_label = {candidate.label: candidate for candidate in candidates}
    return [by_label[label] for label in labels if label in by_label]


def promote_by_p1(scores: list[SingleScore], min_pct: float, top_n: int) -> list[str]:
    filtered = [score for score in scores if score.p1_pct >= min_pct]
    if not filtered:
        filtered = scores
    return [score.label for score in filtered[:top_n]]


def promote_by_true_seq(scores: list[SingleScore], min_pct: float, top_n: int) -> list[str]:
    filtered = [score for score in scores if score.funded_pct >= min_pct]
    if not filtered:
        filtered = scores
    return [score.label for score in filtered[:top_n]]


def print_top_p1(scores: list[SingleScore], limit: int) -> None:
    print(f"{'label':<54} {'P1':>12}  fail_top")
    for score in scores[:limit]:
        print(
            f"{score.label:<54} {score.p1_pass:>4}/{score.p1_n:<4} "
            f"{score.p1_pct:>6.2f}%  {score.p1_fail_top}"
        )


def print_top_true_seq(result: StageResult, limit: int) -> None:
    print(f"{'label':<54} {'true-seq':>14} {'P1%':>7} {'P2%':>7}")
    for score in result.scores[:limit]:
        print(
            f"{score.label:<54} {score.funded:>4}/{score.eval_n:<5} "
            f"{score.funded_pct:>6.2f}% {score.p1_pct:>6.2f}% {score.p2_pct:>6.2f}%"
        )
    if result.stack_rows:
        print("Greedy Stack-4 OR:")
        for row in result.stack_rows:
            print(
                f"  {row['slot']}. {row['label']:<54} "
                f"gain={int(row['gain']):>4} "
                f"stack={int(row['hits'])}/{int(row['eval_n'])} = {float(row['pct']):.2f}%"
            )


def default_out_dir() -> Path:
    return Path(f"/tmp/ftmo_fast_true_seq_screen_{time.strftime('%Y%m%d_%H%M%S')}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--preset", choices=sorted(PRESET_KNOBS), default="quick")
    parser.add_argument("--configs", help="comma-separated config keys")
    parser.add_argument("--baskets", help="comma-separated basket keys")
    parser.add_argument("--knobs", help="comma-separated knob keys; overrides --preset")
    parser.add_argument("--include-slow", action="store_true", help="include slow configs/baskets")
    parser.add_argument("--max-candidates", type=int, default=0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-shuffle", dest="shuffle", action="store_false", default=True)
    parser.add_argument("--jobs", type=int, default=min(12, os.cpu_count() or 4))
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--progress-every", type=int, default=25)
    parser.add_argument("--no-resume", dest="resume", action="store_false", default=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--skip-l0",
        action="store_true",
        help="skip P1 prefilter and send all selected candidates directly to L1",
    )

    parser.add_argument("--l0-windows", type=int, default=120)
    parser.add_argument("--l0-step-days", type=int, default=7)
    parser.add_argument("--l0-min-p1-pct", type=float, default=24.0)
    parser.add_argument("--l0-top", type=int, default=40)

    parser.add_argument("--l1-windows", type=int, default=180)
    parser.add_argument("--l1-step-days", type=int, default=5)
    parser.add_argument("--l1-min-true-seq-pct", type=float, default=11.5)
    parser.add_argument("--l1-top", type=int, default=12)

    parser.add_argument("--run-l2", action="store_true")
    parser.add_argument("--l2-windows", type=int, default=334)
    parser.add_argument("--l2-step-days", type=int, default=3)
    parser.add_argument("--l2-min-true-seq-pct", type=float, default=12.5)
    parser.add_argument("--l2-top", type=int, default=6)

    parser.add_argument("--run-full", action="store_true")
    parser.add_argument(
        "--full-source",
        choices=("stack", "singles"),
        default="stack",
        help="choose Full candidates from the latest greedy stack or singles leaderboard",
    )
    parser.add_argument("--full-windows", type=int, default=9999)
    parser.add_argument("--full-step-days", type=int, default=1)
    parser.add_argument("--full-top", type=int, default=4)
    parser.add_argument("--phase-gap-days", type=int, default=1)
    parser.add_argument("--print-top", type=int, default=15)
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if not SWEEP.exists():
        raise SystemExit(f"missing ftmo-sweep binary: {SWEEP}")
    for name in ("jobs", "threads", "progress_every"):
        if getattr(args, name) <= 0:
            raise SystemExit(f"--{name.replace('_', '-')} must be positive")
    for name in (
        "l0_windows",
        "l0_step_days",
        "l0_top",
        "l1_windows",
        "l1_step_days",
        "l1_top",
        "l2_windows",
        "l2_step_days",
        "l2_top",
        "full_windows",
        "full_step_days",
        "full_top",
    ):
        if getattr(args, name) <= 0:
            raise SystemExit(f"--{name.replace('_', '-')} must be positive")
    if args.phase_gap_days < 0:
        raise SystemExit("--phase-gap-days must be non-negative")


def main() -> int:
    args = parse_args()
    validate_args(args)

    out_dir = args.out_dir or default_out_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    candidates = build_candidates(args)
    if not candidates:
        raise SystemExit("no candidates selected")
    write_manifest(out_dir / "candidate_manifest.tsv", candidates)

    print(f"[screen] out={out_dir}", flush=True)
    print(
        f"[screen] candidates={len(candidates)} preset={args.preset} "
        f"shuffle={args.shuffle} seed={args.seed}",
        flush=True,
    )

    if args.skip_l0:
        if args.dry_run:
            print("[screen] dry-run with --skip-l0: no L0 commands to write")
            return 0
        l1_candidates = candidates
        print(f"[screen] --skip-l0: promoted all to L1: {len(l1_candidates)}", flush=True)
    else:
        l0_dir = out_dir / "l0"
        run_sweeps(
            "l0",
            l0_dir,
            candidates,
            ("p1",),
            windows=args.l0_windows,
            step_days=args.l0_step_days,
            jobs=args.jobs,
            threads=args.threads,
            resume=args.resume,
            dry_run=args.dry_run,
            progress_every=args.progress_every,
        )
        if args.dry_run:
            print("[screen] dry-run complete")
            return 0

        l0_scores = score_p1(l0_dir, candidates, "l0")
        print("\nL0 P1 leaders:")
        print_top_p1(l0_scores, args.print_top)
        l1_candidates = labels_to_candidates(
            candidates,
            promote_by_p1(l0_scores, args.l0_min_p1_pct, args.l0_top),
        )
        print(f"[screen] L0 promoted to L1: {len(l1_candidates)}", flush=True)

    l1_dir = out_dir / "l1"
    run_sweeps(
        "l1",
        l1_dir,
        l1_candidates,
        ("p1", "p2"),
        windows=args.l1_windows,
        step_days=args.l1_step_days,
        jobs=args.jobs,
        threads=args.threads,
        resume=args.resume,
        dry_run=False,
        progress_every=args.progress_every,
    )
    l1_result = score_true_seq(
        l1_dir,
        l1_candidates,
        "l1",
        step_days=args.l1_step_days,
        phase_gap_days=args.phase_gap_days,
    )
    print("\nL1 true-seq leaders:")
    print_top_true_seq(l1_result, args.print_top)

    next_candidates = labels_to_candidates(
        candidates,
        promote_by_true_seq(l1_result.scores, args.l1_min_true_seq_pct, args.l1_top),
    )
    print(f"[screen] L1 promoted: {len(next_candidates)}", flush=True)

    last_true_seq = l1_result
    if args.run_l2:
        l2_dir = out_dir / "l2"
        run_sweeps(
            "l2",
            l2_dir,
            next_candidates,
            ("p1", "p2"),
            windows=args.l2_windows,
            step_days=args.l2_step_days,
            jobs=args.jobs,
            threads=args.threads,
            resume=args.resume,
            dry_run=False,
            progress_every=args.progress_every,
        )
        l2_result = score_true_seq(
            l2_dir,
            next_candidates,
            "l2",
            step_days=args.l2_step_days,
            phase_gap_days=args.phase_gap_days,
        )
        print("\nL2 true-seq leaders:")
        print_top_true_seq(l2_result, args.print_top)
        next_candidates = labels_to_candidates(
            candidates,
            promote_by_true_seq(l2_result.scores, args.l2_min_true_seq_pct, args.l2_top),
        )
        print(f"[screen] L2 promoted: {len(next_candidates)}", flush=True)
        last_true_seq = l2_result

    if args.run_full:
        if args.full_source == "stack" and last_true_seq.stack_rows:
            full_labels = [
                str(row["label"]) for row in last_true_seq.stack_rows[: args.full_top]
            ]
            full_candidates = labels_to_candidates(candidates, full_labels)
        else:
            full_candidates = next_candidates[: args.full_top]
        print(
            f"[screen] Full source={args.full_source} candidates={len(full_candidates)}",
            flush=True,
        )
        full_dir = out_dir / "full"
        run_sweeps(
            "full",
            full_dir,
            full_candidates,
            ("p1", "p2"),
            windows=args.full_windows,
            step_days=args.full_step_days,
            jobs=max(1, min(args.jobs, 4)),
            threads=max(args.threads, 2),
            resume=args.resume,
            dry_run=False,
            progress_every=max(1, min(args.progress_every, 4)),
        )
        full_result = score_true_seq(
            full_dir,
            full_candidates,
            "full",
            step_days=args.full_step_days,
            phase_gap_days=args.phase_gap_days,
        )
        print("\nFull true-seq leaders:")
        print_top_true_seq(full_result, args.print_top)
        last_true_seq = full_result

    print("\nArtifacts:")
    print(f"  manifest: {out_dir / 'candidate_manifest.tsv'}")
    print(f"  latest leaderboard: {last_true_seq.stage_dir / (last_true_seq.name + '_leaderboard.tsv')}")
    print(f"  latest stack: {last_true_seq.stage_dir / (last_true_seq.name + '_greedy_stack4.tsv')}")
    if not args.run_full:
        print("  note: no full step-days=1 promotion was run; treat these as screening results only.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
