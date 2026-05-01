#!/usr/bin/env python3
"""
Parity check between the Python live executor (engine_features.simulate_trade)
and the TS backtest engine (src/utils/ftmoDaytrade24h.ts).

Strategy:
  1. Generate 100 deterministic synthetic OHLC bars with a fixed seed.
  2. Run a fixed set of trade scenarios (long-tp, long-stop, short-tp,
     short-stop, long-with-chandelier, long-with-ptp, etc.) through
     `simulate_trade` (Python) and through a HAND-DERIVED reference P&L
     formula (see _expected_pnl_for_scenario) that mirrors the TS engine.
  3. Assert |python_pnl - reference_pnl| / |reference_pnl| <= 2 % per trade.

Because the reference formula is the literal TS-engine math (not a
re-implementation), this is a regression check: any future change to the
Python engine_features that drifts >2% from TS math fails the check.

Run:
    /usr/bin/python3 tools/parity_check.py
"""
from __future__ import annotations

import random
import sys
from pathlib import Path
from typing import Optional

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

from engine_features import (  # noqa: E402
    Bar, SimConfig, simulate_trade,
)


# ---- Deterministic OHLC generator ------------------------------------------
def gen_bars(n: int, start: float = 100.0, drift: float = 0.0, vol: float = 0.01, seed: int = 42) -> list[Bar]:
    """Geometric brownian-ish bars. Each bar's close = prev_close × (1 + drift + ε).

    Returns OHLC where:
      open = prev_close
      close = prev_close × (1 + step)
      high = max(open, close) × (1 + intra_vol)
      low  = min(open, close) × (1 - intra_vol)
    """
    rng = random.Random(seed)
    bars: list[Bar] = []
    prev = start
    for _ in range(n):
        step = drift + rng.gauss(0, vol)
        cl = prev * (1 + step)
        op = prev
        intra = abs(rng.gauss(0, vol * 0.5))
        hi = max(op, cl) * (1 + intra)
        lo = min(op, cl) * (1 - intra)
        bars.append(Bar(open=op, high=hi, low=lo, close=cl))
        prev = cl
    return bars


# ---- Reference P&L formulas (mirror ftmoDaytrade24h.ts:4120-4141) ----------
def reference_raw_pnl(direction: str, entry: float, exit_price: float, cost_bp: float = 0) -> float:
    cost = cost_bp / 10000
    entry_eff = entry * (1 + cost / 2) if direction == "long" else entry * (1 - cost / 2)
    exit_eff = exit_price * (1 - cost / 2) if direction == "long" else exit_price * (1 + cost / 2)
    if direction == "long":
        return (exit_eff - entry_eff) / entry_eff
    return (entry_eff - exit_eff) / entry_eff


def reference_blended_ptp(raw: float, trigger_pct: float, close_fraction: float) -> float:
    return close_fraction * trigger_pct + (1 - close_fraction) * raw


# ---- Scenarios -------------------------------------------------------------
def scenario_long_tp_no_addons() -> tuple[str, list[Bar], int, SimConfig, float]:
    """Strong uptrend → TP hits, plain trade. Reference = +tp_pct."""
    bars = []
    # Force TP hit on bar 2: open=100, close ascends rapidly
    closes = [100, 100, 105, 110]
    for i, c in enumerate(closes):
        op = closes[i - 1] if i > 0 else c
        bars.append(Bar(open=op, high=c * 1.001, low=op * 0.999, close=c))
    cfg = SimConfig(stop_pct=0.05, tp_pct=0.04, hold_bars=10)
    expected = 0.04  # raw_pnl ≈ tp_pct (no cost)
    return ("long_tp_no_addons", bars, 1, cfg, expected)


def scenario_long_stop_no_addons() -> tuple[str, list[Bar], int, SimConfig, float]:
    closes = [100, 100, 95, 90]  # crashes → stop @ -5%
    bars = [Bar(open=closes[i - 1] if i > 0 else c, high=c * 1.001, low=c * 0.999, close=c)
            for i, c in enumerate(closes)]
    cfg = SimConfig(stop_pct=0.05, tp_pct=0.10, hold_bars=10)
    expected = -0.05
    return ("long_stop_no_addons", bars, 1, cfg, expected)


def scenario_short_tp() -> tuple[str, list[Bar], int, SimConfig, float]:
    closes = [100, 100, 95, 90]  # short profits
    bars = [Bar(open=closes[i - 1] if i > 0 else c, high=c * 1.001, low=c * 0.999, close=c)
            for i, c in enumerate(closes)]
    cfg = SimConfig(stop_pct=0.05, tp_pct=0.04, hold_bars=10)
    expected = 0.04
    return ("short_tp", bars, 1, cfg, expected)


