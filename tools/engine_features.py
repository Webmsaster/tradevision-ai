"""
Pure-Python implementations of the V4 backtest engine features that drive the
30pp Backtest↔Live drift seen in V5_QUARTZ_LITE / R28.

Each function mirrors EXACTLY the corresponding logic in
`src/utils/ftmoDaytrade24h.ts` so the Python executor reaches feature-parity
with the TS engine. The functions here are PURE — no MT5 calls, no JSON I/O,
no globals — so they can be unit-tested and run identically inside both:

  1. Live tick-loop in `ftmo_executor.py` (per-bar / per-poll evaluation)
  2. Bar-by-bar parity check `parity_check.py` against the TS engine

This is the heart of the Round 25/26/27 quick-win: bring chandelier,
adaptiveSizing, htfTrendFilter, lossStreakCooldown, peakDrawdownThrottle and
correlationFilter — currently ONLY in the TS engine — into the live loop so
the bot's behavior matches the 53–71% backtest claim instead of drifting
30pp downward in production.

Phase 34 (Code-Quality Audit refactor): line-number anchors are inherently
fragile (drift after every edit upstream). Each TS-mirror reference below
points to a stable feature anchor — a unique search-string in
`src/utils/ftmoDaytrade24h.ts` that survives refactors as long as the
feature itself exists. To find the corresponding TS code: open
`ftmoDaytrade24h.ts` and search for the quoted anchor text.

TS feature anchors (stable across refactors — search in ftmoDaytrade24h.ts):
  - chandelier           → `if (cfg.chandelierExit)`
  - adaptiveSizing       → `if (cfg.adaptiveSizing && cfg.adaptiveSizing.length > 0)`
  - kellySizing          → `if (cfg.kellySizing && recentPnls.length`
  - peakDrawdownThrottle → `if (cfg.peakDrawdownThrottle)`
  - htfTrendFilter       → `if (cfg.htfTrendFilter)`
  - lossStreakCooldown   → `if (cfg.lossStreakCooldown)`
  - correlationFilter    → `if (cfg.correlationFilter)`
  - breakEven            → `if (cfg.breakEven`
  - timeExit             → `if (cfg.timeExit`
  - partialTakeProfit    → `if (cfg.partialTakeProfit`
  - minEquityGain        → `minEquityGain`

Run `tools/parity_check.py` to verify Python↔TS feature-parity end-to-end
after any change here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple


# =============================================================================
# 1. ATR-smoothed Chandelier Exit
# =============================================================================
@dataclass
class ChandelierState:
    """Per-trade chandelier-exit running state.

    Mirrors `chanArmed` / `chanBestClose` / `dynStop` in TS engine.
    TS anchor: search `if (cfg.chandelierExit)` in ftmoDaytrade24h.ts.
    """
    armed: bool = False
    best_close: Optional[float] = None  # highest (long) or lowest (short) close-since-entry


def atr_smoothed_chandelier_exit(
    direction: str,             # "long" | "short"
    entry_price: float,
    base_stop_pct: float,       # cfg.stopPct (NOT effStop — Round 35 fix)
    bar_close: float,
    atr_value: float,           # ATR(period) at this bar (period=56 default)
    chandelier_mult: float,     # cfg.chandelierExit.mult (e.g. 1.5)
    min_move_r: float,          # cfg.chandelierExit.minMoveR (default 0.5)
    state: ChandelierState,
    current_dyn_stop: float,    # current SL (entry-based or earlier-trailed)
) -> Tuple[float, ChandelierState]:
    """ATR-smoothed trailing stop (one-bar update).

    Returns (new_dyn_stop, updated_state). Only TIGHTENS dyn_stop, never
    loosens. Matches `applyChandelierExit` semantics in the TS engine.
    """
    if atr_value <= 0 or chandelier_mult <= 0 or entry_price <= 0:
        return current_dyn_stop, state

    if direction == "long":
        unrealized = (bar_close - entry_price) / entry_price
    else:
        unrealized = (entry_price - bar_close) / entry_price

    min_move_abs = min_move_r * base_stop_pct

    # Arm only after favorable move. Once armed, stays armed for the trade.
    if unrealized >= min_move_abs:
        state.armed = True
        if direction == "long":
            if state.best_close is None or bar_close > state.best_close:
                state.best_close = bar_close
        else:
            if state.best_close is None or bar_close < state.best_close:
                state.best_close = bar_close

    if not state.armed or state.best_close is None:
        return current_dyn_stop, state

    if direction == "long":
        candidate = state.best_close - chandelier_mult * atr_value
        if candidate > current_dyn_stop:
            return candidate, state
    else:
        candidate = state.best_close + chandelier_mult * atr_value
        if candidate < current_dyn_stop:
            return candidate, state

    return current_dyn_stop, state


def compute_atr(highs: List[float], lows: List[float], closes: List[float], period: int) -> Optional[float]:
    """Wilder's ATR over the last `period` bars. Returns None if not enough data.

    True Range = max(high-low, |high-prev_close|, |low-prev_close|).
    Smoothed by simple-mean (engine uses simple-mean ATR, not RMA).
    """
    n = len(closes)
    if n < period + 1 or len(highs) != n or len(lows) != n:
        return None
    trs: List[float] = []
    for i in range(n - period, n):
        if i == 0:
            tr = highs[i] - lows[i]
        else:
            prev_c = closes[i - 1]
            tr = max(highs[i] - lows[i], abs(highs[i] - prev_c), abs(lows[i] - prev_c))
        trs.append(tr)
    return sum(trs) / period


# =============================================================================
# 2. Adaptive Position Sizing (equity-tier + Kelly-multiplier + pDD throttle)
# =============================================================================
def adaptive_position_sizing(
    base_risk_frac: float,
    equity: float,                        # account equity FRACTION (e.g. 1.05 = +5%)
    peak_equity: float,                   # max equity ever seen
    adaptive_tiers: Optional[List[dict]] = None,        # [{equityAbove, factor}, ...]
    time_boost: Optional[dict] = None,                  # {afterDay, equityBelow, factor}
    challenge_day: int = 0,
    kelly_cfg: Optional[dict] = None,                   # {windowSize, minTrades, tiers}
    recent_pnls: Optional[List[float]] = None,          # rolling PnL window — must be PRE-FILTERED by caller for closeTime < currentEntryTime (no lookahead)
    drawdown_shield: Optional[dict] = None,             # {belowEquity, factor}
    peak_drawdown_throttle: Optional[dict] = None,      # {fromPeak, factor}
    live_max_risk_frac: Optional[float] = None,         # cfg.liveCaps.maxRiskFrac
) -> float:
    """Compute the effective per-trade risk_frac applying ALL sizing rules.

    Mirrors TS engine equity-loop sizing block in the SAME ORDER
    (critical: order matters because each step is a min/multiply).
    TS anchor: search `if (cfg.adaptiveSizing && cfg.adaptiveSizing.length > 0)`
    in ftmoDaytrade24h.ts; this Python function reproduces the chain that
    follows down to the `liveCaps` clamp.

    Order:
      1. base factor = 1.0
      2. adaptiveSizing tier (highest met threshold wins)
      3. timeBoost override (only if it would INCREASE)
      4. kellySizing multiplier (rolling win-rate)
      5. drawdownShield (Math.min — only tightens)
      6. peakDrawdownThrottle (Math.min — only tightens)
      7. live_max_risk_frac clamp (Math.min)
    """
    factor = 1.0

    # 2. Adaptive tier
    if adaptive_tiers:
        for tier in adaptive_tiers:
            if equity - 1 >= tier["equityAbove"]:
                factor = tier["factor"]

    # 3. Time-boost (only INCREASES; never tightens)
    if time_boost:
        if (
            challenge_day >= time_boost["afterDay"]
            and equity - 1 < time_boost["equityBelow"]
            and time_boost["factor"] > factor
        ):
            factor = time_boost["factor"]

    # 4. Kelly multiplier
    if kelly_cfg and recent_pnls is not None and len(recent_pnls) >= kelly_cfg.get("minTrades", 5):
        wins = sum(1 for p in recent_pnls if p > 0)
        wr = wins / len(recent_pnls)
        sorted_tiers = sorted(kelly_cfg["tiers"], key=lambda t: -t["winRateAbove"])
        for t in sorted_tiers:
            if wr >= t["winRateAbove"]:
                factor *= t["multiplier"]
                break

    # Phase 10 (engine_features Bug 5): MAX_FACTOR cap added by R13 Cascade
    # Audit Bug B3 — without this, a hot streak combining Kelly(1.5) +
    # timeBoost(2) + base(2) = factor 6 stacks into catastrophic risk.
    # Hard ceiling at 4. TS anchor: search `MAX_FACTOR` in ftmoDaytrade24h.ts.
    MAX_FACTOR = 4.0
    factor = min(factor, MAX_FACTOR)

    # 5. Drawdown shield (Math.min — only tightens)
    if drawdown_shield and equity - 1 <= drawdown_shield["belowEquity"]:
        factor = min(factor, drawdown_shield["factor"])

    # 6. Peak-relative DD throttle
    if peak_drawdown_throttle and peak_equity > 0:
        from_peak = (peak_equity - equity) / peak_equity
        if from_peak >= peak_drawdown_throttle["fromPeak"]:
            factor = min(factor, peak_drawdown_throttle["factor"])

    eff_risk = base_risk_frac * factor
    if eff_risk < 0:
        eff_risk = 0.0

    # 7. Live cap
    if live_max_risk_frac is not None:
        eff_risk = min(eff_risk, live_max_risk_frac)
    return eff_risk


def update_kelly_window(recent_pnls: List[float], new_pnl: float, window_size: int) -> List[float]:
    """Append new PnL and trim oldest if window exceeded.
    TS anchor: search `recentPnls.push` in ftmoDaytrade24h.ts (the Kelly
    rolling-window update inside the trade-close block).
    """
    recent_pnls.append(new_pnl)
    while len(recent_pnls) > window_size:
        recent_pnls.pop(0)
    return recent_pnls


# =============================================================================
# 3. Partial Take Profit (with R12 same-bar fix)
# =============================================================================
@dataclass
class PartialTPState:
    triggered: bool = False
    realized_pct: float = 0.0   # signed P&L locked from the partial close


def check_partial_take_profit(
    direction: str,
    entry_price: float,
    bar_high: float,
    bar_low: float,
    bar_close: float,
    trigger_pct: float,
    close_fraction: float,
    state: PartialTPState,
) -> Tuple[bool, PartialTPState]:
    """One-shot PTP. Fires if intra-bar high/low crosses trigger_price.

    R12 audit fix: we MUST check intra-bar high/low before stop/tp, not only
    end-of-bar close. Otherwise a same-bar win-then-stop closes the FULL
    position when 30% should be locked.
    TS anchor: search `if (cfg.partialTakeProfit` in ftmoDaytrade24h.ts —
    the same-bar PTP-then-stop tie-break logic mirrors that block exactly.

    Returns (fired_this_bar, updated_state).
    """
    if state.triggered or close_fraction <= 0 or trigger_pct <= 0:
        return False, state

    if direction == "long":
        trigger_price = entry_price * (1 + trigger_pct)
        hit = bar_high >= trigger_price
    else:
        trigger_price = entry_price * (1 - trigger_pct)
        hit = bar_low <= trigger_price

    if not hit:
        # End-of-bar close fallback (TS engine does both checks)
        if direction == "long":
            unrealized = (bar_close - entry_price) / entry_price
        else:
            unrealized = (entry_price - bar_close) / entry_price
        if unrealized >= trigger_pct:
            hit = True

    if hit:
        state.triggered = True
        # Locks `closeFraction × triggerPct` of P&L from the closed slice.
        state.realized_pct = close_fraction * trigger_pct
        return True, state

    return False, state


def blend_partial_tp_pnl(raw_pnl: float, ptp_state: PartialTPState, close_fraction: float) -> float:
    """Apply P&L-blending after PTP fired:

      effPnL = closeFraction × triggerPct + (1 - closeFraction) × actual_exit_pnl

    TS anchor: search `partialTakeProfit fired` in ftmoDaytrade24h.ts (the
    blended-PnL block at trade-close after PTP).
    """
    if not ptp_state.triggered:
        return raw_pnl
    return ptp_state.realized_pct + (1 - close_fraction) * raw_pnl


# =============================================================================
# 4. HTF Trend Filter
# =============================================================================
def htf_trend_filter(
    direction: str,
    closes: List[float],          # sufficient history (>= lookback_bars + 1)
    current_idx: int,             # signal-bar index in `closes`
    lookback_bars: int,
    threshold: float,
    apply: str = "short",         # "long" | "short" | "both"
) -> bool:
    """Returns True if the signal SHOULD be SKIPPED (i.e. trend goes the
    wrong way).

    For SHORTS: skip if change > +threshold (don't short in uptrend).
    For LONGS:  skip if change < -threshold (don't long in downtrend).

    TS anchor: search `if (cfg.htfTrendFilter)` in ftmoDaytrade24h.ts.
    """
    if current_idx < lookback_bars:
        return False  # not enough history → don't gate
    base = closes[current_idx - lookback_bars]
    if base == 0:
        return False
    change = (closes[current_idx] - base) / base
    gate_longs = apply in ("long", "both")
    gate_shorts = apply in ("short", "both")
    if direction == "short" and gate_shorts and change > threshold:
        return True
    if direction == "long" and gate_longs and change < -threshold:
        return True
    return False


# =============================================================================
# 5. Loss-Streak Cooldown
# =============================================================================
@dataclass
class LossStreakState:
    streak: int = 0
    cooldown_until_bar: int = -1   # bar index past which entries are gated


def update_loss_streak(state: LossStreakState, exit_reason: str, exit_bar: int, after_losses: int, cooldown_bars: int) -> LossStreakState:
    """Update state after a trade closes.

    - Stop-out: increment streak; if >= afterLosses, set cooldown to exit_bar + cooldownBars
    - TP / time exit: reset streak to 0

    TS anchor: search `if (cfg.lossStreakCooldown)` in ftmoDaytrade24h.ts —
    the trade-close branch that updates `lscStreak` / `cooldownUntilBar`.
    """
    if exit_reason == "stop":
        state.streak += 1
        if state.streak >= after_losses:
            state.cooldown_until_bar = exit_bar + cooldown_bars
    else:
        state.streak = 0
    return state


def is_in_cooldown(state: LossStreakState, current_bar: int) -> bool:
    """Returns True if entries are gated.
    TS anchor: search `i < cooldownUntilBar` in ftmoDaytrade24h.ts (the
    LSC entry-gate inside the per-bar entry loop)."""
    return current_bar < state.cooldown_until_bar


# =============================================================================
# 6. Peak-Drawdown Throttle Persistence (challenge-peak.json)
# =============================================================================
def compute_sizing_factor_from_pdd(
    equity: float,                # account equity fraction (1.0 = start)
    peak: float,                  # persisted peak fraction
    from_peak_threshold: float,
    factor: float,
) -> float:
    """Returns the multiplier (1.0 if pDD not triggered, factor if triggered).

    Persistence happens in caller via challenge-peak.json (V231 round-35
    mechanism). TS anchor: search `if (cfg.peakDrawdownThrottle)` in
    ftmoDaytrade24h.ts.
    """
    if peak <= 0:
        return 1.0
    from_peak = (peak - equity) / peak
    if from_peak >= from_peak_threshold:
        return factor
    return 1.0


def update_persisted_peak(current_peak: float, new_equity: float) -> float:
    """Ratchet the peak only upward. Persisted to challenge-peak.json."""
    return max(current_peak, new_equity)


# =============================================================================
# 7. MCT (Multi-Crypto-Tracker) Correlation Filter
# =============================================================================
def correlation_filter_blocks(
    direction: str,
    open_positions_same_dir: int,
    max_open_same_direction: int,
) -> bool:
    """Returns True if entry should be SKIPPED.

    `open_positions_same_dir` counts positions currently open across the
    asset universe in the same direction.
    TS anchor: search `if (cfg.correlationFilter)` in ftmoDaytrade24h.ts.
    """
    return open_positions_same_dir >= max_open_same_direction


# =============================================================================
# 8. Break-Even Move (with R12 same-bar audit)
# =============================================================================
@dataclass
class BreakEvenState:
    moved: bool = False


def check_break_even(
    direction: str,
    entry_price: float,
    bar_close: float,
    threshold: float,
    current_dyn_stop: float,
    state: BreakEvenState,
    sl_offset_pct: float = 0.0005,   # +0.05% nudge above entry on long, -0.05% below entry on short
) -> Tuple[float, BreakEvenState]:
    """Move SL to entry + small offset once unrealized P&L >= threshold.

    One-shot.
    TS anchor: search `if (cfg.breakEven` in ftmoDaytrade24h.ts.

    NOTE — TS engine moves SL to exactly `entry`. The `sl_offset_pct` here is
    a small live-execution buffer (default +0.05%) used by the Python
    executor only. Set to 0 to match TS exactly (used by parity_check).
    """
    if state.moved or threshold <= 0:
        return current_dyn_stop, state
    if direction == "long":
        unrealized = (bar_close - entry_price) / entry_price
    else:
        unrealized = (entry_price - bar_close) / entry_price
    if unrealized < threshold:
        return current_dyn_stop, state

    if direction == "long":
        new_sl = entry_price * (1 + sl_offset_pct)
        if new_sl > current_dyn_stop:
            state.moved = True
            return new_sl, state
    else:
        new_sl = entry_price * (1 - sl_offset_pct)
        if new_sl < current_dyn_stop:
            state.moved = True
            return new_sl, state
    state.moved = True  # already at/above entry — mark done
    return current_dyn_stop, state


# =============================================================================
# 9. Time Exit (triple-barrier, de Prado)
# =============================================================================
@dataclass
class TimeExitState:
    bars_held: int = 0
    ever_reached_min_gain: bool = False


def check_time_exit(
    direction: str,
    entry_price: float,
    bar_close: float,
    base_stop_pct: float,
    max_bars_without_gain: int,
    min_gain_r: float,
    state: TimeExitState,
) -> Tuple[bool, TimeExitState]:
    """Returns (should_close_now, updated_state).

    Closes if `max_bars_without_gain` bars have elapsed AND price never
    reached `min_gain_r × stopPct` favorable.
    TS anchor: search `if (cfg.timeExit` in ftmoDaytrade24h.ts.
    """
    # Phase 10 (engine_features Bug 8): TS-Engine uses `barsHeld = j - ebIdx`,
    # so on entry-bar barsHeld=0. Python was incrementing BEFORE the check,
    # closing 1 bar earlier than TS → ~5-8% spurious 'time' exits, missing
    # the TP that would have fired on the held-1-bar-longer side.
    # Increment AFTER check below.
    if direction == "long":
        unrealized = (bar_close - entry_price) / entry_price
    else:
        unrealized = (entry_price - bar_close) / entry_price
    min_gain_abs = min_gain_r * base_stop_pct
    if unrealized >= min_gain_abs:
        state.ever_reached_min_gain = True
    if state.bars_held >= max_bars_without_gain and not state.ever_reached_min_gain:
        return True, state
    # Increment AFTER the check, mirroring TS j-ebIdx loop ordering.
    state.bars_held += 1
    return False, state


# =============================================================================
# 10. minEquityGain Skip (per-asset activation gate)
# =============================================================================
def min_equity_gain_skip(
    equity: float,
    min_equity_gain: Optional[float],
    max_equity_gain: Optional[float] = None,
) -> bool:
    """Returns True if entry should be SKIPPED.
    TS anchor: search `minEquityGain` in ftmoDaytrade24h.ts (the per-asset
    activation gate inside the entry loop).
    """
    if min_equity_gain is not None and equity - 1 < min_equity_gain:
        return True
    if max_equity_gain is not None and equity - 1 > max_equity_gain:
        return True
    return False


# =============================================================================
# Bar-by-bar trade simulator — used by parity_check.py
# =============================================================================
@dataclass
class SimulatedTrade:
    direction: str
    entry_idx: int
    entry_price: float
    exit_idx: int = 0
    exit_price: float = 0.0
    raw_pnl: float = 0.0
    eff_pnl: float = 0.0
    exit_reason: str = "time"          # "tp" | "stop" | "time"
    ptp_triggered: bool = False
    chandelier_armed: bool = False
    break_even_moved: bool = False


@dataclass
class SimConfig:
    """Subset of FtmoDaytrade24hConfig fields exercised by parity check."""
    stop_pct: float
    tp_pct: float
    hold_bars: int
    leverage: float = 1.0
    risk_frac: float = 1.0
    cost_bp: float = 0.0
    chandelier: Optional[dict] = None              # {period, mult, minMoveR}
    partial_take_profit: Optional[dict] = None     # {triggerPct, closeFraction}
    break_even: Optional[dict] = None              # {threshold}
    time_exit: Optional[dict] = None               # {maxBarsWithoutGain, minGainR}
    atr_stop: Optional[dict] = None                # {period, stopMult}
    live_max_stop_pct: Optional[float] = None
    live_max_risk_frac: Optional[float] = None


@dataclass
class Bar:
    open: float
    high: float
    low: float
    close: float


def simulate_trade(
    direction: str,
    bars: List[Bar],
    entry_idx: int,
    cfg: SimConfig,
) -> Optional[SimulatedTrade]:
    """Bar-by-bar trade simulation matching the TS engine inner loop.
    TS anchor: search `// === Inner: per-bar PnL` (or the comment-block at
    the top of the entry-execution loop) in ftmoDaytrade24h.ts. Returns
    None if trade cannot be opened (e.g. liveCaps reject, entry beyond
    bar list).

    This is the SHARED reference simulator used both for parity validation
    and for live in-memory replay if needed.
    """
    if entry_idx >= len(bars):
        return None
    eb = bars[entry_idx]
    entry = eb.open
    cost = cfg.cost_bp / 10000
    entry_eff = entry * (1 + cost / 2) if direction == "long" else entry * (1 - cost / 2)

    # Effective stop (atrStop floor)
    eff_stop = cfg.stop_pct
    if cfg.atr_stop:
        # Compute ATR from history up to entry_idx (inclusive). compute_atr
        # needs period+1 bars, so we slice [entry_idx-period:entry_idx+1].
        period = cfg.atr_stop["period"]
        if entry_idx >= period:
            highs = [b.high for b in bars[entry_idx - period:entry_idx + 1]]
            lows = [b.low for b in bars[entry_idx - period:entry_idx + 1]]
            closes = [b.close for b in bars[entry_idx - period:entry_idx + 1]]
            a = compute_atr(highs, lows, closes, period)
            if a is not None:
                atr_frac = (cfg.atr_stop["stopMult"] * a) / entry
                if atr_frac > eff_stop:
                    eff_stop = atr_frac

    # Live cap rejects oversized stops
    if cfg.live_max_stop_pct is not None and eff_stop > cfg.live_max_stop_pct:
        return None

    eff_tp = cfg.tp_pct
    tp = entry * (1 + eff_tp) if direction == "long" else entry * (1 - eff_tp)
    stop = entry * (1 - eff_stop) if direction == "long" else entry * (1 + eff_stop)
    mx = min(entry_idx + cfg.hold_bars, len(bars) - 1)

    dyn_stop = stop
    chan_state = ChandelierState()
    ptp_state = PartialTPState()
    be_state = BreakEvenState()
    te_state = TimeExitState()

    exit_idx = mx
    exit_price = bars[mx].close
    exit_reason = "time"

    for j in range(entry_idx, mx + 1):
        bar = bars[j]
        # Phase 16 (engine_features Bugs 1+2+3): mirror TS engine 4198-4304
        # tie-break order EXACTLY:
        #   1. gap-past-TP wins if bar.open already past TP.
        #   2. stop hits before PTP UNLESS gap-past-PTP.
        #   3. stop fill = bar.open if gap-down, else dyn_stop.
        #   4. PTP fires → auto-move dyn_stop to BE+cost (Bug 1).
        #   5. plain TP if no stop/PTP intervened.
        if direction == "long":
            stop_hit = bar.low <= dyn_stop
            tp_hit = bar.high >= tp
            ptp_trigger_price = entry * (1 + (cfg.partial_take_profit["triggerPct"] if cfg.partial_take_profit else 0))
            ptp_hit = bool(cfg.partial_take_profit) and not ptp_state.triggered and bar.high >= ptp_trigger_price
            gap_past_tp = bar.open >= tp
            gap_past_ptp = bool(cfg.partial_take_profit) and bar.open >= ptp_trigger_price
        else:
            stop_hit = bar.high >= dyn_stop
            tp_hit = bar.low <= tp
            ptp_trigger_price = entry * (1 - (cfg.partial_take_profit["triggerPct"] if cfg.partial_take_profit else 0))
            ptp_hit = bool(cfg.partial_take_profit) and not ptp_state.triggered and bar.low <= ptp_trigger_price
            gap_past_tp = bar.open <= tp
            gap_past_ptp = bool(cfg.partial_take_profit) and bar.open <= ptp_trigger_price

        # 1. Gap-past-TP wins (rare but real on Black-Swan opens)
        if tp_hit and gap_past_tp:
            exit_idx = j
            exit_price = bar.open
            exit_reason = "tp"
            break
        # 2. Stop wins over PTP unless gap-past-PTP at open
        if stop_hit and not (ptp_hit and gap_past_ptp):
            exit_idx = j
            # 3. Gap-down: open already below stop → fill at the worse price
            if direction == "long":
                exit_price = bar.open if bar.open < dyn_stop else dyn_stop
            else:
                exit_price = bar.open if bar.open > dyn_stop else dyn_stop
            exit_reason = "stop"
            break
        # 4. PTP fires (intra-bar wick reached trigger or gap-past-PTP)
        if ptp_hit and cfg.partial_take_profit:
            ptp_cfg = cfg.partial_take_profit
            ptp_state.triggered = True
            # Phase 16 (Bug 2): ptpFillCost = cost/2 (no slippage in SimConfig).
            ptp_fill_cost = cost / 2
            ptp_state.realized_pct = ptp_cfg["closeFraction"] * (
                ptp_cfg["triggerPct"] - ptp_fill_cost
            )
            # Phase 16 (Bug 1): auto-move dyn_stop to BE+cost on the remainder
            be_stop = entry * (1 + cost) if direction == "long" else entry * (1 - cost)
            if direction == "long":
                if be_stop > dyn_stop:
                    dyn_stop = be_stop
            else:
                if be_stop < dyn_stop:
                    dyn_stop = be_stop
            be_state.moved = True
            # Reset chandelier reference so it re-arms from the new BE base
            chan_state = ChandelierState()
        # 5. Plain TP
        if tp_hit and not stop_hit:
            exit_idx = j
            exit_price = tp
            exit_reason = "tp"
            break

        # Break-even
        if cfg.break_even:
            dyn_stop, be_state = check_break_even(
                direction, entry, bar.close, cfg.break_even["threshold"],
                dyn_stop, be_state, sl_offset_pct=0.0,  # parity-mode (no live nudge)
            )

        # Chandelier
        if cfg.chandelier:
            period = cfg.chandelier["period"]
            if j >= period:
                highs = [b.high for b in bars[j - period:j + 1]]
                lows = [b.low for b in bars[j - period:j + 1]]
                closes = [b.close for b in bars[j - period:j + 1]]
                a = compute_atr(highs, lows, closes, period)
                if a is not None and a > 0:
                    dyn_stop, chan_state = atr_smoothed_chandelier_exit(
                        direction, entry, cfg.stop_pct, bar.close, a,
                        cfg.chandelier["mult"],
                        cfg.chandelier.get("minMoveR", 0.5),
                        chan_state, dyn_stop,
                    )

        # Time exit
        if cfg.time_exit:
            should_close, te_state = check_time_exit(
                direction, entry, bar.close, cfg.stop_pct,
                cfg.time_exit["maxBarsWithoutGain"],
                cfg.time_exit["minGainR"],
                te_state,
            )
            if should_close:
                exit_idx = j
                exit_price = bar.close
                exit_reason = "time"
                break

    # P&L
    exit_eff = exit_price * (1 - cost / 2) if direction == "long" else exit_price * (1 + cost / 2)
    if direction == "long":
        raw_pnl = (exit_eff - entry_eff) / entry_eff
    else:
        raw_pnl = (entry_eff - exit_eff) / entry_eff

    if cfg.partial_take_profit and ptp_state.triggered:
        raw_pnl = blend_partial_tp_pnl(raw_pnl, ptp_state, cfg.partial_take_profit["closeFraction"])

    eff_risk = cfg.risk_frac
    if cfg.live_max_risk_frac is not None:
        eff_risk = min(eff_risk, cfg.live_max_risk_frac)
    # Phase 10 (engine_features Bug 4): TS-Engine 4531-4542 allows gap-tail
    # losses up to -1.5R via GAP_TAIL_MULT=1.5. Previous floor at -1R
    # masked ~30% of real gap-stops on volatile crypto bars (Black-Swan
    # days like LUNA / FTX). Match TS reference.
    GAP_TAIL_MULT = 1.5
    eff_pnl = max(raw_pnl * cfg.leverage * eff_risk, -eff_risk * GAP_TAIL_MULT)

    return SimulatedTrade(
        direction=direction,
        entry_idx=entry_idx,
        entry_price=entry,
        exit_idx=exit_idx,
        exit_price=exit_price,
        raw_pnl=raw_pnl,
        eff_pnl=eff_pnl,
        exit_reason=exit_reason,
        ptp_triggered=ptp_state.triggered,
        chandelier_armed=chan_state.armed,
        break_even_moved=be_state.moved,
    )
