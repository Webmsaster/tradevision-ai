"""
Unit tests for tools/engine_features.py — pure-Python implementations of the
V4 backtest engine features. These run without MT5 and must match the TS
engine behavior bar-for-bar.

Run:
    /usr/bin/python3 -m pytest tools/test_engine_features.py -v
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Add tools/ to path
TOOLS = Path(__file__).parent
sys.path.insert(0, str(TOOLS))

from engine_features import (  # noqa: E402
    ChandelierState, atr_smoothed_chandelier_exit, compute_atr,
    adaptive_position_sizing, update_kelly_window,
    PartialTPState, check_partial_take_profit, blend_partial_tp_pnl,
    htf_trend_filter,
    LossStreakState, update_loss_streak, is_in_cooldown,
    compute_sizing_factor_from_pdd, update_persisted_peak,
    correlation_filter_blocks,
    BreakEvenState, check_break_even,
    TimeExitState, check_time_exit,
    min_equity_gain_skip,
    SimConfig, Bar, simulate_trade,
)


# ============================================================================
# 1. Chandelier — ATR-smoothed
# ============================================================================
def test_chandelier_does_not_arm_below_min_move():
    state = ChandelierState()
    # entry 100, base stop 5%, current price barely above entry → unrealized 0.5%
    new_sl, state = atr_smoothed_chandelier_exit(
        direction="long", entry_price=100.0, base_stop_pct=0.05,
        bar_close=100.5, atr_value=2.0, chandelier_mult=1.5,
        min_move_r=0.5, state=state, current_dyn_stop=95.0,
    )
    assert not state.armed
    assert new_sl == 95.0  # no change


def test_chandelier_arms_and_tightens_long():
    state = ChandelierState()
    # entry 100, base 5%, min_move 0.5*0.05=2.5%; price up 3% → arms
    new_sl, state = atr_smoothed_chandelier_exit(
        direction="long", entry_price=100.0, base_stop_pct=0.05,
        bar_close=103.0, atr_value=2.0, chandelier_mult=1.5,
        min_move_r=0.5, state=state, current_dyn_stop=95.0,
    )
    assert state.armed
    assert state.best_close == 103.0
    # candidate = 103 - 1.5*2 = 100. > 95 → ratchet up
    assert abs(new_sl - 100.0) < 1e-9


def test_chandelier_only_ratchets_long_never_widens():
    state = ChandelierState()
    # First bar: arms at 103
    _, state = atr_smoothed_chandelier_exit(
        "long", 100.0, 0.05, 103.0, 2.0, 1.5, 0.5, state, 95.0,
    )
    # Second bar: lower close → best_close stays at 103, candidate stays = 100
    new_sl, state = atr_smoothed_chandelier_exit(
        "long", 100.0, 0.05, 102.0, 2.0, 1.5, 0.5, state, 100.0,
    )
    assert state.best_close == 103.0
    assert abs(new_sl - 100.0) < 1e-9
    # Third bar: lower again, but with tighter dyn_stop already → no widening
    new_sl, state = atr_smoothed_chandelier_exit(
        "long", 100.0, 0.05, 101.0, 2.0, 1.5, 0.5, state, 101.0,
    )
    assert new_sl == 101.0  # unchanged


def test_chandelier_short_direction():
    state = ChandelierState()
    # entry 100, short, base 5%, price down 3% → arms
    new_sl, state = atr_smoothed_chandelier_exit(
        "short", 100.0, 0.05, 97.0, 2.0, 1.5, 0.5, state, 105.0,
    )
    assert state.armed
    # candidate = 97 + 1.5*2 = 100, < 105 → ratchet down
    assert abs(new_sl - 100.0) < 1e-9


def test_compute_atr_basic():
    highs = [10, 11, 12, 13, 14]
    lows = [9, 10, 11, 12, 13]
    closes = [9.5, 10.5, 11.5, 12.5, 13.5]
    a = compute_atr(highs, lows, closes, period=4)
    assert a is not None
    assert a > 0


# ============================================================================
# 2. Adaptive Position Sizing
# ============================================================================
def test_adaptive_sizing_no_config_returns_base():
    eff = adaptive_position_sizing(base_risk_frac=0.4, equity=1.05, peak_equity=1.05)
    assert abs(eff - 0.4) < 1e-9


def test_adaptive_sizing_tier_applied():
    tiers = [
        {"equityAbove": 0.0, "factor": 0.75},
        {"equityAbove": 0.03, "factor": 1.125},
        {"equityAbove": 0.08, "factor": 0.375},
    ]
    eff = adaptive_position_sizing(0.4, equity=1.05, peak_equity=1.05, adaptive_tiers=tiers)
    # Highest met threshold = 0.03 → factor 1.125
    assert abs(eff - 0.4 * 1.125) < 1e-9


def test_adaptive_sizing_pdd_throttle_tightens():
    eff = adaptive_position_sizing(
        0.4, equity=1.04, peak_equity=1.10,
        peak_drawdown_throttle={"fromPeak": 0.03, "factor": 0.5},
    )
    # fromPeak = (1.10 - 1.04)/1.10 = 0.0545 > 0.03 → factor 0.5
    assert abs(eff - 0.2) < 1e-9


def test_adaptive_sizing_kelly_multiplier_high_winrate():
    pnls = [0.01, 0.02, 0.01, -0.01, 0.02, 0.01, 0.02, 0.01]  # 7/8 wins = 0.875
    kelly = {
        "windowSize": 10,
        "minTrades": 5,
        "tiers": [
            {"winRateAbove": 0.7, "multiplier": 1.5},
            {"winRateAbove": 0.5, "multiplier": 1.0},
            {"winRateAbove": 0.0, "multiplier": 0.6},
        ],
    }
    eff = adaptive_position_sizing(0.4, equity=1.0, peak_equity=1.0, kelly_cfg=kelly, recent_pnls=pnls)
    assert abs(eff - 0.4 * 1.5) < 1e-9


def test_adaptive_sizing_live_cap_clamps():
    eff = adaptive_position_sizing(
        0.6, equity=1.0, peak_equity=1.0, live_max_risk_frac=0.4,
    )
    assert abs(eff - 0.4) < 1e-9


def test_kelly_window_trims():
    pnls = []
    for x in [0.01, 0.02, -0.01, 0.03, -0.02]:
        pnls = update_kelly_window(pnls, x, window_size=3)
    # Only last 3
    assert len(pnls) == 3
    assert pnls == [-0.01, 0.03, -0.02]


# ============================================================================
# 3. Partial Take Profit (incl. R12 same-bar fix)
# ============================================================================
def test_ptp_fires_on_intra_bar_high():
    state = PartialTPState()
    # entry 100, trigger 2% → 102. Bar high 102.5 — fires.
    fired, state = check_partial_take_profit(
        direction="long", entry_price=100.0,
        bar_high=102.5, bar_low=99.5, bar_close=100.0,
        trigger_pct=0.02, close_fraction=0.30, state=state,
    )
    assert fired
    assert state.triggered
    # Realized = 0.30 × 0.02 = 0.006
    assert abs(state.realized_pct - 0.006) < 1e-9


def test_ptp_does_not_double_fire():
    state = PartialTPState()
    check_partial_take_profit("long", 100, 105, 99, 100, 0.02, 0.3, state)
    fired2, state = check_partial_take_profit("long", 100, 110, 99, 100, 0.02, 0.3, state)
    assert not fired2  # already triggered


def test_ptp_blend_pnl():
    state = PartialTPState(triggered=True, realized_pct=0.006)
    # Final exit P&L = -0.005 (slight loss after PTP locked profit)
    blended = blend_partial_tp_pnl(raw_pnl=-0.005, ptp_state=state, close_fraction=0.30)
    # 0.006 + 0.70 × -0.005 = 0.006 - 0.0035 = 0.0025
    assert abs(blended - 0.0025) < 1e-9


def test_ptp_short_direction():
    state = PartialTPState()
    fired, state = check_partial_take_profit(
        "short", 100, 99.5, 97.5, 99, trigger_pct=0.02, close_fraction=0.5, state=state,
    )
    assert fired


# ============================================================================
# 4. HTF Trend Filter
# ============================================================================
def test_htf_skips_short_in_uptrend():
    closes = [100.0] * 50
    closes[-1] = 105.0  # +5% over 49 bars
    skip = htf_trend_filter(
        direction="short", closes=closes, current_idx=49,
        lookback_bars=49, threshold=0.03, apply="short",
    )
    assert skip


def test_htf_allows_short_in_downtrend():
    closes = [100.0] * 50
    closes[-1] = 95.0  # -5% trend → shorts welcome
    skip = htf_trend_filter("short", closes, 49, 49, 0.03, "short")
    assert not skip


def test_htf_no_history_no_gate():
    closes = [100.0, 105.0]
    skip = htf_trend_filter("short", closes, 1, lookback_bars=42, threshold=0.03, apply="short")
    assert not skip  # not enough bars → don't gate


def test_htf_apply_long_only():
    closes = [100.0] * 50
    closes[-1] = 90.0  # -10% downtrend
    # apply="long" → shorts are NOT gated
    skip_short = htf_trend_filter("short", closes, 49, 49, 0.03, "long")
    assert not skip_short
    # ... but longs ARE
    skip_long = htf_trend_filter("long", closes, 49, 49, 0.03, "long")
    assert skip_long


# ============================================================================
# 5. Loss Streak Cooldown
# ============================================================================
def test_loss_streak_increments_and_triggers_cooldown():
    s = LossStreakState()
    s = update_loss_streak(s, "stop", exit_bar=10, after_losses=2, cooldown_bars=6)
    assert s.streak == 1
    assert s.cooldown_until_bar == -1  # not yet
    s = update_loss_streak(s, "stop", exit_bar=11, after_losses=2, cooldown_bars=6)
    assert s.streak == 2
    assert s.cooldown_until_bar == 17  # 11 + 6


def test_loss_streak_resets_on_tp():
    s = LossStreakState(streak=2, cooldown_until_bar=20)
    s = update_loss_streak(s, "tp", exit_bar=15, after_losses=2, cooldown_bars=6)
    assert s.streak == 0


def test_is_in_cooldown():
    s = LossStreakState(streak=2, cooldown_until_bar=100)
    assert is_in_cooldown(s, 50)
    assert not is_in_cooldown(s, 100)
    assert not is_in_cooldown(s, 150)


# ============================================================================
# 6. Peak-Drawdown Throttle
# ============================================================================
def test_pdd_no_throttle_above_peak():
    f = compute_sizing_factor_from_pdd(equity=1.10, peak=1.10, from_peak_threshold=0.03, factor=0.5)
    assert f == 1.0


def test_pdd_throttle_engages_below_peak():
    f = compute_sizing_factor_from_pdd(equity=1.04, peak=1.10, from_peak_threshold=0.03, factor=0.5)
    # fromPeak = 0.0545, > 0.03 → throttle
    assert f == 0.5


def test_pdd_persisted_peak_ratchets_up_only():
    p = update_persisted_peak(1.05, 1.10)
    assert p == 1.10
    p2 = update_persisted_peak(1.10, 1.05)
    assert p2 == 1.10  # never goes down


# ============================================================================
# 7. Correlation Filter (MCT)
# ============================================================================
def test_correlation_filter_blocks_when_at_cap():
    assert correlation_filter_blocks("long", open_positions_same_dir=2, max_open_same_direction=2)
    assert not correlation_filter_blocks("long", open_positions_same_dir=1, max_open_same_direction=2)


# ============================================================================
# 8. Break-even
# ============================================================================
def test_break_even_moves_sl_to_entry_long():
    state = BreakEvenState()
    new_sl, state = check_break_even(
        direction="long", entry_price=100.0, bar_close=103.0,
        threshold=0.02, current_dyn_stop=95.0, state=state, sl_offset_pct=0.0,
    )
    assert state.moved
    assert abs(new_sl - 100.0) < 1e-9


def test_break_even_does_not_fire_below_threshold():
    state = BreakEvenState()
    new_sl, state = check_break_even(
        "long", 100.0, 101.0, 0.02, 95.0, state, sl_offset_pct=0.0,
    )
    assert not state.moved
    assert new_sl == 95.0


def test_break_even_one_shot():
    state = BreakEvenState()
    check_break_even("long", 100, 103, 0.02, 95, state, sl_offset_pct=0.0)
    new_sl, state = check_break_even("long", 100, 110, 0.02, 100, state, sl_offset_pct=0.0)
    # Already moved; subsequent calls are noops
    assert new_sl == 100


# ============================================================================
# 9. Time Exit
# ============================================================================
def test_time_exit_closes_when_no_gain_after_max_bars():
    state = TimeExitState()
    # Phase 10 (engine_features Bug 8): bars_held now mirrors `j - ebIdx`,
    # so on entry-bar barsHeld=0, after 4 elapsed bars barsHeld=4.
    # Need 5 iterations to reach barsHeld>=max=4.
    closed = False
    for _ in range(5):
        closed, state = check_time_exit(
            "long", entry_price=100.0, bar_close=99.5,
            base_stop_pct=0.05, max_bars_without_gain=4, min_gain_r=0.5, state=state,
        )
    assert closed
    assert not state.ever_reached_min_gain


def test_time_exit_does_not_close_after_min_gain_reached():
    state = TimeExitState()
    # First bar reaches gain
    _, state = check_time_exit("long", 100.0, 103.0, 0.05, 4, 0.5, state)
    assert state.ever_reached_min_gain
    # Subsequent bars don't trigger close even if max_bars exceeded
    closed = False
    for _ in range(10):
        closed, state = check_time_exit("long", 100.0, 99.5, 0.05, 4, 0.5, state)
    assert not closed


# ============================================================================
# 10. minEquityGain
# ============================================================================
def test_min_equity_gain_skip_blocks_underwater():
    assert min_equity_gain_skip(equity=1.005, min_equity_gain=0.02)  # below 2%
    assert not min_equity_gain_skip(equity=1.025, min_equity_gain=0.02)
    assert not min_equity_gain_skip(equity=1.0, min_equity_gain=None)


def test_min_equity_gain_max_gates_too_high_equity():
    assert min_equity_gain_skip(equity=1.10, min_equity_gain=0.02, max_equity_gain=0.08)


# ============================================================================
# Bar-by-bar simulator (used by parity_check.py)
# ============================================================================
def _make_bars(closes: list[float]) -> list[Bar]:
    """Construct bars where high=close*1.01, low=close*0.99, open=prev_close."""
    bars = []
    prev = closes[0]
    for c in closes:
        bars.append(Bar(open=prev, high=c * 1.005, low=c * 0.995, close=c))
        prev = c
    return bars


def test_simulate_trade_hits_tp_long():
    bars = _make_bars([100, 101, 102, 103, 104, 105, 110])  # rises strongly
    cfg = SimConfig(stop_pct=0.02, tp_pct=0.05, hold_bars=10)
    trade = simulate_trade("long", bars, entry_idx=1, cfg=cfg)
    assert trade is not None
    assert trade.exit_reason == "tp"
    assert trade.raw_pnl > 0


def test_simulate_trade_hits_stop_long():
    bars = _make_bars([100, 99, 98, 97, 96, 90])  # falls
    cfg = SimConfig(stop_pct=0.02, tp_pct=0.05, hold_bars=10)
    trade = simulate_trade("long", bars, entry_idx=1, cfg=cfg)
    assert trade is not None
    assert trade.exit_reason == "stop"
    assert trade.raw_pnl < 0


def test_simulate_trade_with_chandelier_protects_profit():
    # Run up to 105, then drop sharply → chandelier should exit at trailing SL
    closes = [100, 101, 103, 105, 105, 105, 100, 95]
    bars = _make_bars(closes)
    cfg = SimConfig(
        stop_pct=0.05, tp_pct=0.20, hold_bars=20,
        chandelier={"period": 3, "mult": 1.5, "minMoveR": 0.3},
    )
    trade = simulate_trade("long", bars, entry_idx=1, cfg=cfg)
    assert trade is not None
    # Without chandelier, the 95 close would be near base stop (-5%).
    # With chandelier, exit should be earlier (better) than base stop.


def test_simulate_trade_ptp_blends_pnl():
    bars = _make_bars([100, 101, 102.5, 102.5, 100, 98])  # PTP @ 2%, then drift back
    cfg = SimConfig(
        stop_pct=0.05, tp_pct=0.10, hold_bars=10,
        partial_take_profit={"triggerPct": 0.02, "closeFraction": 0.30},
    )
    trade = simulate_trade("long", bars, entry_idx=1, cfg=cfg)
    assert trade is not None
    assert trade.ptp_triggered


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))


# ============================================================================
# Coverage-gap tests (Round 3, audit-driven)
# ============================================================================

# --- compute_atr edge cases -------------------------------------------------
def test_compute_atr_returns_none_on_insufficient_history():
    # period=10 needs 11 bars
    assert compute_atr([1, 2], [0.5, 1.5], [0.8, 1.2], period=10) is None


def test_compute_atr_returns_none_on_mismatched_lengths():
    # length mismatch: highs has 5, lows has 4 → guard returns None
    assert compute_atr([1, 2, 3, 4, 5], [0.5, 1, 2, 3], [1, 2, 3, 4, 5], period=3) is None


# --- adaptive_position_sizing — MAX_FACTOR cap (R13 audit Bug B3) -----------
def test_adaptive_sizing_max_factor_cap_prevents_stacking():
    """Time-boost(2) + Kelly(1.5) would multiply to factor=3 — capped at 4 ok,
    but combined with adaptive tier=2 would become 6 → MUST clamp to 4."""
    pnls = [0.01] * 8  # 100% wins → top Kelly tier
    eff = adaptive_position_sizing(
        base_risk_frac=0.4,
        equity=1.01, peak_equity=1.01, challenge_day=10,
        adaptive_tiers=[{"equityAbove": 0.0, "factor": 2.0}],
        time_boost={"afterDay": 5, "equityBelow": 0.05, "factor": 3.0},
        kelly_cfg={
            "windowSize": 10, "minTrades": 5,
            "tiers": [{"winRateAbove": 0.5, "multiplier": 2.0}],
        },
        recent_pnls=pnls,
    )
    # Without cap: 0.4 * 3.0 * 2.0 = 2.4. With MAX_FACTOR=4 cap: 0.4 * 4.0 = 1.6
    assert abs(eff - 1.6) < 1e-9


def test_adaptive_sizing_drawdown_shield_tightens():
    eff = adaptive_position_sizing(
        0.4, equity=0.97, peak_equity=1.0,
        drawdown_shield={"belowEquity": -0.02, "factor": 0.25},
    )
    # equity-1 = -0.03 ≤ -0.02 → factor = min(1.0, 0.25) = 0.25
    assert abs(eff - 0.4 * 0.25) < 1e-9


def test_adaptive_sizing_time_boost_does_not_decrease_factor():
    """time_boost has factor 0.5 but base tier already gave 1.5 → must NOT
    decrease (time_boost only INCREASES per spec)."""
    eff = adaptive_position_sizing(
        0.4, equity=1.01, peak_equity=1.01, challenge_day=10,
        adaptive_tiers=[{"equityAbove": 0.0, "factor": 1.5}],
        time_boost={"afterDay": 5, "equityBelow": 0.10, "factor": 0.5},
    )
    assert abs(eff - 0.4 * 1.5) < 1e-9  # tier wins


def test_adaptive_sizing_kelly_below_min_trades_skipped():
    """fewer than minTrades → Kelly multiplier MUST not apply."""
    eff = adaptive_position_sizing(
        0.4, equity=1.0, peak_equity=1.0,
        kelly_cfg={
            "windowSize": 10, "minTrades": 10,
            "tiers": [{"winRateAbove": 0.0, "multiplier": 2.0}],
        },
        recent_pnls=[0.01, 0.01, 0.01],  # only 3 — below minTrades
    )
    assert abs(eff - 0.4) < 1e-9  # base only


def test_adaptive_sizing_negative_eff_clamped_to_zero():
    """Pathological negative factor must clamp to 0 (no negative-size trades)."""
    eff = adaptive_position_sizing(
        base_risk_frac=-0.5, equity=1.0, peak_equity=1.0,
    )
    assert eff == 0.0


# --- htf_trend_filter — apply="both" + base==0 ------------------------------
def test_htf_apply_both_gates_both_directions():
    closes_up = [100.0] * 50
    closes_up[-1] = 110.0  # +10% uptrend
    assert htf_trend_filter("short", closes_up, 49, 49, 0.03, "both")
    assert not htf_trend_filter("long", closes_up, 49, 49, 0.03, "both")
    closes_down = [100.0] * 50
    closes_down[-1] = 90.0
    assert htf_trend_filter("long", closes_down, 49, 49, 0.03, "both")


def test_htf_zero_base_returns_no_gate():
    closes = [0.0] + [100.0] * 49  # base==0
    assert not htf_trend_filter("short", closes, 49, 49, 0.03, "short")


# --- check_partial_take_profit — closeFraction<=0 / trigger<=0 disable ------
def test_ptp_disabled_when_close_fraction_zero():
    state = PartialTPState()
    fired, state = check_partial_take_profit(
        "long", 100.0, 105.0, 99.0, 102.0,
        trigger_pct=0.02, close_fraction=0.0, state=state,
    )
    assert not fired
    assert not state.triggered


def test_ptp_close_fallback_fires_when_intra_bar_misses():
    """High doesn't reach trigger but bar.close does (rare but in spec)."""
    state = PartialTPState()
    # entry=100, trigger 2% → 102. high=101.5 (intra-bar miss), close=102.5 → fallback fires
    fired, state = check_partial_take_profit(
        "long", 100.0, 101.5, 99.0, 102.5,
        trigger_pct=0.02, close_fraction=0.30, state=state,
    )
    assert fired


