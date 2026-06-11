#!/usr/bin/env python3
"""Offline simulator: replay each window's trades while applying tier-system
rules (intra-burst-block, breadth-gate-OR). Quantify uplift before
committing engine changes.

NOTE: This is approximate — it ignores compounding effects of skipping a
trade (subsequent risk-sizing depends on equity). For first-order pass-rate
direction it's sufficient.
"""
from __future__ import annotations
import json
import statistics
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent / "cache_bakeoff/cluster_audit"
WIN_PATH = BASE / "champion.jsonl"
TRADE_PATH = BASE / "champion_trades.jsonl"
MAJORS = {"BTC", "ETH", "BNB", "SOL"}
PROFIT_TARGET = 0.10
DAILY_LOSS_LIMIT = -0.05
TOTAL_LOSS_LIMIT = -0.10


def base_sym(s: str) -> str:
    head = s.split("-")[0].upper()
    if head.endswith("USDT"):
        head = head[:-4]
    return head


def load_windows():
    out = {}
    with WIN_PATH.open() as f:
        for line in f:
            r = json.loads(line)
            out[r["win_idx"]] = r
    return out


def load_trades_by_window():
    out = defaultdict(list)
    with TRADE_PATH.open() as f:
        for line in f:
            r = json.loads(line)
            out[r["winIdx"]].append(r)
    for k in out:
        out[k].sort(key=lambda t: t["entryTime"])
    return out


def replay(
    trades: list,
    block_after_n: int = 999,
    block_window_hours: int = 24,
    cooldown_hours: int = 0,
) -> dict:
    """Replay a window applying block-on-burst rule.
    Returns the equity curve + pass/fail result.
    """
    equity = 0.0
    peak = 0.0
    day_pnl = defaultdict(float)
    blocked_until_ms: int | None = None
    accepted: list = []
    blocked_count = 0
    fail_reason = None

    for tr in trades:
        et = tr["entryTime"]
        # Anti-burst gate: count accepted trades in trailing block_window_hours
        cutoff = et - block_window_hours * 3_600_000
        recent = sum(1 for a in accepted if a["entryTime"] >= cutoff)
        is_blocked = recent >= block_after_n
        if blocked_until_ms is not None and et < blocked_until_ms:
            is_blocked = True
        if is_blocked:
            blocked_count += 1
            if cooldown_hours > 0 and blocked_until_ms is None:
                blocked_until_ms = et + cooldown_hours * 3_600_000
            continue

        # Accept this trade
        accepted.append(tr)
        eff_pnl = tr["effPnl"]
        equity += eff_pnl
        peak = max(peak, equity)
        day = tr["day"]
        day_pnl[day] += eff_pnl

        # Mid-trade pass/fail checks (matches engine semantics roughly)
        if equity >= PROFIT_TARGET:
            return {
                "passed": True,
                "fail_reason": None,
                "final_equity": equity,
                "accepted": len(accepted),
                "blocked": blocked_count,
                "n_total": len(trades),
            }
        if equity <= TOTAL_LOSS_LIMIT:
            return {
                "passed": False,
                "fail_reason": "TotalLoss",
                "final_equity": equity,
                "accepted": len(accepted),
                "blocked": blocked_count,
                "n_total": len(trades),
            }
        if day_pnl[day] <= DAILY_LOSS_LIMIT:
            return {
                "passed": False,
                "fail_reason": "DailyLoss",
                "final_equity": equity,
                "accepted": len(accepted),
                "blocked": blocked_count,
                "n_total": len(trades),
            }

    return {
        "passed": equity >= PROFIT_TARGET,
        "fail_reason": None if equity >= PROFIT_TARGET else "MaxDays",
        "final_equity": equity,
        "accepted": len(accepted),
        "blocked": blocked_count,
        "n_total": len(trades),
    }


def baseline_check(trades, original_result):
    """Sanity-check: replay with NO blocking — equity should match the
    engine's reported final_equity_pct within rounding tolerance.
    """
    r = replay(trades, block_after_n=999)
    return r["final_equity"], original_result.get("final_equity_pct", 0.0)