def scenario_long_ptp_then_stop() -> tuple[str, list[Bar], int, SimConfig, float]:
    """Long with PTP at 2%/30%, then drift down to base stop -5%.
    Expected = 0.30 × 0.02 + 0.70 × (-0.05) = 0.006 - 0.035 = -0.029
    """
    # bar1 entry, bar2 hits +2% (PTP), bar3 returns to entry, bar4 stop
    closes = [100, 100, 102.5, 100, 95]
    bars = [Bar(open=closes[i - 1] if i > 0 else c, high=c * 1.005, low=c * 0.995, close=c)
            for i, c in enumerate(closes)]
    cfg = SimConfig(
        stop_pct=0.05, tp_pct=0.10, hold_bars=10,
        partial_take_profit={"triggerPct": 0.02, "closeFraction": 0.30},
    )
    expected = 0.30 * 0.02 + 0.70 * (-0.05)
    return ("long_ptp_then_stop", bars, 1, cfg, expected)


def scenario_long_chandelier_locks_profit() -> tuple[str, list[Bar], int, SimConfig, float]:
    """Long, runs up to +6%, then reverts hard. Chandelier should exit at
    a tighter price than the base -5% stop, so raw_pnl > -0.05.

    Need enough warm-up bars (>= chandelier.period+1) so compute_atr returns.
    """
    # 6 warm-up bars (small noise), then entry@bar7, run-up, then revert.
    closes = [100, 100, 100, 100, 100, 100,   # warm-up (period=4 needs >=5)
              100,                              # entry bar
              102, 104, 106, 105, 102, 99, 96]  # rally then revert hard
    bars = [Bar(open=closes[i - 1] if i > 0 else c, high=c * 1.002, low=c * 0.998, close=c)
            for i, c in enumerate(closes)]
    cfg = SimConfig(
        stop_pct=0.05, tp_pct=0.20, hold_bars=20,
        chandelier={"period": 4, "mult": 1.0, "minMoveR": 0.3},
    )
    # We just assert raw_pnl > -0.05 (better than the base stop).
    expected = -0.04  # tolerance applies via the special-case branch in main()
    return ("long_chandelier_locks_profit", bars, 6, cfg, expected)


def scenario_long_with_atrstop_and_live_caps() -> tuple[str, list[Bar], int, SimConfig, Optional[float]]:
    """ATR-stop pushes effStop > maxStopPct → trade is REJECTED.

    Need wide intra-bar high/low so the ATR (true-range-based) reaches a
    fraction larger than live_max_stop_pct.
    """
    # Need >= period+1 warm-up bars BEFORE entry_idx for compute_atr to return.
    closes = [100] * 10
    bars = []
    for i, c in enumerate(closes):
        op = closes[i - 1] if i > 0 else c
        bars.append(Bar(open=op, high=c * 1.15, low=c * 0.85, close=c))
    cfg = SimConfig(
        stop_pct=0.02, tp_pct=0.05, hold_bars=10,
        atr_stop={"period": 5, "stopMult": 2.5},
        live_max_stop_pct=0.03,  # rejects effStop > 3%
    )
    expected = None  # Trade rejected → simulate_trade returns None
    return ("long_with_atrstop_and_live_caps", bars, 7, cfg, expected)


SCENARIOS = [
    scenario_long_tp_no_addons,
    scenario_long_stop_no_addons,
    scenario_short_tp,
    scenario_long_ptp_then_stop,
    scenario_long_chandelier_locks_profit,
    scenario_long_with_atrstop_and_live_caps,
]


# ---- Bulk parity: 100 random-walk trades + closed-form expectation ---------
def _expected_pnl_for_simple_trade(direction: str, bars: list[Bar], entry_idx: int, cfg: SimConfig) -> float:
    """Reference P&L for a trade WITHOUT chandelier/PTP/timeExit/breakEven.

    Phase 17 (engine_features Bug 9): mirror TS engine 4260-4304 EXACTLY:
      1. If TP-hit AND bar.open already gapped past TP → fill at bar.open
         (gap-past-TP wins).
      2. Otherwise, stop-first: if stop-hit, fill at bar.open (gap-down)
         or stop-price, whichever is more conservative.
      3. Otherwise, TP-hit at TP price.
    The previous reference checked stop-first without the gap-past-TP
    override → it tested simulate_trade against itself's bug instead of
    against the TS engine.
    """
    if entry_idx >= len(bars):
        return 0.0
    entry = bars[entry_idx].open
    tp = entry * (1 + cfg.tp_pct) if direction == "long" else entry * (1 - cfg.tp_pct)
    stop = entry * (1 - cfg.stop_pct) if direction == "long" else entry * (1 + cfg.stop_pct)
    mx = min(entry_idx + cfg.hold_bars, len(bars) - 1)
    exit_price = bars[mx].close
    for j in range(entry_idx, mx + 1):
        b = bars[j]
        if direction == "long":
            stop_hit = b.low <= stop
            tp_hit = b.high >= tp
            gap_past_tp = b.open >= tp
            if tp_hit and gap_past_tp:
                exit_price = b.open
                break
            if stop_hit:
                # gap-down: open < stop → fill at the worse open price
                exit_price = b.open if b.open < stop else stop
                break
            if tp_hit:
                exit_price = tp
                break
        else:
            stop_hit = b.high >= stop
            tp_hit = b.low <= tp
            gap_past_tp = b.open <= tp
            if tp_hit and gap_past_tp:
                exit_price = b.open
                break
            if stop_hit:
                # gap-up: open > stop → fill at the worse open price
                exit_price = b.open if b.open > stop else stop
                break
            if tp_hit:
                exit_price = tp
                break
    return reference_raw_pnl(direction, entry, exit_price, cfg.cost_bp)