# --- min_equity_gain_skip — None-tolerance ----------------------------------
def test_min_equity_gain_skip_none_max_only_min_acts():
    assert not min_equity_gain_skip(equity=2.0, min_equity_gain=0.02, max_equity_gain=None)


# --- simulate_trade — atr-stop liveCap rejection ----------------------------
def test_simulate_trade_rejects_when_atr_stop_exceeds_live_cap():
    """If ATR-stop fraction > liveMaxStopPct, simulate_trade returns None."""
    # 10 flat bars then volatile spike to inflate ATR
    closes = [100.0] * 10 + [120.0]
    bars = []
    prev = closes[0]
    for i, c in enumerate(closes):
        # Wide ranges → big ATR
        bars.append(Bar(open=prev, high=c * 1.10, low=c * 0.90, close=c))
        prev = c
    cfg = SimConfig(
        stop_pct=0.01, tp_pct=0.05, hold_bars=5,
        atr_stop={"period": 5, "stopMult": 5.0},  # huge → forces eff_stop big
        live_max_stop_pct=0.02,                   # tight cap
    )
    trade = simulate_trade("long", bars, entry_idx=10, cfg=cfg)
    assert trade is None


def test_simulate_trade_returns_none_if_entry_beyond_bars():
    bars = _make_bars([100, 101, 102])
    cfg = SimConfig(stop_pct=0.02, tp_pct=0.05, hold_bars=5)
    assert simulate_trade("long", bars, entry_idx=99, cfg=cfg) is None


def test_simulate_trade_short_hits_tp():
    # Falls 5% — short TP at -5%
    bars = _make_bars([100, 99, 97, 95, 92, 90])
    cfg = SimConfig(stop_pct=0.05, tp_pct=0.05, hold_bars=10)
    trade = simulate_trade("short", bars, entry_idx=1, cfg=cfg)
    assert trade is not None
    assert trade.exit_reason == "tp"
    assert trade.raw_pnl > 0


def test_simulate_trade_time_exit_path_taken():
    """Flat market → no TP, no stop → time-exit closes position."""
    # 10 flat bars at exactly 100 → unrealized always 0 → time exit fires
    bars = _make_bars([100.0] * 10)
    cfg = SimConfig(
        stop_pct=0.05, tp_pct=0.05, hold_bars=8,
        time_exit={"maxBarsWithoutGain": 3, "minGainR": 0.5},
    )
    trade = simulate_trade("long", bars, entry_idx=1, cfg=cfg)
    assert trade is not None
    assert trade.exit_reason == "time"


# --- update_persisted_peak idempotent ---------------------------------------
def test_update_persisted_peak_equal_value():
    assert update_persisted_peak(1.05, 1.05) == 1.05