def eval_strategy(strategy_name, rule_fn, replay_kwargs, all_windows, trades_by_win):
    """rule_fn: window -> bool (qualified). Replay only qualified."""
    q_pass = q_fail = uq_pass = uq_fail = 0
    blocked_total = 0
    qualifying_window_indexes = []
    for w_idx, w in all_windows.items():
        trades = trades_by_win.get(w_idx, [])
        is_qual = rule_fn(w, trades)
        if not is_qual:
            if w["passed"]:
                uq_pass += 1
            else:
                uq_fail += 1
            continue
        qualifying_window_indexes.append(w_idx)
        r = replay(trades, **replay_kwargs)
        blocked_total += r["blocked"]
        if r["passed"]:
            q_pass += 1
        else:
            q_fail += 1
    total = q_pass + q_fail + uq_pass + uq_fail
    n_qual = q_pass + q_fail
    cond = q_pass / n_qual * 100 if n_qual else 0.0
    unc = q_pass / total * 100 if total else 0.0
    print(f"{strategy_name:55s} | qual={n_qual:3d}/{total} ({n_qual/total*100:5.1f}%) | "
          f"pass={q_pass:3d} cond={cond:6.2f}% unc={unc:6.2f}% | blocked-total={blocked_total}")
    return q_pass, n_qual


def compute_first_cluster(trades):
    """(breadth_24h, majors_24h) — first-24h-after-first-trade cluster."""
    if not trades:
        return 0, 0
    t0 = trades[0]["entryTime"]
    cutoff = t0 + 24 * 3_600_000
    syms = {base_sym(t["symbol"]) for t in trades if t["entryTime"] <= cutoff}
    return len(syms), len(syms & MAJORS)


def main():
    windows = load_windows()
    trades_by_win = load_trades_by_window()

    # Sanity check: replay with no blocking matches engine reported equity
    diffs = []
    for w_idx, w in windows.items():
        trades = trades_by_win.get(w_idx, [])
        if not trades:
            continue
        sim_eq, engine_eq = baseline_check(trades, w)
        diffs.append(abs(sim_eq - engine_eq))
    print(f"Sanity-check baseline replay vs engine equity: "
          f"mean-diff={statistics.mean(diffs):.5f} max-diff={max(diffs):.5f}")
    print()

    def gate_baseline(w, trades):
        b, m = compute_first_cluster(trades)
        return b >= 4 and m >= 3

    def gate_b10_m2(w, trades):
        b, m = compute_first_cluster(trades)
        return b >= 10 and m >= 2

    def gate_b10_m2_or_premium(w, trades):
        b, m = compute_first_cluster(trades)
        if b >= 6 and m >= 4:
            return True  # premium tier
        return b >= 10 and m >= 2

    def gate_b4_m3_or_b10_m2(w, trades):
        b, m = compute_first_cluster(trades)
        return (b >= 4 and m >= 3) or (b >= 10 and m >= 2)

    print(f"{'STRATEGY':55s} | {'QUAL':>20s} | {'PASS':>30s} | extras")
    print('-' * 140)

    # Reference: no blocking, baseline gate (this should match engine 55/59 = 93.22%)
    eval_strategy("REFERENCE: gate=baseline NO-block",
                  gate_baseline, {"block_after_n": 999}, windows, trades_by_win)
    print()

    # Vary the intra-24h burst block threshold with BASELINE gate
    for n in [10, 12, 14, 16, 18, 20, 24]:
        eval_strategy(f"gate=baseline + block_after_24h_count>={n}",
                      gate_baseline, {"block_after_n": n}, windows, trades_by_win)
    print()

    # Vary 12h-window block (tighter burst window)
    for n in [6, 8, 10, 12]:
        eval_strategy(f"gate=baseline + block_after_12h_count>={n}",
                      gate_baseline, {"block_after_n": n, "block_window_hours": 12},
                      windows, trades_by_win)
    print()

    # NEW gate variants × burst-block
    print("=== Softer gates with burst-block ===")
    eval_strategy("gate=b10_m2 NO-block",
                  gate_b10_m2, {"block_after_n": 999}, windows, trades_by_win)
    eval_strategy("gate=b10_m2 + block>=18 (24h)",
                  gate_b10_m2, {"block_after_n": 18}, windows, trades_by_win)
    eval_strategy("gate=b10_m2 + block>=14 (24h)",
                  gate_b10_m2, {"block_after_n": 14}, windows, trades_by_win)
    print()

    print("=== OR-combined gates ===")
    eval_strategy("gate=(b4 m3) OR (b10 m2) NO-block",
                  gate_b4_m3_or_b10_m2, {"block_after_n": 999}, windows, trades_by_win)
    eval_strategy("gate=(b4 m3) OR (b10 m2) + block>=18",
                  gate_b4_m3_or_b10_m2, {"block_after_n": 18}, windows, trades_by_win)
    eval_strategy("gate=(b6 m4) OR (b10 m2) + block>=18 (Tier-S OR softer)",
                  gate_b10_m2_or_premium, {"block_after_n": 18}, windows, trades_by_win)


if __name__ == "__main__":
    main()