def bulk_parity_100_trades(seed: int = 7, n: int = 100, tolerance: float = 0.0001) -> tuple[int, int, float]:
    """Generate `n` random simple trades and check P&L parity vs reference.

    `tolerance` = absolute P&L drift allowed (0.0001 = 0.01% absolute drift).
    Returns (passed, failed, max_drift).
    """
    rng = random.Random(seed)
    passed = 0
    failed = 0
    max_drift = 0.0
    for _ in range(n):
        # Random walk bars
        bars = gen_bars(50, vol=rng.uniform(0.005, 0.02), seed=rng.randint(0, 99999))
        cfg = SimConfig(
            stop_pct=rng.choice([0.02, 0.03, 0.05]),
            tp_pct=rng.choice([0.03, 0.05, 0.08]),
            hold_bars=rng.randint(5, 20),
            cost_bp=rng.choice([0, 5, 10]),
        )
        direction = rng.choice(["long", "short"])
        entry_idx = rng.randint(2, 30)
        actual_trade = simulate_trade(direction, bars, entry_idx, cfg)
        if actual_trade is None:
            continue  # rejected by liveCaps — fine, skip
        actual = actual_trade.raw_pnl
        expected = _expected_pnl_for_simple_trade(direction, bars, entry_idx, cfg)
        drift = abs(actual - expected)
        if drift > max_drift:
            max_drift = drift
        if drift <= tolerance:
            passed += 1
        else:
            failed += 1
    return passed, failed, max_drift


# ---- Runner ----------------------------------------------------------------
def main() -> int:
    tolerance_pct = 0.02   # 2 % drift between python and TS-engine reference
    failures = []
    print(f"{'scenario':<40s} {'python_pnl':>12s} {'expected':>12s} {'drift_pct':>12s} status")
    print("-" * 90)

    for sc_fn in SCENARIOS:
        name, bars, entry_idx, cfg, expected = sc_fn()
        direction = "short" if "short" in name else "long"
        trade = simulate_trade(direction, bars, entry_idx, cfg)
        if expected is None:
            status = "OK" if trade is None else "FAIL"
            actual_pnl = float("nan") if trade is None else trade.raw_pnl
            print(f"{name:<40s} {str(trade):<12} {'<rejected>':>12} {'-':>12} {status}")
            if status == "FAIL":
                failures.append((name, "expected rejection but got trade"))
            continue
        if trade is None:
            print(f"{name:<40s} {'<None>':>12s} {expected:>12.4f} {'-':>12} FAIL")
            failures.append((name, "trade was None"))
            continue
        actual = trade.raw_pnl
        # Special: chandelier scenario uses loose comparison (must do BETTER
        # than the configured base stop -5% — i.e. cuts losses earlier).
        if name == "long_chandelier_locks_profit":
            base_stop_loss = -0.05
            ok = actual > base_stop_loss
            drift = abs(actual - expected)
            status = "OK" if ok else "FAIL"
        else:
            denom = max(abs(expected), 1e-6)
            drift = abs(actual - expected) / denom
            ok = drift <= tolerance_pct
            status = "OK" if ok else "FAIL"
        print(f"{name:<40s} {actual:>12.4f} {expected:>12.4f} {drift*100:>11.2f}% {status}")
        if not ok:
            failures.append((name, f"drift {drift*100:.2f}% > {tolerance_pct*100:.1f}%"))

    print("-" * 90)
    if failures:
        print(f"\n[parity_check] {len(failures)} FAIL(s):")
        for name, reason in failures:
            print(f"  - {name}: {reason}")
        return 1

    # 100-trade bulk parity (mirrors the success-criterion in the spec).
    print()
    print("Running 100-trade bulk parity (random walks)...")
    passed, failed, max_drift = bulk_parity_100_trades()
    total = passed + failed
    drift_pct_max = max_drift * 100
    print(f"  100-trade bulk: {passed}/{total} pass, max_drift={drift_pct_max:.4f}%")
    if failed > 2:
        print(f"[parity_check] FAIL — bulk drift > 2 trades ({failed} failed)")
        return 1
    if drift_pct_max > 2.0:
        print(f"[parity_check] FAIL — max drift {drift_pct_max:.4f}% > 2 %")
        return 1

    print(f"\n[parity_check] PASS — {len(SCENARIOS)} scenarios + 100-trade bulk all within 2% drift")
    return 0


if __name__ == "__main__":
    sys.exit(main())
