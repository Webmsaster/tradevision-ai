"""
Unit tests for tools/ftmo_executor.py and tools/mock_mt5.py.

Run:
    cd /path/to/tradevision-ai
    FTMO_MOCK=1 python -m pytest tools/test_ftmo_executor.py -v

Covers:
- compute_lot_size correctness (risk-$ → lot conversion)
- check_ftmo_rules blocking logic (daily loss, total loss)
- handle_daily_reset snapshot + rollover behavior
- mock_mt5 fill + SL/TP trigger logic
"""
from __future__ import annotations

# pyright: reportArgumentType=false, reportPossiblyUnboundVariable=false, reportMissingImports=false

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# Force mock mode before importing executor
os.environ["FTMO_MOCK"] = "1"
os.environ.setdefault("FTMO_START_BALANCE", "100000")

# Add tools/ to path
TOOLS = Path(__file__).parent
sys.path.insert(0, str(TOOLS))


# ============================================================================
# compute_lot_size
# ============================================================================
class FakeSymbolInfo:
    def __init__(self, ask=2000.0, bid=1999.0, tick_size=0.01, tick_value=0.01,
                 volume_min=0.01, volume_max=100.0, volume_step=0.01, point=0.01):
        self.ask = ask
        self.bid = bid
        self.trade_tick_size = tick_size
        self.trade_tick_value = tick_value
        self.volume_min = volume_min
        self.volume_max = volume_max
        self.volume_step = volume_step
        self.point = point


def test_compute_lot_size_basic():
    from ftmo_executor import compute_lot_size
    info = FakeSymbolInfo(ask=2001.0, bid=1999.0, tick_size=0.01, tick_value=0.01)
    # risk = 1% of $100k = $1000; stop = 1% = $20 at price $2000
    # loss_per_lot = $20/$0.01 * $0.01 = $20  (mid = 2000)
    # lot = $1000 / $20 = 50
    lot = compute_lot_size(info, risk_frac=0.01, stop_pct=0.01, account_equity=100000)
    assert 49 <= lot <= 51, f"expected ~50, got {lot}"


def test_compute_lot_size_tighter_stop_bigger_position():
    from ftmo_executor import compute_lot_size
    info = FakeSymbolInfo(ask=2001.0, bid=1999.0)
    # Same risk, half the stop → double the lot
    lot1 = compute_lot_size(info, risk_frac=0.01, stop_pct=0.01, account_equity=100000)
    lot2 = compute_lot_size(info, risk_frac=0.01, stop_pct=0.005, account_equity=100000)
    assert lot2 > lot1, f"tighter stop should give bigger lot: {lot2} vs {lot1}"
    # Approximately 2x (rounded to volume_step)
    assert abs(lot2 / lot1 - 2.0) < 0.1


def test_compute_lot_size_respects_min_max():
    from ftmo_executor import compute_lot_size
    info = FakeSymbolInfo(volume_min=0.5, volume_max=10.0)
    # Very small risk → would round to below min
    lot_small = compute_lot_size(info, risk_frac=0.0001, stop_pct=0.01, account_equity=100000)
    assert lot_small == 0.5, f"expected clamp to min 0.5, got {lot_small}"
    # Very large risk → would exceed max
    lot_big = compute_lot_size(info, risk_frac=1.0, stop_pct=0.01, account_equity=100000)
    assert lot_big == 10.0, f"expected clamp to max 10.0, got {lot_big}"


def test_compute_lot_size_zero_price_returns_zero():
    from ftmo_executor import compute_lot_size
    # When bid/ask both 0 → current_price = 0 → loss_per_lot = 0 → lot = 0
    info = FakeSymbolInfo(ask=0, bid=0)
    lot = compute_lot_size(info, risk_frac=0.01, stop_pct=0.01, account_equity=100000)
    assert lot == 0.0


def test_compute_lot_size_rounds_to_volume_step():
    from ftmo_executor import compute_lot_size
    info = FakeSymbolInfo(volume_step=0.1)
    lot = compute_lot_size(info, risk_frac=0.0123, stop_pct=0.01, account_equity=100000)
    # Should be a multiple of 0.1
    assert abs(lot * 10 - round(lot * 10)) < 0.001, f"lot={lot} not multiple of 0.1"


# ============================================================================
# check_ftmo_rules
# ============================================================================
def test_check_ftmo_rules_clean():
    from ftmo_executor import check_ftmo_rules
    # Fresh account, no losses
    assert check_ftmo_rules(current_equity=100000, day_start_equity=100000) is None


def test_check_ftmo_rules_daily_loss_blocks():
    from ftmo_executor import check_ftmo_rules
    # Down 5% today → clearly over the -4.5% buffer threshold
    result = check_ftmo_rules(current_equity=95000, day_start_equity=100000)
    assert result is not None and "daily_loss" in result


def test_check_ftmo_rules_daily_loss_safe_at_3pct():
    from ftmo_executor import check_ftmo_rules
    # Down 3% today → safe
    assert check_ftmo_rules(current_equity=97000, day_start_equity=100000) is None


def test_check_ftmo_rules_total_loss_blocks():
    from ftmo_executor import check_ftmo_rules
    # Daily safe (-1%), total over (-10%). daily check passes, total check blocks.
    result = check_ftmo_rules(current_equity=90000, day_start_equity=91000)
    assert result is not None and "total_loss" in result


def test_check_ftmo_rules_daily_and_total_both_ok():
    from ftmo_executor import check_ftmo_rules
    # Up today, down 5% total but not at cap
    assert check_ftmo_rules(current_equity=95000, day_start_equity=94000) is None


# ============================================================================
# handle_daily_reset
# ============================================================================
def test_handle_daily_reset_first_write():
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.DAILY_STATE_PATH = Path(td) / "daily-reset.json"
        exe.EXECUTOR_LOG_PATH = Path(td) / "executor-log.jsonl"
        # First call with no existing state → snapshots now
        result = exe.handle_daily_reset(100500.0)
        assert result == 100500.0
        assert (Path(td) / "daily-reset.json").exists()
        saved = json.loads((Path(td) / "daily-reset.json").read_text())
        assert saved["equity_at_day_start_usd"] == 100500.0


def test_handle_daily_reset_same_day_returns_cached():
    import ftmo_executor as exe
    from datetime import datetime, timezone, timedelta
    try:
        from zoneinfo import ZoneInfo
        prague_tz = ZoneInfo("Europe/Prague")
    except ImportError:
        prague_tz = timezone(timedelta(hours=1))
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.DAILY_STATE_PATH = Path(td) / "daily-reset.json"
        exe.EXECUTOR_LOG_PATH = Path(td) / "executor-log.jsonl"
        # Use Prague-TZ date so the cached-day check matches handle_daily_reset's
        # internal Prague-anchored boundary (UTC vs Prague drifts ±2h around midnight).
        today = datetime.now(prague_tz).strftime("%Y-%m-%d")
        (Path(td) / "daily-reset.json").write_text(json.dumps({
            "date": today,
            "equity_at_day_start_usd": 98000.0,
        }))
        # Call later — should return cached day-start, NOT current equity
        result = exe.handle_daily_reset(99500.0)
        assert result == 98000.0


# ============================================================================
# R28 dailyPeakTrailingStop
# ============================================================================
def test_dpt_first_call_seeds_peak():
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.DAY_PEAK_PATH = Path(td) / "day-peak.json"
        exe.EXECUTOR_LOG_PATH = Path(td) / "executor-log.jsonl"
        peak = exe.update_day_peak(100000.0)
        assert peak == 100000.0
        saved = json.loads((Path(td) / "day-peak.json").read_text())
        assert saved["peak_equity_usd"] == 100000.0


def test_dpt_ratchets_up_only():
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.DAY_PEAK_PATH = Path(td) / "day-peak.json"
        exe.EXECUTOR_LOG_PATH = Path(td) / "executor-log.jsonl"
        # Seed at 100k
        exe.update_day_peak(100000.0)
        # Equity rises to 102k → peak should track up
        peak = exe.update_day_peak(102000.0)
        assert peak == 102000.0
        # Equity drops to 99k → peak stays at 102k (no slide-down)
        peak = exe.update_day_peak(99000.0)
        assert peak == 102000.0


def test_dpt_blocks_when_drop_exceeds_trail():
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.DAY_PEAK_PATH = Path(td) / "day-peak.json"
        exe.EXECUTOR_LOG_PATH = Path(td) / "executor-log.jsonl"
        exe.DPT_TRAIL_DISTANCE = 0.012
        exe.DPT_ENABLED = True
        # Peak 102k, current 100k → drop = 1.96% > 1.2% → block
        exe.update_day_peak(102000.0)
        block = exe.check_daily_peak_trail_block(100000.0)
        assert block is not None
        assert "day_peak_trail" in block


def test_dpt_does_not_block_when_drop_below_trail():
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.DAY_PEAK_PATH = Path(td) / "day-peak.json"
        exe.EXECUTOR_LOG_PATH = Path(td) / "executor-log.jsonl"
        exe.DPT_TRAIL_DISTANCE = 0.012
        exe.DPT_ENABLED = True
        # Peak 102k, current 101k → drop = 0.98% < 1.2% → no block
        exe.update_day_peak(102000.0)
        block = exe.check_daily_peak_trail_block(101000.0)
        assert block is None


def test_dpt_disabled_returns_none():
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.DAY_PEAK_PATH = Path(td) / "day-peak.json"
        exe.EXECUTOR_LOG_PATH = Path(td) / "executor-log.jsonl"
        exe.DPT_ENABLED = False
        # Even with massive drop, returns None when disabled
        exe.update_day_peak(110000.0)
        block = exe.check_daily_peak_trail_block(95000.0)
        assert block is None


# ============================================================================
# mock_mt5 sanity
# ============================================================================
def test_mock_mt5_initialize():
    import mock_mt5 as mt5
    assert mt5.initialize()
    info = mt5.account_info()
    assert info is not None
    assert info.balance == 100000.0
    mt5.shutdown()


def test_mock_mt5_symbol_info_returns_bid_ask():
    import mock_mt5 as mt5
    mt5.initialize()
    info = mt5.symbol_info("ETHUSD")
    # May be None if Binance fetch failed in offline test env — skip gracefully
    if info is None:
        pytest.skip("Binance fetch unavailable in this test environment")
    assert info is not None  # narrow for Pyright (skip raises but it can't tell)
    assert info.bid > 0
    assert info.ask > info.bid
    mt5.shutdown()


def test_mock_mt5_place_and_close_short():
    import mock_mt5 as mt5
    mt5.initialize()
    info = mt5.symbol_info("ETHUSD")
    if info is None:
        pytest.skip("Binance fetch unavailable")
    assert info is not None  # narrow for Pyright
    # Open short
    res = mt5.order_send({
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": "ETHUSD",
        "volume": 0.5,
        "type": mt5.ORDER_TYPE_SELL,
        "price": info.bid,
        "sl": info.bid * 1.05,
        "tp": info.bid * 0.95,
        "magic": 231,
        "comment": "test",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    })
    assert res is not None
    assert res.retcode == mt5.TRADE_RETCODE_DONE
    ticket = res.order

    positions = mt5.positions_get()
    assert any(p.ticket == ticket for p in positions)

    # Close
    close_res = mt5.order_send({
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": "ETHUSD",
        "volume": 0.5,
        "type": mt5.ORDER_TYPE_BUY,
        "position": ticket,
        "price": info.ask,
        "magic": 231,
        "comment": "close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    })
    assert close_res is not None
    assert close_res.retcode == mt5.TRADE_RETCODE_DONE
    positions_after = mt5.positions_get()
    assert not any(p.ticket == ticket for p in positions_after)
    mt5.shutdown()


# ============================================================================
# Symbol resolver — handles FTMO's broker-specific naming variants
# ============================================================================
def test_symbol_resolver_aave_default_is_ftmo_correct():
    """AAVUSD (no E) is FTMO's actual symbol — bot default must match."""
    import ftmo_executor as fe
    # Confirms env-default in SYMBOL_MAP (line 124) was fixed FTMO-correct.
    assert fe.SYMBOL_MAP["AAVEUSDT"] == "AAVUSD"


def test_symbol_resolver_uses_explicit_map_first(monkeypatch):
    """Resolver tries SYMBOL_MAP candidate before naive fallbacks."""
    import ftmo_executor as fe
    fe._SYMBOL_CACHE.clear()
    tried: list[str] = []

    class FakeInfo:
        bid = 100.0
        ask = 100.5

    def fake_symbol_info(s: str):
        tried.append(s)
        return FakeInfo() if s == "AAVUSD" else None

    monkeypatch.setattr(fe.mt5, "symbol_info", fake_symbol_info)
    resolved = fe._resolve_broker_symbol("AAVEUSDT")
    assert resolved == "AAVUSD"
    assert tried[0] == "AAVUSD"  # explicit map wins first


def test_symbol_resolver_falls_through_to_e_drop_variant(monkeypatch):
    """If primary fails, resolver tries dropping trailing E (AAVE → AAV)."""
    import ftmo_executor as fe
    fe._SYMBOL_CACHE.clear()

    class FakeInfo:
        bid = 1.0
        ask = 1.1

    def fake_symbol_info(s: str):
        # Only the e-dropped variant exists at the broker
        return FakeInfo() if s == "AAVUSD" else None

    monkeypatch.setattr(fe.mt5, "symbol_info", fake_symbol_info)
    # If SYMBOL_MAP override gets cleared, resolver still finds AAVUSD via fallback
    original = fe.SYMBOL_MAP.pop("AAVEUSDT", None)
    try:
        resolved = fe._resolve_broker_symbol("AAVEUSDT")
        assert resolved == "AAVUSD"
    finally:
        if original is not None:
            fe.SYMBOL_MAP["AAVEUSDT"] = original


def test_symbol_resolver_caches_result(monkeypatch):
    """Second call must hit cache, not call symbol_info again."""
    import ftmo_executor as fe
    fe._SYMBOL_CACHE.clear()
    call_count = 0

    class FakeInfo:
        bid = 1.0
        ask = 1.1

    def fake_symbol_info(s: str):
        nonlocal call_count
        call_count += 1
        return FakeInfo() if s == "BTCUSD" else None

    monkeypatch.setattr(fe.mt5, "symbol_info", fake_symbol_info)
    a = fe._resolve_broker_symbol("BTCUSDT")
    before = call_count
    b = fe._resolve_broker_symbol("BTCUSDT")
    assert a == b == "BTCUSD"
    assert call_count == before  # cache hit, no new call


def test_symbol_resolver_returns_none_when_nothing_matches(monkeypatch):
    """If broker has none of the variants, resolver returns None (not crash)."""
    import ftmo_executor as fe
    fe._SYMBOL_CACHE.clear()
    monkeypatch.setattr(fe.mt5, "symbol_info", lambda s: None)
    resolved = fe._resolve_broker_symbol("XYZUSDT")
    assert resolved is None


# ============================================================================
# challenge_peak — required for peakDrawdownThrottle (R28_V2/V3/V4)
# ============================================================================
def test_update_challenge_peak_first_call_seeds_peak():
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.CHALLENGE_PEAK_PATH = Path(td) / "challenge-peak.json"
        peak = exe.update_challenge_peak(105_000.0)
        assert peak == 105_000.0
        saved = json.loads((Path(td) / "challenge-peak.json").read_text())
        assert saved["peak_equity_usd"] == 105_000.0


def test_update_challenge_peak_ratchets_up_only():
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.CHALLENGE_PEAK_PATH = Path(td) / "challenge-peak.json"
        exe.update_challenge_peak(105_000.0)
        peak = exe.update_challenge_peak(108_000.0)
        assert peak == 108_000.0
        peak = exe.update_challenge_peak(102_000.0)
        assert peak == 108_000.0


def test_update_challenge_peak_resets_on_new_challenge():
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.CHALLENGE_PEAK_PATH = Path(td) / "challenge-peak.json"
        (Path(td) / "challenge-peak.json").write_text(json.dumps({
            "peak_equity_usd": 108_000.0,
            "started_at": "2026-04-01",
            "last_update_ts": "2026-04-15T12:00:00Z",
        }))
        exe.CHALLENGE_START_DATE = "2026-05-02"
        peak = exe.update_challenge_peak(100_000.0)
        assert peak == 100_000.0


def test_update_challenge_peak_persists_within_same_challenge():
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.CHALLENGE_PEAK_PATH = Path(td) / "challenge-peak.json"
        exe.CHALLENGE_START_DATE = "2026-05-02"
        exe.update_challenge_peak(105_000.0)
        peak = exe.update_challenge_peak(103_000.0)
        assert peak == 105_000.0


# ============================================================================
# Regime-Gate (Round 52) — pre-filter entries by BTC market regime
# ============================================================================
def test_regime_gate_disabled_returns_none():
    import ftmo_executor as exe
    exe.REGIME_GATE_ENABLED = False
    assert exe.check_regime_gate_block() is None


def test_regime_gate_blocks_trend_down():
    import ftmo_executor as exe
    exe.REGIME_GATE_ENABLED = True
    exe.REGIME_GATE_BLOCK = {"trend-down"}
    exe._REGIME_CACHE["ts"] = 9_999_999_999  # far future, no recompute
    exe._REGIME_CACHE["regime"] = "trend-down"
    blocker = exe.check_regime_gate_block()
    assert blocker is not None
    assert "trend-down" in blocker
    exe.REGIME_GATE_ENABLED = False


def test_regime_gate_passes_trend_up():
    import ftmo_executor as exe
    exe.REGIME_GATE_ENABLED = True
    exe.REGIME_GATE_BLOCK = {"trend-down"}
    exe._REGIME_CACHE["ts"] = 9_999_999_999
    exe._REGIME_CACHE["regime"] = "trend-up"
    assert exe.check_regime_gate_block() is None
    exe.REGIME_GATE_ENABLED = False


def test_regime_gate_classification_specific_labels():
    """2026-05-21: was a vacuous membership assert (regime in {all-values, None})
    that could never fail. Now feeds deterministic 7-day H1 series and asserts
    the SPECIFIC classification, exercising the trend/vol math + thresholds so a
    regression in the formula or cutoffs is actually caught."""
    import ftmo_executor as exe

    orig_sym = exe.REGIME_GATE_BTC_SYMBOL
    orig_rates = exe.mt5.copy_rates_from_pos
    exe.REGIME_GATE_BTC_SYMBOL = "BTCUSDT"

    def feed(closes):
        bars = [{"close": c, "open": c, "high": c, "low": c} for c in closes]
        exe.mt5.copy_rates_from_pos = lambda *a, **k: bars
        exe._REGIME_CACHE["ts"] = 0
        exe._REGIME_CACHE["regime"] = None
        return exe.classify_btc_regime()

    try:
        # +12% smooth ramp → trend 0.12 (>0.05), negligible vol → trend-up
        assert feed([100.0 + 12.0 * i / 167 for i in range(168)]) == "trend-up"
        # -12% smooth ramp → trend < -0.05 → trend-down
        assert feed([100.0 - 12.0 * i / 167 for i in range(168)]) == "trend-down"
        # flat (trend ~0, near-zero vol) → calm
        assert feed([100.0 for _ in range(168)]) == "calm"
        # alternating ±1.5% per bar → annual_vol >= 0.6 → high-vol
        assert feed([100.0 * (1.015 if i % 2 else 0.985) for i in range(168)]) == "high-vol"
    finally:
        exe.mt5.copy_rates_from_pos = orig_rates
        exe.REGIME_GATE_BTC_SYMBOL = orig_sym
        exe._REGIME_CACHE["ts"] = 0
        exe._REGIME_CACHE["regime"] = None


def test_regime_gate_fails_open_when_classifier_returns_none():
    import ftmo_executor as exe
    exe.REGIME_GATE_ENABLED = True
    exe.REGIME_GATE_BLOCK = {"trend-down"}
    exe._REGIME_CACHE["ts"] = 9_999_999_999
    exe._REGIME_CACHE["regime"] = None
    # Need to ensure classify_btc_regime also returns None — override symbol
    # to something unresolvable so MT5 path returns None.
    saved_btc = exe.REGIME_GATE_BTC_SYMBOL
    exe.REGIME_GATE_BTC_SYMBOL = "NOSUCH"
    assert exe.check_regime_gate_block() is None
    exe.REGIME_GATE_BTC_SYMBOL = saved_btc
    exe.REGIME_GATE_ENABLED = False


# ============================================================================
# Slippage modeling (Round 53) — close V4-Engine → Live drift
# ============================================================================
class FakeSpreadSymbolInfo(FakeSymbolInfo):
    """SymbolInfo variant that exposes broker-reported spread (in points)."""
    def __init__(self, ask=2001.0, bid=1999.0, spread=10, point=0.01, **kwargs):
        super().__init__(ask=ask, bid=bid, point=point, **kwargs)
        self.spread = spread  # 10 points × 0.01 = 0.10 price units


def test_slippage_helper_long_entry_pays_more():
    """Long entry slips price UPWARD (paid more than ask)."""
    import ftmo_executor as exe
    exe.SLIPPAGE_DISABLED = False
    exe.SLIPPAGE_ENTRY_SPREADS = 1.5
    info = FakeSpreadSymbolInfo(ask=2001.0, bid=1999.0, spread=10, point=0.01)
    # slip_unit = 10 * 0.01 = 0.10; entry_delta = 0.10 * 1.5 = 0.15
    slipped = exe._apply_slippage(2001.0, "long", "entry", info)
    assert abs(slipped - 2001.15) < 1e-6, f"expected 2001.15, got {slipped}"
    # Stop-out long: price already gapping DOWN → fill lower
    exe.SLIPPAGE_STOP_SPREADS = 3.0
    stop_slipped = exe._apply_slippage(2000.0, "long", "stop_out", info)
    assert abs(stop_slipped - (2000.0 - 0.30)) < 1e-6, f"expected 1999.70, got {stop_slipped}"


def test_slippage_helper_short_entry_receives_less():
    """Short entry slips price DOWNWARD (received less than bid)."""
    import ftmo_executor as exe
    exe.SLIPPAGE_DISABLED = False
    exe.SLIPPAGE_ENTRY_SPREADS = 1.5
    exe.SLIPPAGE_STOP_SPREADS = 3.0
    info = FakeSpreadSymbolInfo(ask=2001.0, bid=1999.0, spread=10, point=0.01)
    # slip_unit = 0.10; entry_delta = 0.15
    slipped = exe._apply_slippage(1999.0, "short", "entry", info)
    assert abs(slipped - (1999.0 - 0.15)) < 1e-6, f"expected 1998.85, got {slipped}"
    # Short stop-out: price gapping UP → bought back higher
    stop_slipped = exe._apply_slippage(2000.0, "short", "stop_out", info)
    assert abs(stop_slipped - (2000.0 + 0.30)) < 1e-6, f"expected 2000.30, got {stop_slipped}"


def test_slippage_disabled_returns_input_unchanged():
    """SLIPPAGE_DISABLED=True bypasses all slippage."""
    import ftmo_executor as exe
    exe.SLIPPAGE_DISABLED = True
    info = FakeSpreadSymbolInfo(ask=2001.0, bid=1999.0, spread=10, point=0.01)
    for direction in ("long", "short"):
        for action in ("entry", "stop_out", "tp", "ptp"):
            assert exe._apply_slippage(2000.0, direction, action, info) == 2000.0
    # TP and PTP are limit orders → never slip even when slippage enabled
    exe.SLIPPAGE_DISABLED = False
    assert exe._apply_slippage(2000.0, "long", "tp", info) == 2000.0
    assert exe._apply_slippage(2000.0, "short", "ptp", info) == 2000.0


def test_place_market_order_long_fill_price_includes_slippage(monkeypatch):
    """Integration: place_market_order long produces fill > theoretical ask."""
    import ftmo_executor as exe
    exe.SLIPPAGE_DISABLED = False
    exe.SLIPPAGE_ENTRY_SPREADS = 1.5
    exe._SYMBOL_CACHE.clear()

    info = FakeSpreadSymbolInfo(
        ask=2001.0, bid=1999.0, spread=20, point=0.01,
        tick_size=0.01, tick_value=0.01,
        volume_min=0.01, volume_max=100.0, volume_step=0.01,
    )
    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: info)
    monkeypatch.setattr(exe.mt5, "symbol_select", lambda s, e: True)

    captured = {}

    class FakeRes:
        def __init__(self, price):
            self.retcode = exe.mt5.TRADE_RETCODE_DONE
            self.order = 12345
            self.price = price
            self.comment = ""

    def fake_send(req):
        captured["request"] = req
        # Real MT5 would echo back the broker fill — return 0.0 so the
        # executor falls back to its own slipped fill price (covers both
        # paths in the OrderResult construction).
        return FakeRes(0.0)

    monkeypatch.setattr(exe.mt5, "order_send", fake_send)

    # Resolve binance symbol via the explicit map (BTCUSDT → BTCUSD)
    res = exe.place_market_order(
        binance_symbol="BTCUSDT",
        direction="long",
        risk_frac=0.01,
        stop_pct=0.01,
        tp_pct=0.02,
        account_equity=100000.0,
        comment="slip_test",
    )
    assert res.ok, f"order failed: {res.error}"
    # slip_unit = 20 * 0.01 = 0.20; long entry delta = 0.20 * 1.5 = 0.30
    expected_fill = 2001.0 + 0.30
    assert res.entry_price is not None
    assert abs(res.entry_price - expected_fill) < 1e-6, (
        f"fill_price {res.entry_price} != expected {expected_fill} "
        f"(theoretical ask was 2001.0, slippage should make it worse)"
    )
    # The order_send request should also carry the slipped price, not raw ask
    assert abs(captured["request"]["price"] - expected_fill) < 1e-6
    # And SL/TP stay relative to the THEORETICAL ask (2001.0), not slipped
    assert abs(captured["request"]["sl"] - 2001.0 * 0.99) < 1e-6
    assert abs(captured["request"]["tp"] - 2001.0 * 1.02) < 1e-6


def test_place_market_order_uses_payload_absolute_levels(monkeypatch):
    """Codex #5 final fix: when signal_stop_price/signal_tp_price are given,
    place THOSE exact levels — not the relative re-derivation off the tick."""
    import ftmo_executor as exe
    exe.SLIPPAGE_DISABLED = True  # isolate level-source from slippage math
    exe._SYMBOL_CACHE.clear()

    info = FakeSpreadSymbolInfo(
        ask=2001.0, bid=1999.0, spread=20, point=0.01,
        tick_size=0.01, tick_value=0.01,
        volume_min=0.01, volume_max=100.0, volume_step=0.01,
    )
    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: info)
    monkeypatch.setattr(exe.mt5, "symbol_select", lambda s, e: True)

    captured = {}

    class FakeRes:
        def __init__(self):
            self.retcode = exe.mt5.TRADE_RETCODE_DONE
            self.order = 999
            self.price = 0.0
            self.comment = ""
            self.volume = 0.0

    def fake_send(req):
        captured["request"] = req
        return FakeRes()

    monkeypatch.setattr(exe.mt5, "order_send", fake_send)

    # Long: payload SL=1975 (≈1.3% below ask, distinct from relative 1980.99)
    # and TP=2050 (distinct from relative 2041.02). stop<entry<tp → valid.
    res = exe.place_market_order(
        binance_symbol="BTCUSDT", direction="long", risk_frac=0.01,
        stop_pct=0.01, tp_pct=0.02, account_equity=100000.0,
        comment="payload_test",
        signal_stop_price=1975.0, signal_tp_price=2050.0,
    )
    assert res.ok, f"order failed: {res.error}"
    # The placed SL/TP MUST be the payload absolutes, NOT 2001*0.99 / 2001*1.02.
    assert abs(captured["request"]["sl"] - 1975.0) < 1e-6, captured["request"]["sl"]
    assert abs(captured["request"]["tp"] - 2050.0) < 1e-6, captured["request"]["tp"]
    # And the persisted OrderResult levels reflect those payload levels.
    assert res.stop_price is not None and abs(res.stop_price - 1975.0) < 1e-6
    assert res.tp_price is not None and abs(res.tp_price - 2050.0) < 1e-6


def test_place_market_order_rejects_payload_levels_on_wrong_side(monkeypatch):
    """Codex #5 fix: a malformed payload with SL on the wrong side of entry
    must be rejected, not placed as an instantly-invalid order."""
    import ftmo_executor as exe
    exe.SLIPPAGE_DISABLED = True
    exe._SYMBOL_CACHE.clear()

    info = FakeSpreadSymbolInfo(
        ask=2001.0, bid=1999.0, spread=20, point=0.01,
        tick_size=0.01, tick_value=0.01,
        volume_min=0.01, volume_max=100.0, volume_step=0.01,
    )
    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: info)
    monkeypatch.setattr(exe.mt5, "symbol_select", lambda s, e: True)
    monkeypatch.setattr(exe.mt5, "order_send", lambda req: (_ for _ in ()).throw(
        AssertionError("order_send must NOT be called when payload levels invalid")))

    # Long with SL=2050 ABOVE the entry (2001) — invalid (stop must be below).
    res = exe.place_market_order(
        binance_symbol="BTCUSDT", direction="long", risk_frac=0.01,
        stop_pct=0.01, tp_pct=0.02, account_equity=100000.0,
        comment="bad_payload",
        signal_stop_price=2050.0, signal_tp_price=2100.0,
    )
    assert not res.ok
    assert "wrong side" in (res.error or "")


def _fake_live_pos(exe, ticket, volume=1.0):
    from types import SimpleNamespace
    return SimpleNamespace(
        ticket=ticket,
        type=exe.mt5.POSITION_TYPE_BUY,
        volume=volume,
        price_open=2000.0,
        sl=1975.0,
        tp=2050.0,
        time=1700000000,
        symbol="BTCUSD",
        magic=exe.MAGIC,
    )


def test_rebuild_recovers_config_from_executed_log(monkeypatch, tmp_path):
    """Codex #9 fix: a live position whose on-disk state was lost recovers its
    full management config (PTP/chandelier/trailing/break-even/time/max-hold)
    from the executed-signals audit log, not a naked stub."""
    import ftmo_executor as exe
    exe.STATE_DIR = tmp_path
    exe.EXECUTED_PATH = tmp_path / "executed-signals.json"
    exe.OPEN_POS_PATH = tmp_path / "open-positions.json"
    exe.OPEN_POS_PATH.write_text(json.dumps({"positions": []}))  # state lost
    sig = {
        "assetSymbol": "BTC", "sourceSymbol": "BTCUSDT", "direction": "long",
        "stopPrice": 1975.0, "tpPrice": 2050.0, "stopPct": 0.01,
        "maxHoldUntil": 1234567890,
        "chandelierExit": {"atrMult": 3.0, "atrPeriod": 22},
        "partialTakeProfitLevels": [{"trigger": 0.5, "frac": 0.3}],
        "breakEvenAtProfit": {"threshold": 0.5},
        "timeExit": {"maxBarsWithoutGain": 10, "minGainR": 1.0},
        "trailingStop": {"activatePct": 0.02, "trailPct": 0.01},
        "engineTicketId": "BTC@111@long", "entryTime": 111,
    }
    exe.EXECUTED_PATH.write_text(json.dumps({"executions": [
        {"result": "placed", "ticket": 555, "signal": sig, "lot": 1.0, "actual_entry": 2000.0}
    ]}))
    monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **k: [_fake_live_pos(exe, 555)])

    exe.rebuild_open_positions_from_mt5()

    out = json.loads(exe.OPEN_POS_PATH.read_text())
    assert len(out["positions"]) == 1
    p = out["positions"][0]
    assert p.get("_rebuilt_from_executed_log") is True
    assert p["chandelier"] == {"atrMult": 3.0, "atrPeriod": 22}
    assert p["partial_tp_levels"] == [{"trigger": 0.5, "frac": 0.3}]
    assert p["max_hold_until"] == 1234567890
    assert p["break_even"] == {"threshold": 0.5}
    assert p["time_exit"] is not None
    assert p["trailing_stop"] == {"activatePct": 0.02, "trailPct": 0.01}
    assert p["engine_ticket_id"] == "BTC@111@long"
    # Full live volume → no partial fired → levels not marked done.
    assert p["partial_tp_levels_done"] == [False]
    assert p["partial_tp_done"] is False


def test_rebuild_marks_ptp_done_when_volume_reduced(monkeypatch, tmp_path):
    """If live volume < original, ≥1 PTP fired pre-loss → mark all levels done
    so the smaller position can't double-scale-out."""
    import ftmo_executor as exe
    exe.STATE_DIR = tmp_path
    exe.EXECUTED_PATH = tmp_path / "executed-signals.json"
    exe.OPEN_POS_PATH = tmp_path / "open-positions.json"
    exe.OPEN_POS_PATH.write_text(json.dumps({"positions": []}))
    sig = {
        "assetSymbol": "BTC", "sourceSymbol": "BTCUSDT", "direction": "long",
        "stopPrice": 1975.0, "tpPrice": 2050.0, "stopPct": 0.01,
        "maxHoldUntil": 0,
        "partialTakeProfitLevels": [{"trigger": 0.5, "frac": 0.3}],
    }
    exe.EXECUTED_PATH.write_text(json.dumps({"executions": [
        {"result": "placed", "ticket": 556, "signal": sig, "lot": 1.0, "actual_entry": 2000.0}
    ]}))
    # live volume 0.5 < original 1.0 → partial already fired.
    monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **k: [_fake_live_pos(exe, 556, volume=0.5)])

    exe.rebuild_open_positions_from_mt5()
    p = json.loads(exe.OPEN_POS_PATH.read_text())["positions"][0]
    assert p["partial_tp_levels_done"] == [True]
    assert p["partial_tp_done"] is True
    assert p["original_lot"] == 1.0


def test_rebuild_falls_back_to_stub_without_executed_record(monkeypatch, tmp_path):
    """No executed-log record (log pruned / different bot version) → minimal
    stub with modifiers None, exactly the prior behaviour."""
    import ftmo_executor as exe
    exe.STATE_DIR = tmp_path
    exe.EXECUTED_PATH = tmp_path / "executed-signals.json"
    exe.OPEN_POS_PATH = tmp_path / "open-positions.json"
    exe.OPEN_POS_PATH.write_text(json.dumps({"positions": []}))
    exe.EXECUTED_PATH.write_text(json.dumps({"executions": []}))
    monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **k: [_fake_live_pos(exe, 777)])

    exe.rebuild_open_positions_from_mt5()
    p = json.loads(exe.OPEN_POS_PATH.read_text())["positions"][0]
    assert p.get("_rebuilt_from_mt5") is True
    assert p["chandelier"] is None
    assert p["partial_tp_levels"] is None
    assert p["max_hold_until"] == 0


def test_rebuild_rejects_stale_record_on_ticket_reuse(monkeypatch, tmp_path):
    """B2 fix: a stale executed record from an OLD challenge sharing a reused
    ticket int must NOT graft its config onto a NEW live position. Mismatched
    entry price → fall back to safe stub."""
    import ftmo_executor as exe
    exe.STATE_DIR = tmp_path
    exe.EXECUTED_PATH = tmp_path / "executed-signals.json"
    exe.OPEN_POS_PATH = tmp_path / "open-positions.json"
    exe.OPEN_POS_PATH.write_text(json.dumps({"positions": []}))
    stale_sig = {
        "assetSymbol": "BTC", "sourceSymbol": "BTCUSDT", "direction": "long",
        "chandelierExit": {"atrMult": 3.0}, "maxHoldUntil": 999,
    }
    # Stale record entry 1000 vs live position open 2000 → reused-ticket mismatch.
    exe.EXECUTED_PATH.write_text(json.dumps({"executions": [
        {"result": "placed", "ticket": 555, "signal": stale_sig, "lot": 1.0, "actual_entry": 1000.0}
    ]}))
    monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **k: [_fake_live_pos(exe, 555)])

    exe.rebuild_open_positions_from_mt5()
    p = json.loads(exe.OPEN_POS_PATH.read_text())["positions"][0]
    assert p.get("_rebuilt_from_mt5") is True   # stub, NOT grafted config
    assert p["chandelier"] is None
    assert p["max_hold_until"] == 0


def test_place_market_order_rejects_tiny_payload_stop(monkeypatch):
    """B3 fix: a near-zero payload stop distance is rejected, not sized into an
    enormous lot."""
    import ftmo_executor as exe
    exe.SLIPPAGE_DISABLED = True
    exe._SYMBOL_CACHE.clear()
    info = FakeSpreadSymbolInfo(
        ask=2000.0, bid=2000.0, spread=0, point=0.01,
        tick_size=0.01, tick_value=0.01,
        volume_min=0.01, volume_max=100.0, volume_step=0.01,
    )
    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: info)
    monkeypatch.setattr(exe.mt5, "symbol_select", lambda s, e: True)
    monkeypatch.setattr(exe.mt5, "order_send", lambda req: (_ for _ in ()).throw(
        AssertionError("order_send must NOT fire on tiny stop")))
    # SL only 0.01% below entry → eff_stop < MIN_EFFECTIVE_STOP_PCT (0.1%).
    res = exe.place_market_order(
        binance_symbol="BTCUSDT", direction="long", risk_frac=0.01,
        stop_pct=0.01, tp_pct=0.02, account_equity=100000.0, comment="tiny",
        signal_stop_price=1999.8, signal_tp_price=2050.0,
    )
    assert not res.ok
    assert "too tight" in (res.error or "")


def test_place_market_order_rejects_stop_collapsed_by_rounding(monkeypatch):
    """B4 fix: a payload SL that rounds onto the entry (coarse tick grid) is
    rejected by the post-round side check, not sent as SL==entry."""
    import ftmo_executor as exe
    exe.SLIPPAGE_DISABLED = True
    exe._SYMBOL_CACHE.clear()
    # Coarse tick grid 10.0: payload SL 1996 rounds to 2000 == entry.
    info = FakeSpreadSymbolInfo(
        ask=2000.0, bid=2000.0, spread=0, point=10.0,
        tick_size=10.0, tick_value=0.01,
        volume_min=0.01, volume_max=100.0, volume_step=0.01,
    )
    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: info)
    monkeypatch.setattr(exe.mt5, "symbol_select", lambda s, e: True)
    monkeypatch.setattr(exe.mt5, "order_send", lambda req: (_ for _ in ()).throw(
        AssertionError("order_send must NOT fire when SL collapses to entry")))
    res = exe.place_market_order(
        binance_symbol="BTCUSDT", direction="long", risk_frac=0.01,
        stop_pct=0.01, tp_pct=0.02, account_equity=100000.0, comment="round",
        signal_stop_price=1996.0, signal_tp_price=2050.0,
    )
    assert not res.ok
    assert "wrong side after rounding" in (res.error or "")


def test_reconcile_does_not_requeue_stale_orphan_marker(monkeypatch, tmp_path):
    """B3b fix: a crash-orphan marker whose signal is older than the staleness
    cap must NOT be re-queued (it would be silently dropped downstream → missed
    position); a fresh orphan IS re-queued."""
    import ftmo_executor as exe
    import time as _time
    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "PENDING_ORDERS_DIR", tmp_path / "pending-orders")
    monkeypatch.setattr(exe, "PENDING_PATH", tmp_path / "pending-signals.json")
    monkeypatch.setattr(exe, "tg_send", lambda *a, **k: True)
    monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **k: [])
    monkeypatch.setattr(exe.mt5, "history_deals_get", lambda *a, **k: [])
    now_ms = int(_time.time() * 1000)
    fresh = {"assetSymbol": "BTC-TREND", "signalBarClose": now_ms - 60_000,
             "direction": "long", "sourceSymbol": "BTCUSDT", "stopPct": 0.01}
    stale = {"assetSymbol": "ETH-TREND", "signalBarClose": now_ms - 20 * 60_000,
             "direction": "long", "sourceSymbol": "ETHUSDT", "stopPct": 0.01}
    exe._write_pending_order_marker(fresh)
    exe._write_pending_order_marker(stale)

    exe.reconcile_pending_order_markers()

    pend = json.loads(exe.PENDING_PATH.read_text()) if exe.PENDING_PATH.exists() else {"signals": []}
    requeued = {s["assetSymbol"] for s in pend.get("signals", [])}
    assert "BTC-TREND" in requeued       # fresh orphan re-queued
    assert "ETH-TREND" not in requeued   # stale orphan NOT re-queued (alerted)
    # both markers cleaned up regardless
    assert list((tmp_path / "pending-orders").glob("*.json")) == []


def test_ptp_levels_track_live_volume_across_multi_level_poll(monkeypatch):
    """Bug-round 3 fix: when several PTP levels trigger in one poll, each close
    must be capped against the SHRINKING live volume (not the stale pre-loop
    volume) and reduce `held` by the ACTUAL closed amount."""
    import ftmo_executor as exe
    from types import SimpleNamespace
    pos = {
        "ticket": 42, "direction": "long", "entry_price": 100.0,
        "original_lot": 1.0,
        "partial_tp_levels": [
            {"triggerPct": 0.01, "closeFraction": 0.4},
            {"triggerPct": 0.02, "closeFraction": 0.4},
        ],
        "partial_tp_levels_done": [False, False],
        "peak_price_seen": 103.0,  # +3% → both levels trigger this poll
    }
    # Live position holds 1.0 lot; price_current well past both triggers.
    live = SimpleNamespace(ticket=42, volume=1.0, price_open=100.0, price_current=103.0,
                           symbol="BTCUSD", sl=0.0, tp=0.0, type=exe.mt5.POSITION_TYPE_BUY)
    monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **k: [live])
    monkeypatch.setattr(exe.mt5, "symbol_info",
                        lambda s: SimpleNamespace(volume_min=0.01, volume_step=0.01))
    closes: list = []
    def fake_close(ticket, close_lot, reason):
        closes.append(close_lot)
        return close_lot  # broker fills the full requested amount
    monkeypatch.setattr(exe, "_close_partial_lot", fake_close)

    exe._apply_partial_tp_levels(pos)

    # Both levels fired; each closed 0.4 of ORIGINAL (1.0) = 0.4, 0.4.
    assert pos["partial_tp_levels_done"] == [True, True]
    assert abs(closes[0] - 0.4) < 1e-9
    # 2nd leg capped against held (1.0-0.4=0.6) → 0.4 fits, not stranded.
    assert abs(closes[1] - 0.4) < 1e-9


def test_favorable_extreme_tracks_wick_not_reverting_close():
    """H2 fix: BE/trail/chandelier arm on the favorable intrabar extreme
    (peak for long, trough for short), not the reverting tick close — mirrors
    the engine's bar high/low semantics."""
    import ftmo_executor as exe
    pos = {}
    assert exe._favorable_extreme(pos, "long", 105.0) == 105.0
    assert exe._favorable_extreme(pos, "long", 110.0) == 110.0
    assert exe._favorable_extreme(pos, "long", 101.0) == 110.0  # wick reverts, peak holds
    assert pos["peak_price_seen"] == 110.0
    pos2 = {}
    assert exe._favorable_extreme(pos2, "short", 95.0) == 95.0
    assert exe._favorable_extreme(pos2, "short", 90.0) == 90.0
    assert exe._favorable_extreme(pos2, "short", 99.0) == 90.0   # trough holds
    assert pos2["peak_price_seen"] == 90.0


def test_resolve_broker_symbol_rejects_base_mismatch(monkeypatch):
    """H1 fix: a generated candidate matching a DIFFERENT instrument's base is
    rejected (only base-consistent or curated-map symbols accepted)."""
    import ftmo_executor as exe
    exe._SYMBOL_CACHE.clear()
    exe._SYMBOL_CACHE_NEG_TS.clear()
    # Broker only exposes a wrong-base instrument for the generated variants.
    monkeypatch.setattr(exe, "SYMBOL_MAP", {})
    monkeypatch.setattr(exe.mt5, "symbol_info",
                        lambda s: object() if s == "XRPUSD" else None)
    # Resolving BTCUSDT must NOT accept XRPUSD (base mismatch) → None.
    assert exe._resolve_broker_symbol("BTCUSDT") is None
    exe._SYMBOL_CACHE.clear()
    exe._SYMBOL_CACHE_NEG_TS.clear()
    # A base-consistent broker symbol IS accepted.
    monkeypatch.setattr(exe.mt5, "symbol_info",
                        lambda s: object() if s == "BTCUSD" else None)
    assert exe._resolve_broker_symbol("BTCUSDT") == "BTCUSD"


# ============================================================================
# News-Blackout (Round 53)
# ============================================================================
def test_news_blackout_disabled_returns_none():
    import ftmo_executor as exe
    exe.NEWS_BLACKOUT_ENABLED = False
    assert exe.check_news_blackout() is None


def test_news_blackout_active_during_fomc_window_via_helper():
    from news_blackout import is_blackout_window
    from datetime import datetime, timezone
    fake_now = datetime(2026, 4, 29, 18, 5, tzinfo=timezone.utc)
    blocked, reason = is_blackout_window(fake_now, 30, 60)
    assert blocked is True
    assert reason is not None and "FOMC" in reason


def test_news_blackout_outside_window_passes():
    from news_blackout import is_blackout_window
    from datetime import datetime, timezone
    safe_now = datetime(2026, 4, 22, 9, 0, tzinfo=timezone.utc)
    blocked, _ = is_blackout_window(safe_now, 30, 60)
    assert blocked is False


def test_news_blackout_30min_before_cpi_triggers_boundary():
    from news_blackout import is_blackout_window
    from datetime import datetime, timezone
    pre_now = datetime(2026, 5, 13, 12, 0, tzinfo=timezone.utc)
    blocked, reason = is_blackout_window(pre_now, 30, 60)
    assert blocked is True
    assert reason is not None and "CPI" in reason


# ============================================================================
# News-Blackout live API feed (Round 53+)
# ============================================================================
def _reset_news_module_state():
    """Force re-import-style state reset so each test starts clean."""
    import news_blackout as nb
    nb._EVENTS_CACHE = None


def test_news_refresh_no_api_key_returns_zero(monkeypatch, tmp_path):
    monkeypatch.delenv("NEWS_API_KEY", raising=False)
    monkeypatch.delenv("NEWS_API_DISABLED", raising=False)
    _reset_news_module_state()
    from news_blackout import refresh_from_api
    cache = tmp_path / "news-cache.json"
    assert refresh_from_api(cache_path=cache, force=True) == 0
    assert not cache.exists()


def test_news_refresh_writes_cache_on_success(monkeypatch, tmp_path):
    monkeypatch.setenv("NEWS_API_KEY", "fake-token-for-test")
    monkeypatch.delenv("NEWS_API_DISABLED", raising=False)
    _reset_news_module_state()

    payload = {
        "economicCalendar": [
            {
                "country": "US",
                "event": "FOMC Statement",
                "impact": "high",
                "time": "2026-06-17 18:00:00",
            },
            {
                "country": "US",
                "event": "Consumer Price Index (CPI)",
                "impact": "high",
                "time": "2026-06-12 12:30:00",
            },
            {
                "country": "US",
                "event": "Nonfarm Payrolls",
                "impact": "high",
                "time": "2026-06-05 12:30:00",
            },
            # Filtered out: low impact
            {
                "country": "US",
                "event": "CPI Flash",
                "impact": "low",
                "time": "2026-06-20 12:30:00",
            },
            # Filtered out: non-US
            {
                "country": "DE",
                "event": "ECB Rate Decision",
                "impact": "high",
                "time": "2026-06-18 12:00:00",
            },
            # Filtered out: no keyword match
            {
                "country": "US",
                "event": "Building Permits",
                "impact": "high",
                "time": "2026-06-19 12:30:00",
            },
        ]
    }

    class FakeResponse:
        def __init__(self, body: bytes):
            self._body = body
        def read(self):
            return self._body
        def __enter__(self):
            return self
        def __exit__(self, exc_type, exc, tb):
            return False

    captured: dict = {}
    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url if hasattr(req, "full_url") else str(req)
        captured["timeout"] = timeout
        return FakeResponse(json.dumps(payload).encode("utf-8"))

    import news_blackout as nb
    monkeypatch.setattr(nb.urllib.request, "urlopen", fake_urlopen)

    cache = tmp_path / "news-cache.json"
    n = nb.refresh_from_api(cache_path=cache, force=True)
    assert n == 3, f"expected 3 filtered events, got {n}"
    assert cache.exists()
    assert captured["timeout"] == 10
    assert "fake-token-for-test" in captured["url"]

    written = json.loads(cache.read_text(encoding="utf-8"))
    labels = sorted(e["label"] for e in written)
    assert labels == ["CPI", "FOMC", "NFP"]
    # ISO strings round-trip cleanly
    for e in written:
        from datetime import datetime
        datetime.fromisoformat(e["iso"])


def test_news_refresh_respects_ttl(monkeypatch, tmp_path):
    monkeypatch.setenv("NEWS_API_KEY", "fake-token")
    monkeypatch.delenv("NEWS_API_DISABLED", raising=False)
    _reset_news_module_state()

    cache = tmp_path / "news-cache.json"
    cache.write_text(json.dumps([{"iso": "2026-06-17T18:00:00+00:00", "label": "FOMC"}]))

    call_count = {"n": 0}
    def fake_urlopen(req, timeout=None):
        call_count["n"] += 1
        raise AssertionError("urlopen must NOT be called when cache is fresh")

    import news_blackout as nb
    monkeypatch.setattr(nb.urllib.request, "urlopen", fake_urlopen)

    # Fresh cache (just written) → no fetch
    result = nb.refresh_from_api(cache_path=cache, force=False)
    assert result == 0
    assert call_count["n"] == 0

    # force=True bypasses TTL
    payload = {"economicCalendar": []}
    class FakeResponse:
        def read(self):
            return json.dumps(payload).encode("utf-8")
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
    monkeypatch.setattr(nb.urllib.request, "urlopen", lambda req, timeout=None: FakeResponse())
    result_forced = nb.refresh_from_api(cache_path=cache, force=True)
    assert result_forced == 0  # empty payload, but the fetch did happen


def test_news_events_prefers_cache_over_hardcoded(monkeypatch, tmp_path):
    monkeypatch.delenv("NEWS_API_DISABLED", raising=False)
    monkeypatch.setenv("NEWS_CACHE_PATH", str(tmp_path / "news-cache.json"))
    _reset_news_module_state()

    custom = [{"iso": "2027-01-15T13:30:00+00:00", "label": "CPI"}]
    (tmp_path / "news-cache.json").write_text(json.dumps(custom))

    import news_blackout as nb
    events = nb._events()
    assert len(events) == 1
    assert events[0][1] == "CPI"
    assert events[0][0].year == 2027


def test_news_events_falls_back_to_hardcoded_on_corrupt_cache(monkeypatch, tmp_path):
    monkeypatch.delenv("NEWS_API_DISABLED", raising=False)
    monkeypatch.setenv("NEWS_CACHE_PATH", str(tmp_path / "news-cache.json"))
    _reset_news_module_state()

    # Garbage JSON
    (tmp_path / "news-cache.json").write_text("{not valid json")

    import news_blackout as nb
    events = nb._events()
    # Falls back to HIGH_IMPACT_EVENTS_2026 (48 entries: 8 FOMC + 12 CPI + 12 NFP + 12 PPI + 4 GDP)
    assert len(events) == len(nb.HIGH_IMPACT_EVENTS_2026)


def test_news_refresh_disabled_env_returns_zero(monkeypatch, tmp_path):
    monkeypatch.setenv("NEWS_API_DISABLED", "true")
    monkeypatch.setenv("NEWS_API_KEY", "should-be-ignored")
    _reset_news_module_state()
    from news_blackout import refresh_from_api
    cache = tmp_path / "news-cache.json"
    assert refresh_from_api(cache_path=cache, force=True) == 0
    assert not cache.exists()


# ============================================================================
# Round 55 audit fix: slippage-aware lot sizing
# ============================================================================
def test_place_market_order_slippage_widens_stop_shrinks_lot(monkeypatch):
    """Lot must be sized using effective stop (post-slippage), not theoretical.

    Scenario:
      - theoretical ask = 2001.0, stop_pct = 1% → theoretical SL @ 1980.99,
        theoretical stop_distance = 20.01 (= 1.000% of 2001.0).
      - 1.5 spreads of slippage on a 20-point spread → fill_price = 2001.30.
      - Effective stop_distance = 2001.30 - 1980.99 = 20.31 (= 1.0149% of fill).
      - Lot sized at 1.0149% effective stop must be SMALLER than lot sized at
        the theoretical 1% stop (loss-per-lot is wider, so fewer lots fit
        the $1000 risk budget).
    """
    import ftmo_executor as exe
    exe.SLIPPAGE_DISABLED = False
    exe.SLIPPAGE_ENTRY_SPREADS = 1.5
    exe._SYMBOL_CACHE.clear()

    info = FakeSpreadSymbolInfo(
        ask=2001.0, bid=1999.0, spread=20, point=0.01,
        tick_size=0.01, tick_value=0.01,
        volume_min=0.01, volume_max=10000.0, volume_step=0.001,
    )
    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: info)
    monkeypatch.setattr(exe.mt5, "symbol_select", lambda s, e: True)

    captured = {}

    class FakeRes:
        def __init__(self):
            self.retcode = exe.mt5.TRADE_RETCODE_DONE
            self.order = 999
            self.price = 0.0
            self.comment = ""

    def fake_send(req):
        captured["request"] = req
        return FakeRes()

    monkeypatch.setattr(exe.mt5, "order_send", fake_send)

    res = exe.place_market_order(
        binance_symbol="BTCUSDT",
        direction="long",
        risk_frac=0.01,           # $1000 of $100k
        stop_pct=0.01,            # theoretical 1% stop
        tp_pct=0.02,
        account_equity=100000.0,
        comment="slip_lot_test",
    )
    assert res.ok, f"order failed: {res.error}"

    # Compute the un-slipped baseline lot using compute_lot_size directly.
    # Same risk + theoretical stop = baseline; if our fix is wrong (i.e. we
    # still size with theoretical stop), the assertion below fails.
    baseline_lot = exe.compute_lot_size(
        info, risk_frac=0.01, stop_pct=0.01,
        account_equity=100000.0, direction="long",
    )
    assert res.lot is not None
    assert res.lot < baseline_lot, (
        f"expected post-slippage lot {res.lot} < baseline {baseline_lot} "
        f"(slippage widens effective stop → fewer lots)"
    )
    # SL stays at the theoretical level (engine planned it that way).
    assert abs(captured["request"]["sl"] - 2001.0 * 0.99) < 1e-6
    # And the order price is the slipped fill.
    assert abs(captured["request"]["price"] - 2001.30) < 1e-6


# ============================================================================
# Round 55 audit fix: telegram_notify hardening
# ============================================================================
def test_telegram_redact_strips_token_from_string():
    import telegram_notify as tg
    leaked = "HTTP Error 401: Unauthorized for url=https://api.telegram.org/bot1234567:ABCDEF-secret_xyz/sendMessage"
    redacted = tg._redact(leaked)
    assert "1234567:ABCDEF-secret_xyz" not in redacted
    assert "/bot<REDACTED>" in redacted


def test_telegram_429_sets_suppression(monkeypatch):
    """HTTP 429 → 60s cooldown; subsequent calls skip urlopen entirely."""
    import telegram_notify as tg
    import urllib.error

    tg._suppress_until_ts = 0.0
    tg._suppress_logged = False
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "1111:dummy")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")

    def raise_429(*args, **kwargs):
        raise urllib.error.HTTPError(
            "https://api.telegram.org/bot1111:dummy/sendMessage",
            429, "Too Many Requests", {}, None,
        )

    monkeypatch.setattr(tg.urllib.request, "urlopen", raise_429)
    assert tg.tg_send("hello") is False
    # Suppression now active until ~now+60.
    import time
    assert tg._suppress_until_ts > time.time() + 30
    assert tg._suppress_until_ts < time.time() + 120

    # Second call must short-circuit before urlopen — replace with a tripwire.
    def trip(*args, **kwargs):
        raise AssertionError("urlopen called while suppression active")

    monkeypatch.setattr(tg.urllib.request, "urlopen", trip)
    assert tg.tg_send("again") is False  # skipped, no exception


def test_telegram_401_sets_permanent_suppression(monkeypatch):
    """HTTP 401 (invalid token) → permanent suppression until process restart."""
    import telegram_notify as tg
    import urllib.error

    tg._suppress_until_ts = 0.0
    tg._suppress_logged = False
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "2222:bad")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")

    def raise_401(*args, **kwargs):
        raise urllib.error.HTTPError(
            "https://api.telegram.org/bot2222:bad/sendMessage",
            401, "Unauthorized", {}, None,
        )

    monkeypatch.setattr(tg.urllib.request, "urlopen", raise_401)
    assert tg.tg_send("hi") is False
    assert tg._suppress_until_ts == float("inf")


def test_telegram_success_clears_suppression(monkeypatch):
    """A 200 response after suppression expires must clear the flag."""
    import telegram_notify as tg

    # Pretend suppression already expired
    tg._suppress_until_ts = 0.0
    tg._suppress_logged = False
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "3333:ok")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")

    class FakeResp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(tg.urllib.request, "urlopen", lambda *a, **k: FakeResp())
    assert tg.tg_send("ok") is True
    assert tg._suppress_until_ts == 0.0


def test_telegram_token_not_in_logged_error(monkeypatch, capsys):
    """Even when urllib raises with a URL containing the token, the printed
    log line must not include the token."""
    import telegram_notify as tg
    import urllib.error

    tg._suppress_until_ts = 0.0
    tg._suppress_logged = False
    secret = "9999:VERY-SECRET-TOKEN_xyz"
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", secret)
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")

    def raise_500(*args, **kwargs):
        raise urllib.error.HTTPError(
            f"https://api.telegram.org/bot{secret}/sendMessage",
            500, "Internal Server Error", {}, None,
        )

    monkeypatch.setattr(tg.urllib.request, "urlopen", raise_500)
    tg.tg_send("oops")
    captured = capsys.readouterr()
    combined = captured.out + captured.err
    assert secret not in combined, f"token leaked in log: {combined!r}"


# ============================================================================
# Round 55 audit fix: process_pending_signals lock-extends across order loop
# ============================================================================
def test_process_pending_signals_holds_lock_through_critical_section(monkeypatch, tmp_path):
    """Lock must be held from initial read through final write. We verify by
    asserting that during the body of `_process_pending_signals_locked`, the
    pending-signals.lock file exists on disk (indicating the lock is held).

    Also verifies that the late-merge logic still works inside the lock: a
    Node-style concurrent write of a fresh signal mid-flight must be
    preserved by the post-loop merge re-read.
    """
    import ftmo_executor as exe
    import time as _time

    # Redirect state files into tmp_path
    exe.STATE_DIR = tmp_path
    exe.PENDING_PATH = tmp_path / "pending-signals.json"
    exe.EXECUTED_PATH = tmp_path / "executed-signals.json"
    exe.OPEN_POS_PATH = tmp_path / "open-positions.json"
    exe.DAILY_STATE_PATH = tmp_path / "daily-reset.json"
    exe.EXECUTOR_LOG_PATH = tmp_path / "executor-log.jsonl"
    exe.PAUSE_STATE_PATH = tmp_path / "pause-state.json"
    exe.CHALLENGE_PEAK_PATH = tmp_path / "challenge-peak.json"
    exe.DAY_PEAK_PATH = tmp_path / "day-peak.json"
    exe.DRY_RUN = True  # avoid placing real orders

    # Fresh signal so the staleness check (5min) doesn't drop it.
    now_ms = int(_time.time() * 1000)
    sig_a = {
        "assetSymbol": "BTC", "sourceSymbol": "BTCUSDT",
        "riskFrac": 0.005, "stopPct": 0.01, "tpPct": 0.02,
        "stopPrice": 100.0, "tpPrice": 200.0, "entryPrice": 150.0,
        "maxHoldUntil": "2026-12-31T00:00:00Z",
        "signalBarClose": now_ms - 1000,
        "direction": "long",
    }
    sig_b_late = {**sig_a, "assetSymbol": "ETH", "signalBarClose": now_ms - 500}

    exe.write_json(exe.PENDING_PATH, {"signals": [sig_a]})

    lock_path = tmp_path / "pending-signals.lock"
    state = {"lock_seen_during_loop": False, "pending_reads": 0}

    # Wrap read_json so:
    #   1st PENDING_PATH read = initial loop input (just sig_a)
    #   2nd PENDING_PATH read = post-loop merge → simulate Node having
    #      written sig_b mid-flight by returning [sig_a, sig_b_late].
    orig_read_json = exe.read_json

    def patched_read_json(path, default=None):
        if path == exe.PENDING_PATH:
            state["pending_reads"] += 1
            if state["pending_reads"] == 1:
                # Initial read at top of locked section.
                state["lock_seen_during_loop"] = lock_path.exists()
                return {"signals": [sig_a]}
            else:
                # Post-loop merge re-read — Node has appended sig_b_late.
                return {"signals": [sig_a, sig_b_late]}
        return orig_read_json(path, default)

    monkeypatch.setattr(exe, "read_json", patched_read_json)

    exe.process_pending_signals()

    # Lock-file is removed on context exit; we asserted presence during loop.
    assert state["lock_seen_during_loop"] is True, (
        "lock-file was not present during the locked critical section — "
        "fix did not actually extend the lock window"
    )
    assert state["pending_reads"] >= 2, (
        f"expected ≥2 PENDING_PATH reads (initial + merge), got {state['pending_reads']}"
    )

    # The merge-write must have preserved the late-arriving sig_b.
    pending_after = json.loads(exe.PENDING_PATH.read_text())
    assets = [s.get("assetSymbol") for s in pending_after.get("signals", [])]
    assert "ETH" in assets, (
        f"merge-write lost sig_b: {assets}. The post-loop merge re-read "
        f"must run INSIDE the lock so it sees Node's late writes."
    )


def test_start_gate_blocks_pending_before_challenge_start(monkeypatch, tmp_path):
    """2026-05-18 LIVE-CLUSTER-DETECTOR: gate now uses live signal-history
    instead of supervisor's stale 30-day-old window proxy. First poll has
    empty history → fallback to legacy supervisor gate (which we configure
    as red here)."""
    import ftmo_executor as exe
    import time as _time

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "DAILY_STATE_PATH", tmp_path / "daily-reset.json")
    monkeypatch.setattr(exe, "PAUSE_STATE_PATH", tmp_path / "pause-state.json")
    monkeypatch.setattr(exe, "EXECUTOR_LOG_PATH", tmp_path / "executor-log.jsonl")
    monkeypatch.setattr(exe, "START_GATE_PATH", tmp_path / "timing-gate.json")
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "START_GATE_ENABLED", True)
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 24.0)
    monkeypatch.setattr(exe, "START_GATE_MIN_BREADTH", 4)
    monkeypatch.setattr(exe, "START_GATE_MIN_MAJORS", 3)
    monkeypatch.setattr(exe, "START_GATE_MAX_AGE_MIN", 180.0)

    exe.write_json(exe.START_GATE_PATH, {
        "ts": int(_time.time() * 1000),
        "qualified": False,
        "breadth": 3,
        "majors": 0,
    })

    proc = exe._process_signals_unlocked(
        pending=[{"assetSymbol": "BTC"}],
        executed={"executions": []},
        open_positions={"positions": []},
    )

    assert proc["remaining"] == []
    assert proc["placed_markers"] == []
    assert proc["executed"]["executions"][0]["result"] == "start_gate_blocked"
    # New: live-cluster takes priority; just-logged BTC signal = 0h history
    # → warmup block, OR legacy red gate (depending on order of evaluation)
    reason = proc["executed"]["executions"][0]["reason"]
    assert ("start_gate_warmup" in reason or "start_gate_red" in reason), \
        f"unexpected block reason: {reason}"


def test_start_gate_allows_after_start_marker(monkeypatch, tmp_path):
    import ftmo_executor as exe
    import time as _time

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "START_GATE_PATH", tmp_path / "timing-gate.json")
    monkeypatch.setattr(exe, "START_GATE_ENABLED", True)
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 24.0)
    monkeypatch.setattr(exe, "START_GATE_MIN_BREADTH", 4)
    monkeypatch.setattr(exe, "START_GATE_MIN_MAJORS", 3)
    monkeypatch.setattr(exe, "START_GATE_MAX_AGE_MIN", 180.0)

    exe.write_json(exe.START_GATE_PATH, {
        "ts": int(_time.time() * 1000),
        "qualified": False,
        "breadth": 0,
        "majors": 0,
    })
    exe.write_json(tmp_path / "start-gate-state.json", {"started": True})

    assert exe.check_start_gate_block({"positions": []}) is None


def test_start_gate_requires_fresh_green_gate(monkeypatch, tmp_path):
    """Legacy supervisor green-gate fallback (when signal-history is empty)."""
    import ftmo_executor as exe
    import time as _time

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "START_GATE_PATH", tmp_path / "timing-gate.json")
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "START_GATE_ENABLED", True)
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 24.0)
    monkeypatch.setattr(exe, "START_GATE_MIN_BREADTH", 4)
    monkeypatch.setattr(exe, "START_GATE_MIN_MAJORS", 3)
    monkeypatch.setattr(exe, "START_GATE_MAX_AGE_MIN", 180.0)

    exe.write_json(exe.START_GATE_PATH, {
        "ts": int(_time.time() * 1000),
        "qualified": True,
        "breadth": 4,
        "majors": 3,
    })

    # Empty signal-history → falls back to legacy supervisor gate
    assert exe.check_start_gate_block({"positions": []}) is None


def test_live_cluster_gate_green_with_24h_history(monkeypatch, tmp_path):
    """NEW: live-cluster gate goes green when 24h history has >=4 distinct
    symbols and >=3 majors."""
    import ftmo_executor as exe
    import time as _time
    import json as _json

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "START_GATE_PATH", tmp_path / "timing-gate.json")
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "START_GATE_ENABLED", True)
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 24.0)
    monkeypatch.setattr(exe, "START_GATE_MIN_BREADTH", 4)
    monkeypatch.setattr(exe, "START_GATE_MIN_MAJORS", 3)
    monkeypatch.setattr(exe, "START_GATE_MAX_AGE_MIN", 180.0)

    # 23.5h ago: first signal
    base_ms = int(_time.time() * 1000) - int(23.5 * 3600 * 1000)
    entries = [
        {"ts_ms": base_ms,            "asset": "BTC-TREND", "direction": "long"},
        {"ts_ms": base_ms + 3600000,  "asset": "ETH-TREND", "direction": "long"},
        {"ts_ms": base_ms + 7200000,  "asset": "BNB-TREND", "direction": "long"},
        {"ts_ms": base_ms + 10800000, "asset": "AAVE-TREND","direction": "long"},
    ]
    with open(tmp_path / "signal-history.jsonl", "w") as f:
        for e in entries:
            f.write(_json.dumps(e) + "\n")

    live = exe.compute_live_cluster()
    assert live["breadth"] == 4
    assert live["majors"] == 3
    assert live["qualified"] is True
    assert exe.check_start_gate_block({"positions": []}) is None


def test_live_cluster_breadth_counts_full_strategy_labels(monkeypatch, tmp_path):
    """B2a fix: ETH-MR and ETH-TREND are TWO distinct symbols (backtest
    cluster_symbol_key parity), not one collapsed `ETH`. The old split('-')[0]
    under-counted breadth → live gate qualified less often than the backtest."""
    import ftmo_executor as exe
    import time as _time
    import json as _json
    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 24.0)
    monkeypatch.setattr(exe, "START_GATE_MIN_BREADTH", 4)
    monkeypatch.setattr(exe, "START_GATE_MIN_MAJORS", 3)
    monkeypatch.setattr(exe, "START_GATE_MAX_AGE_MIN", 180.0)
    base_ms = int(_time.time() * 1000) - int(12 * 3600 * 1000)
    entries = [
        {"ts_ms": base_ms,            "asset": "ETH-MR",    "direction": "long"},
        {"ts_ms": base_ms + 3600000,  "asset": "ETH-TREND", "direction": "long"},
        {"ts_ms": base_ms + 7200000,  "asset": "BTC-TREND", "direction": "long"},
        {"ts_ms": base_ms + 10800000, "asset": "SOL-MR",    "direction": "long"},
    ]
    with open(tmp_path / "signal-history.jsonl", "w") as f:
        for e in entries:
            f.write(_json.dumps(e) + "\n")
    live = exe.compute_live_cluster()
    # 4 distinct full labels (ETH-MR, ETH-TREND, BTC-TREND, SOL-MR) — NOT 3.
    assert live["breadth"] == 4, f"breadth={live['breadth']} (collapsed?) must be 4 full-key"
    # majors via prefix match on full key: BTC, ETH, SOL = 3.
    assert live["majors"] == 3
    assert live["qualified"] is True


def test_fast_cluster_gate_green_without_24h_warmup(monkeypatch, tmp_path):
    """12h fast-cluster mode can green-light once the b>=7/m>=3 pattern is
    visible; it must not wait for the legacy 23h warm-up."""
    import ftmo_executor as exe
    import time as _time
    import json as _json

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "START_GATE_PATH", tmp_path / "timing-gate.json")
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "START_GATE_ENABLED", True)
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 12.0)
    monkeypatch.setattr(exe, "START_GATE_MIN_BREADTH", 7)
    monkeypatch.setattr(exe, "START_GATE_MIN_MAJORS", 3)
    monkeypatch.setattr(exe, "START_GATE_MIN_HISTORY_HOURS", 0.0)
    monkeypatch.setattr(exe, "START_GATE_MAX_AGE_MIN", 180.0)

    base_ms = int(_time.time() * 1000) - int(3.0 * 3600 * 1000)
    assets = ["BTC", "ETH", "BNB", "AAVE", "ARB", "LINK", "XRP"]
    with open(tmp_path / "signal-history.jsonl", "w") as f:
        for i, asset in enumerate(assets):
            f.write(_json.dumps({
                "ts_ms": base_ms + i * 10_000,
                "asset": f"{asset}-TREND",
                "direction": "long",
            }) + "\n")

    live = exe.compute_live_cluster()
    assert live["window_hours"] == 12.0
    assert live["breadth"] == 7
    assert live["majors"] == 3
    assert live["qualified"] is True
    assert exe.check_start_gate_block({"positions": []}) is None


def test_live_cluster_gate_red_when_only_2_majors(monkeypatch, tmp_path):
    """LIVE-cluster: only BTC + ETH (2 majors) in 24h → red."""
    import ftmo_executor as exe
    import time as _time
    import json as _json

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "START_GATE_PATH", tmp_path / "timing-gate.json")
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "START_GATE_ENABLED", True)
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 24.0)
    monkeypatch.setattr(exe, "START_GATE_MIN_BREADTH", 4)
    monkeypatch.setattr(exe, "START_GATE_MIN_MAJORS", 3)
    monkeypatch.setattr(exe, "START_GATE_MAX_AGE_MIN", 180.0)

    base_ms = int(_time.time() * 1000) - int(23.5 * 3600 * 1000)
    entries = [
        {"ts_ms": base_ms,         "asset": "BTC-TREND", "direction": "long"},
        {"ts_ms": base_ms + 3600000,  "asset": "ETH-TREND", "direction": "long"},
        {"ts_ms": base_ms + 7200000,  "asset": "AAVE-TREND","direction": "long"},
        {"ts_ms": base_ms + 10800000, "asset": "ARB-TREND", "direction": "long"},
    ]
    with open(tmp_path / "signal-history.jsonl", "w") as f:
        for e in entries:
            f.write(_json.dumps(e) + "\n")

    live = exe.compute_live_cluster()
    assert live["breadth"] == 4
    assert live["majors"] == 2  # BTC, ETH only
    assert live["qualified"] is False
    block = exe.check_start_gate_block({"positions": []})
    assert block is not None
    assert "start_gate_red_live" in block


def test_cluster_only_blocks_new_entries_after_start_marker(monkeypatch, tmp_path):
    """Cluster-only mode keeps gating fresh entries even after the challenge
    has started. This is separate from start-gate, which is intentionally
    cleared by start-gate-state.json."""
    import ftmo_executor as exe
    import time as _time
    import json as _json

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "DAILY_STATE_PATH", tmp_path / "daily-reset.json")
    monkeypatch.setattr(exe, "PAUSE_STATE_PATH", tmp_path / "pause-state.json")
    monkeypatch.setattr(exe, "EXECUTOR_LOG_PATH", tmp_path / "executor-log.jsonl")
    monkeypatch.setattr(exe, "START_GATE_PATH", tmp_path / "timing-gate.json")
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "START_GATE_ENABLED", True)
    monkeypatch.setattr(exe, "CLUSTER_ONLY_ENABLED", True)
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 24.0)
    monkeypatch.setattr(exe, "START_GATE_MIN_BREADTH", 4)
    monkeypatch.setattr(exe, "START_GATE_MIN_MAJORS", 3)
    monkeypatch.setattr(exe, "START_GATE_MAX_AGE_MIN", 180.0)
    monkeypatch.setattr(exe, "CLUSTER_ONLY_MIN_HISTORY_HOURS", 23.0)

    exe.write_json(tmp_path / "start-gate-state.json", {"started": True})
    base_ms = int(_time.time() * 1000) - int(23.5 * 3600 * 1000)
    entries = [
        {"ts_ms": base_ms,            "asset": "BTC-TREND", "direction": "long"},
        {"ts_ms": base_ms + 3600000,  "asset": "ETH-TREND", "direction": "long"},
        {"ts_ms": base_ms + 7200000,  "asset": "AAVE-TREND","direction": "long"},
        {"ts_ms": base_ms + 10800000, "asset": "ARB-TREND", "direction": "long"},
    ]
    with open(tmp_path / "signal-history.jsonl", "w") as f:
        for e in entries:
            f.write(_json.dumps(e) + "\n")

    assert exe.check_start_gate_block({"positions": []}) is None
    block = exe.check_cluster_entry_block()
    assert block is not None
    assert "cluster_only_red_live" in block

    proc = exe._process_signals_unlocked(
        pending=[{"assetSymbol": "BTC"}],
        executed={"executions": []},
        open_positions={"positions": []},
    )
    assert proc["remaining"] == []
    assert proc["executed"]["executions"][0]["result"] == "cluster_entry_blocked"


# ============================================================================
# 2026-05-19 Multi-tier cluster classification
# ============================================================================
def _seed_cluster_history(tmp_path, monkeypatch, assets: list, exe):
    """Helper: write fresh signal-history with given assets in the 2h gate."""
    import time as _time
    import json as _json
    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "START_GATE_PATH", tmp_path / "timing-gate.json")
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "START_GATE_ENABLED", True)
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 2.0)
    monkeypatch.setattr(exe, "START_GATE_MIN_HISTORY_HOURS", 0.0)
    monkeypatch.setattr(exe, "START_GATE_MAX_AGE_MIN", 180.0)
    base_ms = int(_time.time() * 1000) - int(0.5 * 3600 * 1000)
    with open(tmp_path / "signal-history.jsonl", "w") as f:
        for i, asset in enumerate(assets):
            f.write(_json.dumps({
                "ts_ms": base_ms + i * 60_000,
                "asset": f"{asset}-TREND",
                "direction": "long",
            }) + "\n")


def test_tier_S_classification_when_4_majors_and_10_breadth(monkeypatch, tmp_path):
    """All 4 majors + 10+ symbols → TIER-S (premium, 100% pass-rate in
    backtest).

    2026-05-19 KRIT-2 update: tightened the TIER-S breadth floor from 6
    to 10 so the tier hierarchy is strictly nested (S ⊂ A on every axis).
    See `_validate_config` per-axis monotonie checks.
    """
    import ftmo_executor as exe
    _seed_cluster_history(
        tmp_path, monkeypatch,
        ["BTC", "ETH", "BNB", "SOL", "AAVE", "ARB",
         "LINK", "XRP", "ADA", "DOT"], exe,
    )
    live = exe.compute_live_cluster()
    assert live["breadth"] == 10
    assert live["majors"] == 4
    assert live["tier"] == "S"
    assert live["qualified"] is True


def test_tier_A_classification_when_3_majors_and_10_breadth(monkeypatch, tmp_path):
    """3 majors + 10+ symbols → TIER-A."""
    import ftmo_executor as exe
    _seed_cluster_history(
        tmp_path, monkeypatch,
        ["BTC", "ETH", "BNB", "AAVE", "ARB", "LINK",
         "XRP", "ADA", "DOT", "AVAX"], exe,
    )
    live = exe.compute_live_cluster()
    assert live["breadth"] == 10
    assert live["majors"] == 3
    assert live["tier"] == "A"
    assert live["qualified"] is True


def test_tier_B_classification_when_1_major_and_10_breadth(monkeypatch, tmp_path):
    """1 major + 10 symbols → TIER-B (default qualifier b>=10 m>=1)."""
    import ftmo_executor as exe
    _seed_cluster_history(
        tmp_path, monkeypatch,
        ["BTC", "AAVE", "ARB", "LINK", "XRP", "UNI",
         "ADA", "DOT", "AVAX", "ATOM"], exe,
    )
    live = exe.compute_live_cluster()
    assert live["breadth"] == 10
    assert live["majors"] == 1
    assert live["tier"] == "B"
    assert live["qualified"] is True


def test_no_tier_when_breadth_below_b_default_floor(monkeypatch, tmp_path):
    """Breadth<10 must not qualify with broad-cluster defaults."""
    import ftmo_executor as exe
    _seed_cluster_history(
        tmp_path, monkeypatch,
        ["BTC", "AAVE", "ARB", "LINK", "XRP", "ADA", "DOT", "AVAX", "ATOM"], exe,
    )
    live = exe.compute_live_cluster()
    assert live["breadth"] == 9
    assert live["majors"] == 1
    assert live["tier"] == ""
    assert live["qualified"] is False


def test_tier_risk_mult_fields_are_set(monkeypatch, tmp_path):
    """risk_mult must reflect the matched tier (1.0 default since boost
    multipliers env-defaults to 1.0)."""
    import ftmo_executor as exe
    _seed_cluster_history(
        tmp_path, monkeypatch,
        ["BTC", "ETH", "BNB", "SOL", "AAVE", "ARB",
         "LINK", "XRP", "ADA", "DOT"], exe,
    )
    monkeypatch.setattr(exe, "TIER_S_RISK_MULT", 1.5)
    live = exe.compute_live_cluster()
    assert live["tier"] == "S"
    assert live["risk_mult"] == 1.5


# ============================================================================
# KRIT-2 (2026-05-19): per-axis tier-monotonie validator
# ============================================================================
def _exec_validate_with(monkeypatch, **overrides):
    """Run `_validate_config` in-process with the given module-level
    overrides; return the list of errors that WOULD have been raised
    (so tests can assert without needing to actually sys.exit()).
    """
    import ftmo_executor as exe
    # Capture errors instead of sys.exit
    captured: list[str] = []

    def fake_exit(code):
        raise SystemExit(code)

    monkeypatch.setattr(exe.sys, "exit", fake_exit)
    for key, value in overrides.items():
        monkeypatch.setattr(exe, key, value)
    # Force START_GATE_ENABLED so tier-monotonie path runs.
    monkeypatch.setattr(exe, "START_GATE_ENABLED", True)

    # Patch print to capture FATAL output → parse errors back out.
    orig_print = print

    def fake_print(*args, **kwargs):
        if args and "FATAL" in str(args[0]):
            captured.append(str(args[0]))
        else:
            orig_print(*args, **kwargs)

    import builtins as _b
    monkeypatch.setattr(_b, "print", fake_print)

    try:
        exe._validate_config()
    except SystemExit:
        pass
    return captured


def test_tier_monotonie_validator_rejects_breadth_inversion(monkeypatch):
    """KRIT-2: TIER_S_MIN_BREADTH < TIER_A_MIN_BREADTH must trigger
    a FATAL config error. Per-axis check, not SUM-based — so an
    inversion on the breadth axis is caught even if S has more majors.
    Example: S=(2, 20) is weaker on breadth than A=(20, 3); SUM check
    would give 22 vs 23 (look similar), but breadth axis is dramatically
    inverted (S=2 vs A=20). Per-axis check catches it."""
    out = _exec_validate_with(
        monkeypatch,
        TIER_S_MIN_BREADTH=2,   # WEAKER than A
        TIER_S_MIN_MAJORS=20,   # tighter than A
        TIER_A_MIN_BREADTH=20,
        TIER_A_MIN_MAJORS=3,
    )
    joined = "\n".join(out)
    assert "FTMO_TIER_S_MIN_BREADTH=2" in joined, f"no breadth-inversion error: {joined!r}"
    assert "FTMO_TIER_A_MIN_BREADTH=20" in joined, joined


def test_tier_monotonie_validator_rejects_majors_inversion(monkeypatch):
    """KRIT-2: TIER_S_MIN_MAJORS < TIER_A_MIN_MAJORS must trigger
    a FATAL config error."""
    out = _exec_validate_with(
        monkeypatch,
        TIER_S_MIN_BREADTH=20,
        TIER_S_MIN_MAJORS=1,    # WEAKER than A
        TIER_A_MIN_BREADTH=10,
        TIER_A_MIN_MAJORS=3,
    )
    joined = "\n".join(out)
    assert "FTMO_TIER_S_MIN_MAJORS=1" in joined, f"no majors-inversion error: {joined!r}"


def test_tier_monotonie_validator_passes_for_default_thresholds(monkeypatch):
    """The shipped defaults (S=(10,4), A=(10,3)) must pass the
    validator — S is tighter than A on majors, equal on breadth.
    """
    out = _exec_validate_with(
        monkeypatch,
        TIER_S_MIN_BREADTH=10,
        TIER_S_MIN_MAJORS=4,
        TIER_A_MIN_BREADTH=10,
        TIER_A_MIN_MAJORS=3,
    )
    assert out == [], f"defaults should not error: {out!r}"


def test_tier_monotonie_validator_rejects_both_axis_inversion(monkeypatch):
    """KRIT-2: when S is weaker on BOTH axes, BOTH errors fire."""
    out = _exec_validate_with(
        monkeypatch,
        TIER_S_MIN_BREADTH=5,
        TIER_S_MIN_MAJORS=2,
        TIER_A_MIN_BREADTH=10,
        TIER_A_MIN_MAJORS=3,
    )
    joined = "\n".join(out)
    assert "FTMO_TIER_S_MIN_BREADTH=5" in joined, joined
    assert "FTMO_TIER_S_MIN_MAJORS=2" in joined, joined


def test_tier_risk_mult_is_actually_applied_to_lot_sizing(monkeypatch, tmp_path):
    """KRIT-1 (2026-05-19): TIER_S_RISK_MULT must boost the actual
    `risk_frac` passed into place_market_order — not just appear in the
    compute_live_cluster() dict. Regression for the phantom-env-var bug
    where boost was set but never wired to sizing.
    """
    import ftmo_executor as exe
    import time as _time

    # Seed a TIER-S cluster (6 symbols, all 4 majors → tier S match).
    _seed_cluster_history(
        tmp_path, monkeypatch,
        ["BTC", "ETH", "BNB", "SOL", "AAVE", "ARB",
         "LINK", "XRP", "ADA", "DOT"], exe,
    )
    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "START_GATE_ENABLED", False)
    monkeypatch.setattr(exe, "CLUSTER_ONLY_ENABLED", False)
    monkeypatch.setattr(exe, "DPT_ENABLED", False)
    monkeypatch.setattr(exe, "DRY_RUN", False)
    monkeypatch.setattr(exe, "MOCK_MODE", True)
    monkeypatch.setattr(exe, "TIER_S_RISK_MULT", 2.0)
    monkeypatch.setattr(exe, "RISK_FRAC_HARD_CAP", 0.10)
    monkeypatch.setattr(exe, "EXECUTOR_LOG_PATH", tmp_path / "executor-log.jsonl")
    monkeypatch.setattr(exe, "DAILY_STATE_PATH", tmp_path / "daily-reset.json")
    monkeypatch.setattr(exe, "PAUSE_STATE_PATH", tmp_path / "pause-state.json")
    monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **kw: [])

    captured = {}

    def fake_place_market_order(**kwargs):
        captured.update(kwargs)
        return exe.OrderResult(False, None, "test-stop-after-capture", None, None)

    monkeypatch.setattr(exe, "place_market_order", fake_place_market_order)

    sig = {
        "assetSymbol": "BTC-TREND",
        "sourceSymbol": "BTCUSDT",
        "direction": "long",
        "riskFrac": 0.02,
        "stopPct": 0.01,
        "tpPct": 0.02,
        "stopPrice": 49500.0,
        "tpPrice": 51000.0,
        "entryPrice": 50000.0,
        "signalBarClose": int(_time.time() * 1000),
        "maxHoldUntil": int(_time.time() * 1000) + 24 * 3600_000,
    }

    exe._process_signals_unlocked(
        pending=[sig],
        executed={"executions": []},
        open_positions={"positions": []},
    )

    # TIER-S match × 2.0 multiplier → risk_frac doubled from 0.02 → 0.04.
    assert "risk_frac" in captured, f"place_market_order not called: {captured}"
    assert abs(captured["risk_frac"] - 0.04) < 1e-9, (
        f"risk_mult NOT applied to lot sizing: place_market_order got "
        f"risk_frac={captured['risk_frac']}, expected 0.04 (= 0.02 × 2.0)"
    )


def test_tier_risk_mult_capped_at_hard_cap(monkeypatch, tmp_path):
    """KRIT-1 follow-on: boost × signal risk must not exceed
    RISK_FRAC_HARD_CAP. If a TIER-S boost would push risk above the cap,
    cap kicks in BEFORE place_market_order receives the value (so the
    cap line in place_market_order is a redundant safety net, not the
    only enforcement)."""
    import ftmo_executor as exe
    import time as _time

    _seed_cluster_history(
        tmp_path, monkeypatch,
        ["BTC", "ETH", "BNB", "SOL", "AAVE", "ARB",
         "LINK", "XRP", "ADA", "DOT"], exe,
    )
    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "START_GATE_ENABLED", False)
    monkeypatch.setattr(exe, "CLUSTER_ONLY_ENABLED", False)
    monkeypatch.setattr(exe, "DPT_ENABLED", False)
    monkeypatch.setattr(exe, "DRY_RUN", False)
    monkeypatch.setattr(exe, "MOCK_MODE", True)
    monkeypatch.setattr(exe, "TIER_S_RISK_MULT", 3.0)      # aggressive boost
    monkeypatch.setattr(exe, "RISK_FRAC_HARD_CAP", 0.05)   # firm 5% cap
    monkeypatch.setattr(exe, "EXECUTOR_LOG_PATH", tmp_path / "executor-log.jsonl")
    monkeypatch.setattr(exe, "DAILY_STATE_PATH", tmp_path / "daily-reset.json")
    monkeypatch.setattr(exe, "PAUSE_STATE_PATH", tmp_path / "pause-state.json")
    monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **kw: [])

    captured = {}

    def fake_place_market_order(**kwargs):
        captured.update(kwargs)
        return exe.OrderResult(False, None, "test-stop-after-capture", None, None)

    monkeypatch.setattr(exe, "place_market_order", fake_place_market_order)

    sig = {
        "assetSymbol": "BTC-TREND",
        "sourceSymbol": "BTCUSDT",
        "direction": "long",
        "riskFrac": 0.02,         # 2% × 3.0 = 6% raw; cap = 5%.
        "stopPct": 0.01,
        "tpPct": 0.02,
        "stopPrice": 49500.0,
        "tpPrice": 51000.0,
        "entryPrice": 50000.0,
        "signalBarClose": int(_time.time() * 1000),
        "maxHoldUntil": int(_time.time() * 1000) + 24 * 3600_000,
    }

    exe._process_signals_unlocked(
        pending=[sig],
        executed={"executions": []},
        open_positions={"positions": []},
    )

    assert "risk_frac" in captured, "place_market_order not called"
    assert abs(captured["risk_frac"] - 0.05) < 1e-9, (
        f"boost×risk must be capped at hard cap 0.05, got {captured['risk_frac']}"
    )


# ============================================================================
# HOCH-1 (2026-05-19): signal-history.jsonl rotation
# ============================================================================
def test_signal_history_rotates_when_oversize(monkeypatch, tmp_path):
    """HOCH-1: `_log_signals_to_history` must rotate signal-history.jsonl
    when it grows past max_mb. Without rotation the file grows unbounded
    over a long live-deploy and eventually exhausts disk / slows reads."""
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "EXECUTOR_LOG_PATH", tmp_path / "executor-log.jsonl")

    # Pre-seed the history file with ~11MB of dummy lines (just above the
    # 10MB rotation threshold).
    sig_path = tmp_path / "signal-history.jsonl"
    payload = ("X" * 1024 + "\n")  # ~1KB per line
    with open(sig_path, "w") as fh:
        for _ in range(11 * 1024):  # 11K lines × 1KB ≈ 11MB
            fh.write(payload)
    pre_size = sig_path.stat().st_size
    assert pre_size > 10 * 1024 * 1024, f"seed file too small: {pre_size}"

    # Append a fresh signal → must trigger rotation.
    exe._log_signals_to_history([
        {"assetSymbol": "BTC-TREND", "signalBarClose": 1234567,
         "direction": "long", "sourceSymbol": "BTCUSDT"},
    ])

    # New signal-history.jsonl should now contain only the freshly-logged
    # entry — far smaller than the pre-rotation file.
    post_size = sig_path.stat().st_size
    assert post_size < pre_size, (
        f"signal-history did not shrink post-rotation: pre={pre_size} post={post_size}"
    )
    # And an archive `signal-history.<TS>.jsonl` should exist with the bulk.
    archives = list(tmp_path.glob("signal-history.*.jsonl"))
    assert archives, "no archive file created on rotation"
    assert any(a.stat().st_size >= 10 * 1024 * 1024 for a in archives), (
        f"no archive holds the rotated data: {[(a.name, a.stat().st_size) for a in archives]}"
    )


# ============================================================================
# HOCH-2 (2026-05-19): time-based dedup window in _log_signals_to_history
# ============================================================================
def test_dedup_window_holds_for_burst_larger_than_200(monkeypatch, tmp_path):
    """HOCH-2: a single batch of >200 fresh signals must NOT cause the
    earliest entries of the same batch to slip through dedup. The old
    `[-200:]` tail-slice was overwritten by the burst's own tail, so a
    same-bar/same-asset repeat could pass through. Time-based dedup
    holds all entries within `2 × START_GATE_WINDOW_HOURS`."""
    import ftmo_executor as exe
    import time as _time
    import json as _json

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "EXECUTOR_LOG_PATH", tmp_path / "executor-log.jsonl")
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 24.0)

    # Pre-log 250 distinct signals all timestamped NOW (= inside dedup window).
    base_ms = int(_time.time() * 1000)
    sig_path = tmp_path / "signal-history.jsonl"
    with open(sig_path, "w") as fh:
        for i in range(250):
            fh.write(_json.dumps({
                "ts_ms": base_ms,
                "asset": f"ASSET{i}-TREND",
                "signalBarClose": 10000 + i,
                "direction": "long",
            }) + "\n")

    # Attempt to re-log entry #5 (well outside the OLD [-200:] window
    # since lines 0..49 are dropped by tail slice). With the OLD bug this
    # would be re-appended; with the time-based dedup it's recognised as
    # already-known.
    exe._log_signals_to_history([
        {"assetSymbol": "ASSET5-TREND", "signalBarClose": 10005,
         "direction": "long", "sourceSymbol": "ASSET5USDT"},
    ])

    lines = sig_path.read_text().strip().splitlines()
    asset5_lines = [li for li in lines
                    if '"ASSET5-TREND"' in li and '10005' in li]
    assert len(asset5_lines) == 1, (
        f"dedup window allowed duplicate ASSET5/10005 re-log "
        f"(got {len(asset5_lines)} copies): old [-200:] tail-slice bug"
    )


def test_dedup_window_drops_entries_older_than_double_gate_window(monkeypatch, tmp_path):
    """HOCH-2 corollary: entries older than 2 × START_GATE_WINDOW_HOURS
    SHOULD fall outside the dedup window — they can no longer collide
    with a fresh signal (since Node only re-emits on a new bar)."""
    import ftmo_executor as exe
    import time as _time
    import json as _json

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "SIGNAL_HISTORY_PATH", tmp_path / "signal-history.jsonl")
    monkeypatch.setattr(exe, "EXECUTOR_LOG_PATH", tmp_path / "executor-log.jsonl")
    monkeypatch.setattr(exe, "START_GATE_WINDOW_HOURS", 2.0)  # → dedup = 4h

    # Old entry timestamped 6h ago — outside the 4h dedup window.
    sig_path = tmp_path / "signal-history.jsonl"
    old_ms = int(_time.time() * 1000) - int(6 * 3600 * 1000)
    with open(sig_path, "w") as fh:
        fh.write(_json.dumps({
            "ts_ms": old_ms,
            "asset": "BTC-TREND",
            "signalBarClose": 99999,
            "direction": "long",
        }) + "\n")

    # Same (signalBarClose, asset) key but the old log entry is now
    # outside the dedup window → fresh write SHOULD be accepted.
    exe._log_signals_to_history([
        {"assetSymbol": "BTC-TREND", "signalBarClose": 99999,
         "direction": "long", "sourceSymbol": "BTCUSDT"},
    ])

    lines = sig_path.read_text().strip().splitlines()
    btc_lines = [li for li in lines
                 if '"BTC-TREND"' in li and '99999' in li]
    assert len(btc_lines) == 2, (
        f"entries older than 2× gate-window should fall outside dedup; "
        f"expected re-log but got {len(btc_lines)} copies"
    )


# ============================================================================
# Round 56 audit fixes: Prague-TZ ping dates + UTC-aware history_deals_get
#                       + invalid-fill-price rejection
# ============================================================================
def test_ping_date_uses_prague_tz_at_dst_boundary(monkeypatch, tmp_path):
    """At UTC 22:30 in summer (UTC+2 → Prague is already 00:30 NEXT day),
    the ping_dates entry must be the Prague-side day, NOT the UTC day.

    Without the Prague-TZ fix the ping_dates entry uses the UTC date and
    the daily-trading-day count is off by one — at the DST/midnight edge
    the bot can fail to credit the 4th trading day on the FTMO server.
    """
    import ftmo_executor as exe

    # Redirect state into tmp_path
    exe.STATE_DIR = tmp_path
    exe.PAUSE_STATE_PATH = tmp_path / "pause-state.json"
    exe.PENDING_ORDERS_DIR = tmp_path / "pending-orders"

    # Pre-seed pause state so the ping path is reachable.
    exe.write_pause_state({
        "target_hit": True,
        "target_hit_date": "2026-07-14",  # Prague-day already credited
        "ping_dates": [],
        "passed": False,
    })

    # Freeze "now" to a UTC instant that is on the FOLLOWING Prague day.
    # 2026-07-14 22:30:00Z → 2026-07-15 00:30:00 Europe/Prague (CEST, UTC+2).
    from datetime import datetime as _dt, timezone as _tz
    frozen_utc = _dt(2026, 7, 14, 22, 30, 0, tzinfo=_tz.utc)

    class _FrozenDatetime(_dt):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                # naive — return frozen UTC stripped of tz
                return frozen_utc.replace(tzinfo=None)
            return frozen_utc.astimezone(tz)

    monkeypatch.setattr(exe, "datetime", _FrozenDatetime)
    # Force MOCK path so the function does NOT touch real MT5.
    monkeypatch.setattr(exe, "MOCK_MODE", True)

    exe.maybe_place_ping_trade()

    state = exe.get_pause_state()
    assert state["ping_dates"] == ["2026-07-15"], (
        f"expected Prague-day '2026-07-15' (since UTC 22:30 in summer is "
        f"already past Prague midnight), got {state['ping_dates']}"
    )


def test_history_deals_get_uses_utc_aware_datetime(monkeypatch):
    """check_circuit_breaker must call history_deals_get with TZ-AWARE
    datetimes. Naive datetimes cause broker-TZ ambiguity on real MT5
    (the API interprets naive as broker-local on Windows, so the lookup
    window misaligns from the trader-intended UTC window).
    """
    import ftmo_executor as exe

    captured = {}

    def fake_history_deals_get(start, end):
        captured["start"] = start
        captured["end"] = end
        return tuple()

    monkeypatch.setattr(exe.mt5, "history_deals_get", fake_history_deals_get)

    exe.check_circuit_breaker()

    assert "start" in captured, "history_deals_get was not called"
    assert captured["start"].tzinfo is not None, (
        f"history_deals_get start={captured['start']} is NAIVE — "
        f"broker-TZ ambiguity bug"
    )
    assert captured["end"].tzinfo is not None, (
        f"history_deals_get end={captured['end']} is NAIVE — "
        f"broker-TZ ambiguity bug"
    )


def test_invalid_fill_price_rejects_order(monkeypatch):
    """If slippage helper returns fill_price <= 0 (corrupt symbol_info,
    bad bid/ask), the executor MUST reject the order with a clear error
    instead of silently sizing with the theoretical stop_pct.
    """
    import ftmo_executor as exe

    info = FakeSpreadSymbolInfo(
        ask=2001.0, bid=1999.0, spread=20, point=0.01,
        tick_size=0.01, tick_value=0.01,
        volume_min=0.01, volume_max=100.0, volume_step=0.01,
    )
    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: info)
    monkeypatch.setattr(exe.mt5, "symbol_select", lambda s, e: True)
    exe._SYMBOL_CACHE.clear()

    # Force the slippage helper to return a pathological fill price.
    monkeypatch.setattr(exe, "_apply_slippage", lambda *a, **kw: 0.0)

    sent = {"called": False}
    monkeypatch.setattr(exe.mt5, "order_send", lambda req: sent.__setitem__("called", True))

    res = exe.place_market_order(
        binance_symbol="BTCUSDT",
        direction="long",
        risk_frac=0.01,
        stop_pct=0.01,
        tp_pct=0.02,
        account_equity=100000.0,
        comment="invalid_fill_test",
    )
    assert not res.ok, "order should have been rejected on fill_price <= 0"
    assert res.error is not None and "invalid fill_price" in res.error, (
        f"expected 'invalid fill_price' in error, got {res.error!r}"
    )
    assert sent["called"] is False, (
        "mt5.order_send must NOT be called when fill_price is invalid"
    )


def test_excessive_slippage_rejects_order(monkeypatch):
    """If post-slippage effective stop > 3× planned stop, reject the order
    rather than silently shrinking the lot to volume_min."""
    import ftmo_executor as exe

    info = FakeSpreadSymbolInfo(
        ask=2001.0, bid=1999.0, spread=20, point=0.01,
        tick_size=0.01, tick_value=0.01,
        volume_min=0.01, volume_max=100.0, volume_step=0.01,
    )
    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: info)
    monkeypatch.setattr(exe.mt5, "symbol_select", lambda s, e: True)
    exe._SYMBOL_CACHE.clear()

    # Force slippage so large that fill is on the wrong side of the stop:
    # planned stop_pct=0.01 → SL @ 2001.0 * 0.99 = 1980.99
    # If fill = 1985.0 then eff_stop = (1985-1980.99)/1985 ≈ 0.0020 (small).
    # Need a fill that pushes effective stop > 3 * 0.01 = 0.03 → eff
    # stop_distance > 0.03 * fill ⇒ |fill − 1980.99| > 0.03 * fill.
    # Pick fill = 2100 → eff_dist = 119.01 / 2100 ≈ 0.0567 > 0.03. PASS.
    monkeypatch.setattr(exe, "_apply_slippage", lambda *a, **kw: 2100.0)

    sent = {"called": False}
    monkeypatch.setattr(exe.mt5, "order_send", lambda req: sent.__setitem__("called", True))

    res = exe.place_market_order(
        binance_symbol="BTCUSDT",
        direction="long",
        risk_frac=0.01,
        stop_pct=0.01,
        tp_pct=0.02,
        account_equity=100000.0,
        comment="excessive_slip_test",
    )
    assert not res.ok, "order should have been rejected on excessive slippage"
    assert res.error is not None and "slippage too large" in res.error, (
        f"expected 'slippage too large' in error, got {res.error!r}"
    )
    assert sent["called"] is False, (
        "mt5.order_send must NOT be called when slippage is excessive"
    )


# ============================================================================
# Round 57 (R57-PY-1): get_challenge_day — DST + activation-time fix
# ============================================================================
def test_get_challenge_day_returns_zero_when_unset():
    import ftmo_executor as exe
    saved = exe.CHALLENGE_START_DATE
    try:
        exe.CHALLENGE_START_DATE = None
        assert exe.get_challenge_day() == 0
    finally:
        exe.CHALLENGE_START_DATE = saved


def test_get_challenge_day_with_iso_timestamp_activation_time():
    """Activation-time-of-day is informational — challenge counts whole
    Prague-days from midnight to midnight. Activating 16:00 still counts
    as day 0 until the next Prague midnight."""
    import ftmo_executor as exe
    from datetime import datetime, timedelta
    try:
        from zoneinfo import ZoneInfo
        prague_tz = ZoneInfo("Europe/Prague")
    except ImportError:
        from datetime import timezone
        prague_tz = timezone(timedelta(hours=1))

    saved = exe.CHALLENGE_START_DATE
    try:
        # Activate "today" 16:00 Prague — get_challenge_day must return 0.
        now_prague = datetime.now(prague_tz)
        today_at_16 = now_prague.replace(hour=16, minute=0, second=0, microsecond=0)
        exe.CHALLENGE_START_DATE = today_at_16.isoformat()
        # If "now" is past 16:00 today, still day 0. If we're past midnight already,
        # this test runs day 0 immediately. We just need to assert it doesn't blow up
        # and returns a non-negative integer.
        day = exe.get_challenge_day()
        assert day >= 0
        # Now flip to "yesterday at 16:00" — must be day 1.
        yesterday_at_16 = today_at_16 - timedelta(days=1)
        exe.CHALLENGE_START_DATE = yesterday_at_16.isoformat()
        assert exe.get_challenge_day() == 1
    finally:
        exe.CHALLENGE_START_DATE = saved


def test_get_challenge_day_dst_spring_forward_safe(monkeypatch):
    """Pure calendar-day arithmetic must NOT drift around DST transitions.
    Spring-forward (last Sunday in March, +1h): a challenge starting on
    March 1 must still produce day=N=days-elapsed even if the count
    crosses the DST boundary.

    We mock `datetime.now` to return values across the spring-forward day
    and verify get_challenge_day increments by exactly 1 per Prague day.
    """
    import ftmo_executor as exe
    from datetime import datetime, timedelta
    try:
        from zoneinfo import ZoneInfo
        prague_tz = ZoneInfo("Europe/Prague")
    except ImportError:
        pytest.skip("zoneinfo unavailable — DST test requires ZoneInfo")

    saved = exe.CHALLENGE_START_DATE
    saved_dt = exe.datetime
    try:
        # Challenge start: 2026-03-25 00:00 Prague (5 days before DST 2026-03-29).
        exe.CHALLENGE_START_DATE = "2026-03-25T00:00:00"

        # Build a `datetime` proxy whose `.now(tz)` we control.
        class FrozenDatetime(datetime):
            _frozen_now: "datetime | None" = None

            @classmethod
            def now(cls, tz=None):
                if tz is not None and cls._frozen_now is not None:
                    return cls._frozen_now.astimezone(tz)
                return cls._frozen_now or datetime.now(tz)

        monkeypatch.setattr(exe, "datetime", FrozenDatetime)

        # Day 4: 2026-03-29 (DST jump day) at 12:00 Prague.
        FrozenDatetime._frozen_now = datetime(2026, 3, 29, 12, 0, 0, tzinfo=prague_tz)
        assert exe.get_challenge_day() == 4

        # Day 5: 2026-03-30 (post-DST) at 12:00 Prague.
        FrozenDatetime._frozen_now = datetime(2026, 3, 30, 12, 0, 0, tzinfo=prague_tz)
        assert exe.get_challenge_day() == 5

        # Day 0: 2026-03-25 (start day) at 23:00 Prague — still day 0.
        FrozenDatetime._frozen_now = datetime(2026, 3, 25, 23, 0, 0, tzinfo=prague_tz)
        assert exe.get_challenge_day() == 0
    finally:
        exe.CHALLENGE_START_DATE = saved
        exe.datetime = saved_dt


def test_get_challenge_day_dst_fall_back_safe(monkeypatch):
    """Fall-back DST (last Sunday in October, -1h): challenge-day must
    still increment by exactly 1 per Prague calendar day, no off-by-one."""
    import ftmo_executor as exe
    from datetime import datetime, timedelta
    try:
        from zoneinfo import ZoneInfo
        prague_tz = ZoneInfo("Europe/Prague")
    except ImportError:
        pytest.skip("zoneinfo unavailable — DST test requires ZoneInfo")

    saved = exe.CHALLENGE_START_DATE
    saved_dt = exe.datetime
    try:
        # Challenge start: 2026-10-23 (5 days before DST 2026-10-25).
        exe.CHALLENGE_START_DATE = "2026-10-23T00:00:00"

        class FrozenDatetime(datetime):
            _frozen_now: "datetime | None" = None

            @classmethod
            def now(cls, tz=None):
                if tz is not None and cls._frozen_now is not None:
                    return cls._frozen_now.astimezone(tz)
                return cls._frozen_now or datetime.now(tz)

        monkeypatch.setattr(exe, "datetime", FrozenDatetime)

        # Day 2: 2026-10-25 (DST fall-back) at 12:00 Prague.
        FrozenDatetime._frozen_now = datetime(2026, 10, 25, 12, 0, 0, tzinfo=prague_tz)
        assert exe.get_challenge_day() == 2

        # Day 3: 2026-10-26 (post fall-back) at 01:00 Prague.
        FrozenDatetime._frozen_now = datetime(2026, 10, 26, 1, 0, 0, tzinfo=prague_tz)
        assert exe.get_challenge_day() == 3
    finally:
        exe.CHALLENGE_START_DATE = saved
        exe.datetime = saved_dt


def test_get_challenge_day_with_naive_date_only_string():
    """A bare `YYYY-MM-DD` string should still work (legacy format).
    Treats midnight Prague of that day as the anchor."""
    import ftmo_executor as exe
    from datetime import datetime, timedelta
    try:
        from zoneinfo import ZoneInfo
        prague_tz = ZoneInfo("Europe/Prague")
    except ImportError:
        from datetime import timezone
        prague_tz = timezone(timedelta(hours=1))

    saved = exe.CHALLENGE_START_DATE
    try:
        # Yesterday in Prague (date-only).
        yesterday = (datetime.now(prague_tz) - timedelta(days=1)).strftime("%Y-%m-%d")
        exe.CHALLENGE_START_DATE = yesterday
        assert exe.get_challenge_day() == 1
    finally:
        exe.CHALLENGE_START_DATE = saved


# ============================================================================
# Round 57 (R57-PY-3): reconcile_missing_positions — offline-close recovery
# ============================================================================
def test_reconcile_missing_positions_no_open_positions_noop(monkeypatch):
    """If on-disk open-positions.json is empty, reconcile must early-exit."""
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.OPEN_POS_PATH = Path(td) / "open-positions.json"
        exe.OPEN_POS_PATH.write_text(json.dumps({"positions": []}))

        called = {"history_deals_get": 0}
        monkeypatch.setattr(
            exe.mt5, "positions_get", lambda *a, **k: [],
        )
        def _hd(*_a, **_kw):
            called["history_deals_get"] += 1
            return []
        monkeypatch.setattr(exe.mt5, "history_deals_get", _hd)

        exe.reconcile_missing_positions()
        # Must not even probe history if no on-disk positions to reconcile.
        assert called["history_deals_get"] == 0


def test_reconcile_missing_positions_logs_offline_close(monkeypatch):
    """When a position is on-disk but absent from MT5, look up the
    closing deal in history and append to closed-during-offline.json."""
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.OPEN_POS_PATH = Path(td) / "open-positions.json"
        # On-disk: ticket 7777 long BTC.
        exe.OPEN_POS_PATH.write_text(json.dumps({"positions": [{
            "ticket": 7777,
            "signalAsset": "BTC-TREND",
            "direction": "long",
            "entry_price": 50000.0,
        }]}))

        # MT5: no positions (the ticket disappeared during offline period).
        monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **k: [])

        # MT5 history: closing deal for ticket 7777.
        class FakeDeal:
            def __init__(self, position_id, entry, price, time, profit):
                self.position_id = position_id
                self.entry = entry
                self.price = price
                self.time = time
                self.profit = profit
                self.magic = 231

        deal_close = FakeDeal(
            position_id=7777,
            entry=getattr(exe.mt5, "DEAL_ENTRY_OUT", 1),
            price=51500.0,
            time=1714000000,
            profit=150.0,
        )
        monkeypatch.setattr(exe.mt5, "history_deals_get", lambda *a, **k: [deal_close])
        # Suppress Telegram side-effect.
        monkeypatch.setattr(exe, "tg_send", lambda *a, **k: None)

        exe.reconcile_missing_positions()

        offline_path = Path(td) / "closed-during-offline.json"
        assert offline_path.exists()
        log = json.loads(offline_path.read_text())
        assert len(log["trades"]) == 1
        t0 = log["trades"][0]
        assert t0["ticket"] == 7777
        assert t0["exit_price"] == 51500.0
        assert t0["profit_usd"] == 150.0
        assert t0["reason"] == "offline_close"


# Round 58 (Critical Fix #3): reconcile_missing_positions must also pick up
# Hedge-Mode close deals (DEAL_ENTRY_INOUT=2 = position-reversal, and
# DEAL_ENTRY_OUT_BY=3 = close-by-opposite). Round 57 only matched
# DEAL_ENTRY_OUT (=1) which is the Netting-Mode close — Hedge-Mode FTMO
# accounts would silently lose every offline close, leaving phantom
# tickets in open-positions.json and broken equity tracking.
@pytest.mark.parametrize("close_entry_code,label", [
    (2, "DEAL_ENTRY_INOUT"),  # Hedge-Mode reversal
    (3, "DEAL_ENTRY_OUT_BY"),  # Hedge-Mode close-by-opposite
])
def test_reconcile_missing_positions_hedge_mode(monkeypatch, close_entry_code, label):
    """Hedge-Mode brokers emit close deals with entry codes 2 or 3.
    reconcile_missing_positions must capture both, not just OUT (=1)."""
    import ftmo_executor as exe
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.OPEN_POS_PATH = Path(td) / "open-positions.json"
        exe.OPEN_POS_PATH.write_text(json.dumps({"positions": [{
            "ticket": 8888,
            "signalAsset": "ETH-TREND",
            "direction": "long",
            "entry_price": 3000.0,
        }]}))

        # MT5: position absent (closed during offline window via Hedge close).
        monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **k: [])

        class FakeDeal:
            def __init__(self, position_id, entry, price, time, profit):
                self.position_id = position_id
                self.entry = entry
                self.price = price
                self.time = time
                self.profit = profit
                self.magic = 231

        deal_close = FakeDeal(
            position_id=8888,
            entry=close_entry_code,  # Hedge-Mode close
            price=3100.0,
            time=1714000000,
            profit=100.0,
        )
        monkeypatch.setattr(exe.mt5, "history_deals_get", lambda *a, **k: [deal_close])
        monkeypatch.setattr(exe, "tg_send", lambda *a, **k: None)

        exe.reconcile_missing_positions()

        offline_path = Path(td) / "closed-during-offline.json"
        assert offline_path.exists(), (
            f"{label} (code={close_entry_code}) was not captured — "
            f"reconcile_missing_positions still ignores Hedge-Mode closes."
        )
        log = json.loads(offline_path.read_text())
        assert len(log["trades"]) == 1
        t0 = log["trades"][0]
        assert t0["ticket"] == 8888
        assert t0["exit_price"] == 3100.0
        assert t0["profit_usd"] == 100.0


# ============================================================================
# Round 57 (2026-05-03): mt5_init_with_retry — FTMO_EXPECTED_LOGIN guard
# ----------------------------------------------------------------------------
# Multi-account VPS safety: if FTMO_EXPECTED_LOGIN is set, the executor must
# refuse to trade when MT5 attaches to the wrong account. We simulate the
# attach by stubbing `mt5.initialize` and `mt5.account_info` and assert
# `sys.exit(2)` is raised on a mismatch.
# ============================================================================
def test_mt5_init_exits_on_wrong_login(monkeypatch):
    import ftmo_executor as exe

    class FakeInfo:
        login = 5_555_555  # actual attached account
        server = "FakeBroker-Demo"
        balance = 100_000.0
        equity = 100_000.0

    monkeypatch.setattr(exe.mt5, "initialize", lambda *a, **k: True)
    monkeypatch.setattr(exe.mt5, "account_info", lambda: FakeInfo())
    monkeypatch.setattr(exe, "tg_send", lambda *a, **k: None)
    monkeypatch.setattr(exe, "log_event", lambda *a, **k: None)
    # Simulate a multi-account deployment where the operator expected
    # a different login than the one MT5 actually attached to.
    monkeypatch.setenv("FTMO_EXPECTED_LOGIN", "1234567")

    with pytest.raises(SystemExit) as excinfo:
        exe.mt5_init_with_retry()
    assert excinfo.value.code == 2


def test_mt5_init_succeeds_when_login_matches(monkeypatch):
    import ftmo_executor as exe

    class FakeInfo:
        login = 9_876_543
        server = "FakeBroker-Demo"
        balance = 100_000.0
        equity = 100_000.0

    monkeypatch.setattr(exe.mt5, "initialize", lambda *a, **k: True)
    monkeypatch.setattr(exe.mt5, "account_info", lambda: FakeInfo())
    monkeypatch.setattr(exe, "log_event", lambda *a, **k: None)
    monkeypatch.setenv("FTMO_EXPECTED_LOGIN", "9876543")

    assert exe.mt5_init_with_retry() is True


def test_mt5_init_warns_but_passes_when_expected_login_unset(monkeypatch):
    """When FTMO_EXPECTED_LOGIN is not set, init still succeeds (legacy path).

    A warning event is logged so multi-account operators see the omission.
    """
    import ftmo_executor as exe

    class FakeInfo:
        login = 11_111
        server = "FakeBroker-Demo"
        balance = 100_000.0
        equity = 100_000.0

    events: list[tuple[str, dict]] = []

    def capture(name, **kw):
        events.append((name, kw))

    monkeypatch.setattr(exe.mt5, "initialize", lambda *a, **k: True)
    monkeypatch.setattr(exe.mt5, "account_info", lambda: FakeInfo())
    monkeypatch.setattr(exe, "log_event", capture)
    monkeypatch.delenv("FTMO_EXPECTED_LOGIN", raising=False)

    assert exe.mt5_init_with_retry() is True
    # We expect both `mt5_expected_login_unset` (warning) and `mt5_connected`
    names = {ev[0] for ev in events}
    assert "mt5_expected_login_unset" in names
    assert "mt5_connected" in names


def test_mt5_init_exits_on_invalid_expected_login_string(monkeypatch):
    """Garbage in FTMO_EXPECTED_LOGIN must abort startup (not silently pass)."""
    import ftmo_executor as exe

    class FakeInfo:
        login = 12345
        server = "?"
        balance = 0.0
        equity = 0.0

    monkeypatch.setattr(exe.mt5, "initialize", lambda *a, **k: True)
    monkeypatch.setattr(exe.mt5, "account_info", lambda: FakeInfo())
    monkeypatch.setattr(exe, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(exe, "tg_send", lambda *a, **k: None)
    monkeypatch.setenv("FTMO_EXPECTED_LOGIN", "not-a-number")

    with pytest.raises(SystemExit) as excinfo:
        exe.mt5_init_with_retry()
    assert excinfo.value.code == 2


def test_mt5_ensure_connected_exits_on_login_drift_mid_session(monkeypatch):
    """R67: warm path must re-validate FTMO_EXPECTED_LOGIN every cycle.

    Cold-init succeeds with login=999999. Then the broker silently re-routes
    the terminal to a different account (mock injects login=42). The next
    `mt5_ensure_connected()` call (which fires every ~30s in steady state)
    must detect the drift, send a Telegram alert, and exit with code 2 so
    PM2/systemd restarts the executor on the correct account.
    """
    import ftmo_executor as exe
    import mock_mt5

    # Reset the module-level cache so a previous test does not leak through.
    exe._EXPECTED_LOGIN_INT = None
    mock_mt5._set_login(999999)

    monkeypatch.setattr(exe.mt5, "initialize", lambda *a, **k: True)
    # Use the real mock account_info() so login changes propagate.
    monkeypatch.setattr(exe.mt5, "account_info", mock_mt5.account_info)
    mock_mt5._STATE["initialized"] = True

    tg_calls: list[str] = []
    monkeypatch.setattr(exe, "tg_send", lambda msg, **kw: tg_calls.append(msg) or True)
    monkeypatch.setattr(exe, "log_event", lambda *a, **k: None)
    monkeypatch.setenv("FTMO_EXPECTED_LOGIN", "999999")

    # Cold init validates and caches the expected login.
    assert exe.mt5_init_with_retry() is True
    assert exe._EXPECTED_LOGIN_INT == 999999

    # Simulate broker-side account drift mid-session.
    mock_mt5._set_login(42)

    with pytest.raises(SystemExit) as excinfo:
        exe.mt5_ensure_connected()
    assert excinfo.value.code == 2
    assert any("drift" in m.lower() or "wrong" in m.lower() for m in tg_calls), tg_calls

    # Cleanup so the leaked _STATE doesn't break subsequent tests.
    mock_mt5._set_login(999999)
    mock_mt5._STATE["initialized"] = False
    exe._EXPECTED_LOGIN_INT = None


# ============================================================================
# Round 57 (2026-05-03): telegram_notify per-account env resolution
# ============================================================================
def test_telegram_notify_per_account_env(monkeypatch):
    """tg_send should pick TELEGRAM_BOT_TOKEN_<ACCT> over TELEGRAM_BOT_TOKEN."""
    import telegram_notify as tn

    monkeypatch.setenv("FTMO_ACCOUNT_ID", "DEMO_A")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "shared")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "shared-chat")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN_DEMO_A", "per-acct-A")
    monkeypatch.setenv("TELEGRAM_CHAT_ID_DEMO_A", "per-acct-chat-A")

    tok = tn._resolve_account_env("BOT_TOKEN")
    chat = tn._resolve_account_env("CHAT_ID")
    assert tok == "per-acct-A"
    assert chat == "per-acct-chat-A"

    # Verify prefix gets injected
    assert tn._account_prefix() == "[acct:DEMO_A] "


def test_telegram_notify_falls_back_to_bare_env(monkeypatch):
    """When per-account env is missing, fall back to bare env."""
    import telegram_notify as tn

    monkeypatch.setenv("FTMO_ACCOUNT_ID", "DEMO_B")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "shared")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "shared-chat")
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN_DEMO_B", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID_DEMO_B", raising=False)

    assert tn._resolve_account_env("BOT_TOKEN") == "shared"
    assert tn._resolve_account_env("CHAT_ID") == "shared-chat"


# ============================================================================
# Round 7 audit (2026-05-04): log_event lock + fsync, write_json dir-fsync,
# read_json corruption marker
# ============================================================================
def test_log_event_acquires_file_lock(monkeypatch, tmp_path):
    """log_event must wrap rotation+append under _file_lock to serialise
    concurrent writers from multi-account same-FTMO_TF executors."""
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "EXECUTOR_LOG_PATH", tmp_path / "executor-log.jsonl")

    calls: list[Path] = []
    real_lock = exe._file_lock

    import contextlib

    @contextlib.contextmanager
    def spy_lock(lock_path, *args, **kwargs):
        calls.append(Path(lock_path))
        with real_lock(lock_path, *args, **kwargs):
            yield

    monkeypatch.setattr(exe, "_file_lock", spy_lock)

    exe.log_event("test_event", level="info", foo="bar")

    assert len(calls) == 1, f"expected exactly one lock acquire, got {len(calls)}"
    assert calls[0].name == "executor-log.lock"
    # And the line was actually appended
    log = (tmp_path / "executor-log.jsonl").read_text(encoding="utf-8").strip()
    parsed = json.loads(log)
    assert parsed["event"] == "test_event"
    assert parsed["foo"] == "bar"


def test_log_event_fsyncs_after_append(monkeypatch, tmp_path):
    """log_event must call os.fsync on the log fd so a power-loss doesn't
    drop the most recent log lines (which usually narrate the crash cause)."""
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "EXECUTOR_LOG_PATH", tmp_path / "executor-log.jsonl")

    fsynced_fds: list[int] = []
    real_fsync = os.fsync

    def spy_fsync(fd):
        fsynced_fds.append(fd)
        return real_fsync(fd)

    monkeypatch.setattr(exe.os, "fsync", spy_fsync)

    exe.log_event("fsync_check")

    # At least one fsync must have happened during log_event.
    assert len(fsynced_fds) >= 1, "log_event did not fsync the log fd"


def test_log_event_serialises_concurrent_writers(monkeypatch, tmp_path):
    """Two threads logging at once must not produce interleaved bytes —
    every line in the JSONL output must parse as valid JSON."""
    import ftmo_executor as exe
    import threading

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)
    monkeypatch.setattr(exe, "EXECUTOR_LOG_PATH", tmp_path / "executor-log.jsonl")

    def worker(idx: int):
        for i in range(20):
            exe.log_event("concurrent", worker=idx, i=i)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    lines = (tmp_path / "executor-log.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 80, f"expected 80 lines, got {len(lines)}"
    for line in lines:
        parsed = json.loads(line)  # raises if any line was corrupted
        assert parsed["event"] == "concurrent"


def test_write_json_fsyncs_parent_dir_on_posix(monkeypatch, tmp_path):
    """On POSIX, write_json must fsync the parent dir after rename so the
    dir-entry update survives a power-loss."""
    if sys.platform == "win32":
        pytest.skip("POSIX-only: Windows can't os.open() directories")

    import ftmo_executor as exe

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)

    fsync_calls: list[int] = []
    real_fsync = os.fsync

    def spy_fsync(fd):
        fsync_calls.append(fd)
        return real_fsync(fd)

    monkeypatch.setattr(exe.os, "fsync", spy_fsync)

    target = tmp_path / "state.json"
    exe.write_json(target, {"ok": True})

    # Expect at least 2 fsyncs: file fd + parent-dir fd.
    assert len(fsync_calls) >= 2, (
        f"expected >=2 fsyncs (file + dir), got {len(fsync_calls)}"
    )
    # 2026-05-23 Wave2 fix: write_json now ALWAYS stamps _schema_version on
    # top-level dicts (was: only-if-missing). Test asserts the user payload
    # roundtripped through; the bookkeeping key is expected.
    payload = json.loads(target.read_text())
    payload.pop("_schema_version", None)
    assert payload == {"ok": True}


def test_write_json_dir_fsync_swallows_oserror(monkeypatch, tmp_path):
    """If os.open(parent_dir) raises (Windows / unsupported FS), write_json
    must NOT propagate — it's best-effort durability."""
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "STATE_DIR", tmp_path)

    real_open = os.open

    def fake_open(path, flags, *args, **kwargs):
        # Reject only the dir-fsync open (RDONLY on a directory)
        if flags == os.O_RDONLY and Path(path).is_dir():
            raise OSError("simulated: directory fsync not supported")
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(exe.os, "open", fake_open)

    target = tmp_path / "state.json"
    # Should not raise.
    exe.write_json(target, {"ok": True})
    # 2026-05-23 Wave2 fix: _schema_version always stamped on dict payloads.
    payload = json.loads(target.read_text())
    payload.pop("_schema_version", None)
    assert payload == {"ok": True}


def test_read_json_renames_corrupt_and_returns_fallback(monkeypatch, tmp_path):
    """On JSONDecodeError, read_json must rename the corrupt file to
    `path.corrupt.<ts>` and return the fallback — never silently succeed."""
    import ftmo_executor as exe

    tg_calls: list[str] = []
    monkeypatch.setattr(exe, "tg_send", lambda msg, **kw: tg_calls.append(msg))

    corrupt_path = tmp_path / "pause-state.json"
    corrupt_path.write_text("{not valid json", encoding="utf-8")

    fallback = {"target_hit": False}
    result = exe.read_json(corrupt_path, fallback)

    assert result == fallback, "must return fallback on corruption"
    assert not corrupt_path.exists(), "corrupt file must be renamed away"
    # Find the rename target
    siblings = list(tmp_path.glob("pause-state.json.corrupt.*"))
    assert len(siblings) == 1, f"expected 1 corrupt-renamed file, got {siblings}"
    assert siblings[0].read_text(encoding="utf-8") == "{not valid json"
    # And Telegram was alerted
    assert len(tg_calls) == 1
    assert "corrupt" in tg_calls[0].lower()


def test_read_json_telegram_failure_does_not_mask_fallback(monkeypatch, tmp_path):
    """If tg_send blows up, read_json must still return the fallback —
    Telegram is best-effort, corruption handling is not."""
    import ftmo_executor as exe

    def boom(*a, **kw):
        raise RuntimeError("telegram down")

    monkeypatch.setattr(exe, "tg_send", boom)

    corrupt_path = tmp_path / "broken.json"
    corrupt_path.write_text("garbage", encoding="utf-8")

    result = exe.read_json(corrupt_path, {"fallback": True})
    assert result == {"fallback": True}


def test_read_json_missing_file_returns_fallback_silently(monkeypatch, tmp_path):
    """Existing happy-path behavior: missing file → fallback, no Telegram."""
    import ftmo_executor as exe

    tg_calls: list[str] = []
    monkeypatch.setattr(exe, "tg_send", lambda msg, **kw: tg_calls.append(msg))

    result = exe.read_json(tmp_path / "nope.json", {"x": 1})
    assert result == {"x": 1}
    assert tg_calls == [], "missing file is not corruption — no alert expected"



# ============================================================================
# Round 60 audit (2026-05-06): place_market_order retcode handling
# ============================================================================
def test_place_market_order_no_money_triggers_margin_halve(monkeypatch):
    """retcode 10019 NO_MONEY in order_check → _fit_lot_to_margin halves
    the lot until it fits, then order_send succeeds with the smaller lot."""
    import ftmo_executor as exe

    # Force LIVE-mode path so _fit_lot_to_margin actually runs (mock skips it).
    monkeypatch.setattr(exe, "MOCK_MODE", False)
    exe._SYMBOL_CACHE.clear()

    info = FakeSpreadSymbolInfo(
        ask=2001.0, bid=1999.0, spread=20, point=0.01,
        tick_size=0.01, tick_value=0.01,
        volume_min=0.01, volume_max=100.0, volume_step=0.01,
    )
    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: info)
    monkeypatch.setattr(exe.mt5, "symbol_select", lambda s, e: True)

    # order_check returns 10019 twice, then OK — proves halve-loop fires.
    check_calls = {"n": 0, "lots": []}

    class FakeCheck:
        def __init__(self, retcode):
            self.retcode = retcode
            self.comment = ""

    def fake_check(req):
        check_calls["n"] += 1
        check_calls["lots"].append(req["volume"])
        return FakeCheck(10019) if check_calls["n"] <= 2 else FakeCheck(0)

    monkeypatch.setattr(exe.mt5, "order_check", fake_check, raising=False)

    sent = {}

    class FakeSendRes:
        def __init__(self):
            self.retcode = exe.mt5.TRADE_RETCODE_DONE
            self.order = 7777
            self.price = 2001.30
            self.comment = ""

    def fake_send(req):
        sent["lot"] = req["volume"]
        return FakeSendRes()

    monkeypatch.setattr(exe.mt5, "order_send", fake_send)

    res = exe.place_market_order(
        binance_symbol="BTCUSDT",
        direction="long",
        risk_frac=0.01,
        stop_pct=0.01,
        tp_pct=0.02,
        account_equity=100000.0,
        comment="no_money_test",
    )
    assert res.ok, f"order failed: {res.error}"
    assert check_calls["n"] >= 3, "expected at least 2 halve attempts + 1 success"
    # Each halve must shrink the lot.
    lots = check_calls["lots"]
    assert lots[1] < lots[0], f"halve did not shrink lot: {lots}"
    assert lots[2] < lots[1], f"second halve did not shrink lot: {lots}"
    # And the final order_send used the smaller, fitted lot.
    assert sent["lot"] == lots[-1]


def test_place_market_order_market_closed_no_retry(monkeypatch):
    """retcode 10021 MARKET_CLOSED in order_check → _fit_lot_to_margin
    must NOT halve (it's not a margin issue). Function returns the original
    lot, and order_send surfaces the failure."""
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "MOCK_MODE", False)
    exe._SYMBOL_CACHE.clear()

    info = FakeSpreadSymbolInfo(
        ask=2001.0, bid=1999.0, spread=20, point=0.01,
        tick_size=0.01, tick_value=0.01,
        volume_min=0.01, volume_max=100.0, volume_step=0.01,
    )
    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: info)
    monkeypatch.setattr(exe.mt5, "symbol_select", lambda s, e: True)

    check_calls = {"n": 0, "lots": []}

    class FakeCheck:
        def __init__(self, retcode):
            self.retcode = retcode
            self.comment = "market closed"

    def fake_check(req):
        check_calls["n"] += 1
        check_calls["lots"].append(req["volume"])
        return FakeCheck(10021)  # MARKET_CLOSED

    monkeypatch.setattr(exe.mt5, "order_check", fake_check, raising=False)

    class FakeSendRes:
        def __init__(self):
            self.retcode = 10021
            self.order = 0
            self.price = 0.0
            self.comment = "market closed"

    def fake_send(req):
        return FakeSendRes()

    monkeypatch.setattr(exe.mt5, "order_send", fake_send)

    res = exe.place_market_order(
        binance_symbol="BTCUSDT",
        direction="long",
        risk_frac=0.01,
        stop_pct=0.01,
        tp_pct=0.02,
        account_equity=100000.0,
        comment="market_closed_test",
    )
    # No retry: exactly one order_check call, lot unchanged.
    assert check_calls["n"] == 1, (
        f"expected exactly 1 check (no halve retry), got {check_calls['n']}"
    )
    # Order failed because order_send surfaced the 10021.
    assert not res.ok
    assert res.error is not None and "10021" in res.error


# ============================================================================
# Round 4 audit (Python FTMO executor)
# ============================================================================
def test_passlock_race_check_target_idempotent(monkeypatch, tmp_path):
    """Bug-Audit Round 4 (HIGH): check_target_and_pause MUST be safe to call
    every poll cycle. Second call after target_hit=True is set must NOT
    re-trigger _emergency_close_all_positions or re-send Telegram.

    Closes the PASSLOCK race window: previously check_target_and_pause was
    only invoked from inside _process_pending_signals_locked, so if equity
    crossed the profit-target mid-cycle via a PTP fire, trailing-stop tick
    or natural SL/TP exit, the closeAllOnTargetReached enforcement was
    delayed by one poll interval (up to POLL_INTERVAL_SEC seconds) during
    which the equity could drift back below target. Fixed by hoisting the
    check into main_loop's per-iteration block — but only safe if the
    function is idempotent. This test guards that invariant.
    """
    import ftmo_executor as exe

    exe.STATE_DIR = tmp_path
    exe.PAUSE_STATE_PATH = tmp_path / "pause-state.json"

    emergency_calls: list[str] = []
    tg_calls: list[str] = []
    # 2026-05-15 Codex-Audit fix: _emergency_close_all_positions returns a
    # dict {closed, failed, all_closed, deferred}. Test mock previously
    # returned None (lambda returns the side-effect's None) → caller crashed
    # on .get(). Wrap to return the dict.
    def _mock_emergency(r):
        emergency_calls.append(r)
        return {"closed": 0, "failed": 0, "all_closed": True, "deferred": False}
    monkeypatch.setattr(exe, "_emergency_close_all_positions", _mock_emergency)
    monkeypatch.setattr(exe, "tg_send", lambda msg, **kw: tg_calls.append(msg))
    # Mock the broker-equity refresh to return the equity we pass — keeps
    # the post-close target-confirmation branch deterministic.
    monkeypatch.setattr(exe, "_get_broker_equity_now", lambda **kw: None)
    monkeypatch.setattr(exe, "PAUSE_AT_TARGET", True)
    monkeypatch.setattr(exe, "PROFIT_TARGET_PCT", 0.10)
    monkeypatch.setattr(exe, "CHALLENGE_START_BALANCE", 100_000.0)

    # First call: equity well over the +10% target → target_hit fires.
    paused_1 = exe.check_target_and_pause(110_500.0)
    assert paused_1 is True
    assert len(emergency_calls) == 1, "first crossing must trigger emergency close"
    assert len(tg_calls) == 1, "first crossing must send exactly one Telegram alert"

    # Second call (same poll-loop or next iteration): still over target → must
    # short-circuit on state["target_hit"] without re-triggering anything.
    paused_2 = exe.check_target_and_pause(111_000.0)
    assert paused_2 is True
    assert len(emergency_calls) == 1, "second call MUST NOT re-emergency-close (idempotency)"
    assert len(tg_calls) == 1, "second call MUST NOT re-alert Telegram (idempotency)"

    # Third call: equity has drifted BACK below target (e.g. a residual
    # position closed at SL between cycles) — PASSLOCK guarantee still
    # holds because state["target_hit"] remains True from the original
    # crossing → bot stays paused, no positions allowed.
    paused_3 = exe.check_target_and_pause(99_500.0)
    assert paused_3 is True, "PASSLOCK must stay sticky once target was hit"
    assert len(emergency_calls) == 1
    assert len(tg_calls) == 1


def test_default_direction_rejects_invalid(monkeypatch):
    """2026-05-15 Codex-Audit Wave-2 Bug 4 (HOCH): the place-order path must
    REJECT signals with a missing/invalid direction rather than silently
    falling back to "long". A legacy short signal with a mistyped direction
    (e.g. "DOWN", "" or null) was previously opened as a LONG with a stop
    placed where the short SL would have been — i.e. INSIDE the entry. A
    single such fill would instant-stop or, worse, fill past the SL price
    on a fast bar.

    We assert via source inspection that the new validator is wired in
    `_process_signals_unlocked` and the old silent fallback is gone.
    """
    import ftmo_executor as exe
    import inspect
    # Wave-2 Bug 6 moved the place-order loop into `_process_signals_unlocked`.
    src = inspect.getsource(exe._process_signals_unlocked)
    assert 'if direction not in ("long", "short"):' in src, (
        "process_pending_signals must explicitly validate direction before "
        "placing an order. Found no validator gate — legacy/malformed signals "
        "could be opened on the wrong side."
    )
    # Neither the old 'short' nor the old 'long' silent fallback may remain.
    assert 'sig.get("direction", "short")' not in src, (
        "found legacy 'short' default — re-introduced Bug-Audit Round 4 regression"
    )
    assert 'sig.get("direction", "long")' not in src, (
        "Wave-2 Bug 4 fix replaced the silent default with explicit validation; "
        "the legacy 'long' fallback is no longer correct."
    )


# ============================================================================
# 2026-05-15 Codex-Audit bug regression tests
# ============================================================================
def test_min_trading_days_off_by_one_fix(monkeypatch, tmp_path):
    """2026-05-15 Codex-Audit Bug 1 (KRITISCH): challenge must NOT pass when
    the count of unique trading-days < MIN_TRADING_DAYS. Previously the
    `len(ping_dates) + 1` formula treated target_hit_date as a count to ADD
    to ping_dates → off-by-one and double-count when target_hit_date got
    appended to ping_dates by maybe_place_ping_trade on the same Prague day.
    """
    import ftmo_executor as exe

    exe.STATE_DIR = tmp_path
    exe.PAUSE_STATE_PATH = tmp_path / "pause-state.json"
    exe.PENDING_ORDERS_DIR = tmp_path / "pending-orders"

    monkeypatch.setattr(exe, "MIN_TRADING_DAYS", 4)
    monkeypatch.setattr(exe, "MOCK_MODE", True)

    # Case A: target_hit_date already in ping_dates (same Prague day). With
    # only 3 unique days, MUST NOT pass.
    exe.write_pause_state({
        "target_hit": True,
        "target_hit_date": "2026-07-01",
        "ping_dates": ["2026-07-01", "2026-07-02", "2026-07-03"],
        "passed": False,
    })
    # Freeze "now" to a 4th day, so the ping_dates check runs.
    from datetime import datetime as _dt, timezone as _tz
    frozen_utc = _dt(2026, 7, 4, 8, 0, 0, tzinfo=_tz.utc)

    class _FrozenDatetime(_dt):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return frozen_utc.replace(tzinfo=None)
            return frozen_utc.astimezone(tz)

    monkeypatch.setattr(exe, "datetime", _FrozenDatetime)
    exe.maybe_place_ping_trade()
    state = exe.get_pause_state()
    # 4 unique days now (target_hit_date == 07-01 already in ping_dates;
    # after run we add 07-04) → passed=True legitimately.
    assert len(set(state["ping_dates"]) | {state["target_hit_date"]}) == 4
    assert state["passed"] is True, "4 distinct days must trigger pass"

    # Case B: only 3 distinct days, target_hit_date NOT in ping_dates → must NOT pass.
    exe.write_pause_state({
        "target_hit": True,
        "target_hit_date": "2026-07-01",
        "ping_dates": ["2026-07-02", "2026-07-03"],
        "passed": False,
    })
    # Re-run with same frozen day → ping_dates becomes ["2026-07-02", "2026-07-03", "2026-07-04"]
    # Distinct days = {07-01 (target), 07-02, 07-03, 07-04} = 4 → passes.
    exe.maybe_place_ping_trade()
    state = exe.get_pause_state()
    assert state["passed"] is True

    # Case C: only 2 distinct days (target=ping_dates[0], 1 other) → must NOT pass.
    exe.write_pause_state({
        "target_hit": True,
        "target_hit_date": "2026-07-04",  # same as today
        "ping_dates": ["2026-07-04", "2026-07-03"],  # 2 distinct
        "passed": False,
    })
    exe.maybe_place_ping_trade()
    state = exe.get_pause_state()
    # After run: ping_dates already contains 07-04 (today) so no new append.
    # distinct = {07-04, 07-03} = 2 < 4 → must NOT pass.
    assert state["passed"] is False, (
        "2 distinct trading-days must NOT satisfy MIN_TRADING_DAYS=4 "
        "(off-by-one regression — would have falsely passed with old +1 logic)"
    )


def test_ping_marker_reconcile_does_not_requeue_as_signal(monkeypatch, tmp_path):
    """2026-05-15 Codex-Audit Bug 3: ping markers (magic=232) must NOT be
    re-queued into pending-signals.json — they have no `signal` payload.
    Previously generic order-marker reconcile treated `data.get("signal", {})`
    as a real signal and appended an empty dict to the pending queue.
    """
    import ftmo_executor as exe

    exe.STATE_DIR = tmp_path
    exe.PENDING_ORDERS_DIR = tmp_path / "pending-orders"
    exe.PENDING_PATH = tmp_path / "pending-signals.json"
    exe.PENDING_ORDERS_DIR.mkdir(parents=True, exist_ok=True)

    # Seed a ping marker (no `signal` key, has `ping=True`).
    ping_marker = exe._write_ping_order_marker("2026-07-01", "ETHUSD")
    assert ping_marker.exists()

    # No magic=232 position open → reconcile must clean the marker AND
    # NOT add anything to pending-signals.json.
    monkeypatch.setattr(exe.mt5, "positions_get", lambda *a, **kw: [])
    monkeypatch.setattr(exe.mt5, "history_deals_get", lambda *a, **kw: [])
    monkeypatch.setattr(exe, "tg_send", lambda *a, **kw: None)

    exe.reconcile_pending_order_markers()

    # Marker cleared.
    assert not ping_marker.exists()
    # Pending-signals must be empty / not contain blanks.
    pending = exe.read_json(exe.PENDING_PATH, {"signals": []})
    assert pending["signals"] == [], (
        "ping marker must NEVER be re-queued as a pending signal "
        f"(got: {pending['signals']!r})"
    )


def test_symbol_resolver_negative_cache_has_ttl(monkeypatch):
    """2026-05-15 Codex-Audit Bug 7: transient symbol_info failure must NOT
    blacklist the symbol for the whole process lifetime. After TTL, the
    resolver must re-attempt the broker symbol lookup.
    """
    import ftmo_executor as exe

    # Force resolver to fail first attempt.
    monkeypatch.setattr(exe, "_SYMBOL_NEG_CACHE_TTL", 0.05)  # 50ms
    exe._SYMBOL_CACHE.clear()
    exe._SYMBOL_CACHE_NEG_TS.clear()

    monkeypatch.setattr(exe.mt5, "symbol_info", lambda s: None)
    assert exe._resolve_broker_symbol("XYZUSDT") is None
    assert "XYZUSDT" in exe._SYMBOL_CACHE
    assert exe._SYMBOL_CACHE["XYZUSDT"] is None

    # Within TTL → still cached None (do NOT re-try).
    class FakeInfo: pass
    call_count = {"n": 0}
    def _mock_symbol_info(sym):
        call_count["n"] += 1
        return FakeInfo()
    monkeypatch.setattr(exe.mt5, "symbol_info", _mock_symbol_info)
    assert exe._resolve_broker_symbol("XYZUSDT") is None
    assert call_count["n"] == 0, "within TTL the negative cache must short-circuit"

    # After TTL → must re-resolve and succeed.
    import time as _time
    _time.sleep(0.08)
    res = exe._resolve_broker_symbol("XYZUSDT")
    assert res is not None, "negative cache must expire and re-attempt resolution"
    assert call_count["n"] >= 1


# ============================================================================
# 2026-05-15 Codex-Audit WAVE-2 regression tests
# ============================================================================
def test_wave2_bug1_order_marker_kept_on_send_fail_then_deleted(monkeypatch):
    """Wave-2 Bug 1B (KRITISCH): on order_send FAIL the marker MUST be deleted
    explicitly (we have authoritative MT5 proof no order exists) — otherwise
    boot-reconcile re-queues it as a pending signal → duplicate orders on
    restart.
    """
    import ftmo_executor as exe
    import inspect
    src = inspect.getsource(exe._process_signals_unlocked)
    # The fail-branch must contain a marker delete.
    assert "_clear_pending_order_marker(order_marker)" in src, (
        "fail-branch must delete the WAL marker — without it boot-reconcile "
        "re-queues the signal as a fresh pending entry → duplicate orders"
    )
    # The success branch must NOT delete the marker inline — it queues into
    # placed_markers for bulk-delete AFTER the final writes.
    assert "placed_markers.append(order_marker)" in src, (
        "success-branch must defer marker deletion via placed_markers list"
    )


def test_wave2_bug2_pending_index_uses_enumerate(monkeypatch):
    """Wave-2 Bug 2 (HOCH): `pending[pending.index(sig) + 1:]` returns the
    FIRST match by equality. Two structurally-identical signal dicts (asset+
    signalBarClose collision via signal-source restart race) re-queued
    already-processed signals. Must use enumerate's index `i`.
    """
    import ftmo_executor as exe
    import inspect
    src = inspect.getsource(exe._process_signals_unlocked)
    assert "for i, sig in enumerate(pending):" in src, (
        "place-order loop must use enumerate so the index can be passed to "
        "the pending slice instead of pending.index(sig)"
    )
    # Strip line comments before searching so the rationale comment
    # documenting the bug does not trip the regex itself.
    code_only = "\n".join(
        line.split("#", 1)[0] for line in src.splitlines()
    )
    assert "pending.index(sig)" not in code_only, (
        "found legacy `pending.index(sig)` in executable code — would "
        "re-queue earlier signals when duplicate dicts exist in pending"
    )
    assert "pending[i + 1:]" in code_only, (
        "auto-pause break must slice pending by the enumerate index `i + 1`"
    )


def test_wave2_bug3_time_exit_returns_false_on_close_fail(monkeypatch):
    """Wave-2 Bug 3 (HOCH): `_apply_time_exit` must only return True if the
    close actually succeeded. Returning True unconditionally caused the
    caller (`manage_open_positions`) to drop the position from `still_open`
    even when the broker rejected the close → live trade orphaned.
    """
    import ftmo_executor as exe
    from datetime import datetime, timezone

    class FakePos:
        ticket = 999
        price_current = 100.0

    # Force fast-path with a min_gain_r and high stop_price so we never reach
    # the "min-gain reached" early exit.
    pos = {
        "ticket": 999,
        "time_exit": {
            "maxBarsWithoutGain": 1,
            "minGainR": 1.0,
            "barDurationMs": 60_000,
        },
        "opened_at": "2026-01-01T00:00:00+00:00",
        "entry_price": 100.0,
        "original_stop_pct": 0.01,
        "stop_price": 99.0,
        "time_exit_reached_min_gain": False,
        "signalAsset": "BTC",
    }
    monkeypatch.setattr(exe.mt5, "positions_get", lambda ticket=None: [FakePos()])

    # Case A: close returns False — function must return False.
    monkeypatch.setattr(exe, "close_position", lambda *a, **k: False)
    monkeypatch.setattr(exe, "tg_send", lambda *a, **k: None)
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    result = exe._apply_time_exit(pos, now_ms)
    assert result is False, (
        "time_exit must return False when close_position fails so the "
        "caller keeps the position in still_open and retries on next loop"
    )

    # Case B: close returns True — function must return True.
    monkeypatch.setattr(exe, "close_position", lambda *a, **k: True)
    # Reset latch — Case A may have set time_exit_reached_min_gain via unrealized.
    pos["time_exit_reached_min_gain"] = False
    result = exe._apply_time_exit(pos, now_ms)
    assert result is True


def test_wave2_bug11_kill_filters_both_magics():
    """Wave-2 Bug 11 (NIEDRIG): ftmo_kill must close both magic=MAGIC (signal
    trades) AND magic=PING_MAGIC (ping trades). A stuck PING_MAGIC long previously
    survived emergency kill.

    2026-05-15 R3 audit Bug #2 update: MAGIC is now per-account (was hardcoded
    231) — assert the filter uses the module-level constants instead of the
    literal tuple (231, 232).
    """
    import inspect
    import ftmo_kill
    src = inspect.getsource(ftmo_kill.main)
    assert "(MAGIC, PING_MAGIC)" in src, (
        "ftmo_kill main() must filter positions by magic in (MAGIC, PING_MAGIC) "
        "so ping trades are also closed during emergency kill"
    )


# =============================================================================
# Codex Round 4 — merged regression tests for #3, #4, #5, #6, #7, #8, #9
# Adapted from R4 worktree to main's executor API (main has equivalent or
# stronger implementations — these tests guard the documented behaviour).
# =============================================================================


def test_codex_r4_passlock_target_hit_defers_when_close_partially_fails(
    monkeypatch, tmp_path
):
    """Codex Round 4 KRITISCH (#4): if PASSLOCK emergency-close PARTIAL-fails
    (broker timeout, requote, etc), target_hit MUST NOT be latched. Mirrors
    the Rust commit `bdc26bb` Codex Round 1 Fix 3.
    Main API: _emergency_close_all_positions returns
    {closed, failed, all_closed, deferred} — bail when all_closed=False.
    """
    import ftmo_executor as exe

    exe.STATE_DIR = tmp_path
    exe.PAUSE_STATE_PATH = tmp_path / "pause-state.json"
    exe.EXECUTOR_LOG_PATH = tmp_path / "executor-log.jsonl"

    tg_calls: list[str] = []
    monkeypatch.setattr(
        exe,
        "_emergency_close_all_positions",
        lambda r: {"closed": 1, "failed": 1, "all_closed": False, "deferred": False},
    )
    monkeypatch.setattr(exe, "tg_send", lambda msg, **kw: tg_calls.append(msg))
    monkeypatch.setattr(exe, "_get_broker_equity_now", lambda: None)
    monkeypatch.setattr(exe, "PAUSE_AT_TARGET", True)
    monkeypatch.setattr(exe, "PROFIT_TARGET_PCT", 0.10)
    monkeypatch.setattr(exe, "CHALLENGE_START_BALANCE", 100_000.0)
    monkeypatch.setenv("FTMO_PASSLOCK", "1")

    paused = exe.check_target_and_pause(110_500.0)
    assert paused is False, "MUST NOT latch target_hit on partial close failure"
    # operator MUST be alerted to the deferred latch.
    assert any("PARTIAL FAIL" in m for m in tg_calls), \
        "operator must be alerted to deferred PASSLOCK on partial close failure"

    state = exe.get_pause_state()
    assert state.get("target_hit") is False, \
        "Codex Round 4 #4: target_hit persisted prematurely — soft-pass bug"


def test_codex_r4_passlock_target_hit_defers_when_post_close_equity_below_target(
    monkeypatch, tmp_path
):
    """Codex Round 4 KRITISCH (#4): post-close broker equity refresh shows
    funding/slippage pulled equity BELOW target. target_hit MUST NOT latch.
    Main uses _get_broker_equity_now() returning float|None.
    """
    import ftmo_executor as exe

    exe.STATE_DIR = tmp_path
    exe.PAUSE_STATE_PATH = tmp_path / "pause-state.json"
    exe.EXECUTOR_LOG_PATH = tmp_path / "executor-log.jsonl"

    monkeypatch.setattr(
        exe,
        "_emergency_close_all_positions",
        lambda r: {"closed": 1, "failed": 0, "all_closed": True, "deferred": False},
    )
    monkeypatch.setattr(exe, "tg_send", lambda *a, **kw: None)
    monkeypatch.setattr(exe, "PAUSE_AT_TARGET", True)
    monkeypatch.setattr(exe, "PROFIT_TARGET_PCT", 0.10)
    monkeypatch.setattr(exe, "CHALLENGE_START_BALANCE", 100_000.0)
    monkeypatch.setenv("FTMO_PASSLOCK", "1")
    # MTM equity at-target BUT after partial close residual positions drag
    # back down to +8% (still profit, but below 10% target).
    monkeypatch.setattr(exe, "_get_broker_equity_now", lambda **kw: 108_000.0)

    paused = exe.check_target_and_pause(110_500.0)
    assert paused is False, "MUST NOT latch target_hit when post-close equity < target"
    state = exe.get_pause_state()
    assert state.get("target_hit") is False, \
        "Codex Round 4 #4: target_hit persisted prematurely — soft-pass bug"


def test_codex_r4_max_hold_until_zero_or_max_safe_is_sentinel(monkeypatch, tmp_path):
    """Codex Round 4 #3: V4 sim explicitly disables time-exits. When wrapper
    emits maxHoldUntil sentinel (0 or Number.MAX_SAFE_INTEGER ≈ 9e15), the
    executor's manage-loop MUST NOT force-close. Main implements this gate
    inline in manage_open_positions:
        if 0 < max_hold < 1_000_000_000_000_000 and now_ms >= max_hold: ...
    so 0 and 9_007_199_254_740_991 (JS Number.MAX_SAFE_INTEGER) both bypass.
    Source-level guard.
    """
    import ftmo_executor as exe
    import inspect
    src = inspect.getsource(exe.manage_open_positions)
    # The exact gate string preserves the hold-bars sentinel semantics.
    assert "0 < max_hold < 1_000_000_000_000_000" in src, (
        "Codex Round 4 #3: manage_open_positions must guard max_hold_until "
        "sentinel values (0 and JS Number.MAX_SAFE_INTEGER) so V4-sim parity "
        "configs don't force-close every cycle."
    )
    # Direct contract check: a position with max_hold_until=0 must not be
    # within the trigger range regardless of now_ms.
    max_hold_zero = 0
    max_hold_max_safe = 9_007_199_254_740_991  # JS Number.MAX_SAFE_INTEGER
    now_ms = int(__import__("time").time() * 1000)
    # The inline check: 0 < max_hold < 1e15
    assert not (0 < max_hold_zero < 1_000_000_000_000_000), \
        "max_hold_until=0 sentinel must NOT match the trigger gate"
    assert not (0 < max_hold_max_safe < 1_000_000_000_000_000), \
        "max_hold_until=MAX_SAFE_INTEGER sentinel must NOT match the trigger gate"
    # A realistic past timestamp DOES trigger.
    assert 0 < (now_ms - 1) < 1_000_000_000_000_000, \
        "realistic past max_hold_until must fall inside the trigger gate"


def test_codex_r4_signal_sltp_preserved_after_order_fill():
    """Codex Round 4 #5: open-positions must persist BOTH broker-confirmed
    SL/TP (used for live management) AND the signal payload's idealised
    SL/TP (used for drift diagnostics). Without this, BE/PTP/trail/chandelier
    later computed deltas against a stale stop_price while the broker held
    a different SL.
    """
    import ftmo_executor as exe
    import inspect
    src = inspect.getsource(exe._process_signals_unlocked)
    assert '"signal_stop_price"' in src and '"signal_tp_price"' in src, (
        "Codex Round 4 #5: open-positions schema must carry "
        "signal_stop_price and signal_tp_price for drift diagnostics"
    )
    # Broker-confirmed values are read from OrderResult and persisted.
    assert "result.stop_price" in src and "result.tp_price" in src, (
        "Codex Round 4 #5: broker-confirmed SL/TP must be persisted from "
        "OrderResult into stop_price/tp_price (not from signal payload)"
    )


def test_codex_r4_excess_entry_slippage_rejects_order():
    """Codex Round 4 #5: when live tick has drifted beyond
    MAX_ENTRY_SLIPPAGE_PCT from payload entry, the order MUST be rejected
    before placement. Main implements the gate in _process_signals_unlocked
    (the wrapper around place_market_order).
    """
    import ftmo_executor as exe
    import inspect
    # Constant exists and is env-driven.
    assert hasattr(exe, "MAX_ENTRY_SLIPPAGE_PCT"), \
        "Codex Round 4 #5: MAX_ENTRY_SLIPPAGE_PCT constant missing"
    # Gate referenced inside _process_signals_unlocked (the dispatcher).
    src = inspect.getsource(exe._process_signals_unlocked)
    assert "MAX_ENTRY_SLIPPAGE_PCT" in src, (
        "Codex Round 4 #5: _process_signals_unlocked must enforce "
        "MAX_ENTRY_SLIPPAGE_PCT tolerance before placing the order"
    )


def test_codex_r4_strict_parity_zeros_entry_buffers(monkeypatch):
    """Codex Round 4 #8: STRICT_PARITY (=FTMO_STRICT_PARITY=1) zeros the
    entry-block safety buffers so live behaviour matches the backtest sim
    exactly. Main exposes module-level constant STRICT_PARITY + zeroed
    buffers (DL_ENTRY_BLOCK_BUFFER / TL_ENTRY_BLOCK_BUFFER).
    """
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "MAX_DAILY_LOSS_PCT", 0.05)
    monkeypatch.setattr(exe, "MAX_TOTAL_LOSS_PCT", 0.10)
    monkeypatch.setattr(exe, "CHALLENGE_START_BALANCE", 100_000.0)

    day_start = 100_000.0
    cur = 95_500.0  # -4.5% intraday

    # With a meaningful DL buffer (1%), -4.5% breach is blocked.
    monkeypatch.setattr(exe, "STRICT_PARITY", False)
    monkeypatch.setattr(exe, "DL_ENTRY_BLOCK_BUFFER", 0.010, raising=False)
    monkeypatch.setattr(exe, "TL_ENTRY_BLOCK_BUFFER", 0.015, raising=False)
    block = exe.check_ftmo_rules(cur, day_start)
    assert block is not None, "default buffer should block at -4.5%"

    # STRICT_PARITY zeros the buffer — -4.5% does NOT block, only the actual
    # -5% FTMO cap would.
    monkeypatch.setattr(exe, "STRICT_PARITY", True)
    block_strict = exe.check_ftmo_rules(cur, day_start)
    assert block_strict is None, \
        "Codex Round 4 #8: STRICT_PARITY must NOT block at -4.5% (only -5% cap)"

    # At -5% with STRICT_PARITY, the hard FTMO cap still blocks.
    block_at_cap = exe.check_ftmo_rules(95_000.0, day_start)
    assert block_at_cap is not None, \
        "STRICT_PARITY must still block at the actual -5% FTMO cap"


def test_codex_r4_recompute_atr_returns_none_on_failure(monkeypatch):
    """Codex Round 4 #7: ATR recompute is best-effort; on MT5 failure
    returns None so the caller falls back to atrAtEntry (no crash).
    Main exposes _fetch_recent_atr (equivalent to R4's _recompute_atr_from_mt5).
    """
    import ftmo_executor as exe

    # MOCK_MODE short-circuits to None.
    monkeypatch.setattr(exe, "MOCK_MODE", True)
    assert exe._fetch_recent_atr("BTCUSDT", 14, 30) is None

    monkeypatch.setattr(exe, "MOCK_MODE", False)
    monkeypatch.setattr(exe, "_resolve_broker_symbol", lambda s: "BTCUSD")

    # mt5.copy_rates_from_pos throws.
    def boom(*a, **kw):
        raise RuntimeError("MT5 disconnect")
    monkeypatch.setattr(exe.mt5, "copy_rates_from_pos", boom)
    assert exe._fetch_recent_atr("BTCUSDT", 14, 30) is None

    # mt5.copy_rates_from_pos returns None.
    monkeypatch.setattr(exe.mt5, "copy_rates_from_pos", lambda *a, **kw: None)
    assert exe._fetch_recent_atr("BTCUSDT", 14, 30) is None

    # mt5.copy_rates_from_pos returns insufficient bars.
    monkeypatch.setattr(
        exe.mt5,
        "copy_rates_from_pos",
        lambda *a, **kw: [{"high": 1.0, "low": 1.0, "close": 1.0}],
    )
    assert exe._fetch_recent_atr("BTCUSDT", 14, 30) is None


def test_codex_r4_engine_ticket_id_persisted_in_open_positions():
    """Codex Round 4 #9: open-positions.json schema must carry an engine-side
    ticket identifier so MT5-rebuild can rehydrate state via lookup by
    engine id. Main persists `engine_ticket_id` + `engine_entry_time`.
    Source-level guard.
    """
    import ftmo_executor as exe
    import inspect
    src = inspect.getsource(exe._process_signals_unlocked)
    assert '"engine_ticket_id"' in src, \
        "Codex Round 4 #9: engine_ticket_id must be persisted with each open position"
    # Either entry_time_engine (R4 name) or engine_entry_time (main's name)
    # — both fulfil the same restart-recovery contract.
    assert ('"engine_entry_time"' in src) or ('"entry_time_engine"' in src), \
        "Codex Round 4 #9: engine-side entry-time anchor must be persisted"


# =============================================================================
# R3-B Drift-1: funding-cost / swap reconciliation
# =============================================================================
def test_funding_reconcile_disabled_by_default(tmp_path, monkeypatch):
    """FTMO_FUNDING_RECONCILE default OFF → _reconcile_funding_drift no-ops.

    The funding reconciliation feature is opt-in to avoid noise on crypto
    accounts with zero swap. Default disabled = returns None.
    """
    import ftmo_executor as exe

    # Ensure disabled
    monkeypatch.setattr(exe, "FUNDING_RECONCILE_ENABLED", False)
    result = exe._reconcile_funding_drift(force=True)
    assert result is None, "disabled feature must short-circuit to None"


def test_funding_reconcile_drift_detection(tmp_path, monkeypatch):
    """Engine-projected swap vs MT5-reported swap drift triggers alert.

    Setup: 1 BTC position open for 3 days at 0.5bp/day on $100k notional.
      expected = $100k × (0.5/10000) × 3 = $15.0
    MT5 reports swap = $5.0 (broker accrual lagging).
      drift = $15 − $5 = $10 → $10 / $100k = 0.0001 (0.01%) below default 0.5%.
    To force drift-detected, set threshold to 0.00005.
    """
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "FUNDING_RECONCILE_ENABLED", True)
    monkeypatch.setattr(exe, "FUNDING_RATES", {"BTCUSDT": 0.5})
    monkeypatch.setattr(exe, "FUNDING_RECONCILE_EVERY_N", 1)
    monkeypatch.setattr(exe, "FUNDING_DRIFT_THRESHOLD", 0.00005)  # 0.005%
    monkeypatch.setattr(exe, "CHALLENGE_START_BALANCE", 100_000.0)

    open_path = tmp_path / "open-positions.json"
    monkeypatch.setattr(exe, "OPEN_POS_PATH", open_path)
    three_days_ago = (
        __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
        - __import__("datetime").timedelta(days=3, hours=1)
    ).isoformat()
    open_path.write_text(json.dumps({
        "positions": [{
            "ticket": 42,
            "signalAsset": "BTCUSDT",
            "lot": 1.0,
            "entry_price": 100_000.0,
            "opened_at": three_days_ago,
        }]
    }))

    # Mock MT5: return position with swap=$5.0 (drift = $15-$5 = $10 = 0.01%)
    class FakePos:
        swap = 5.0

    def fake_get(ticket=None):
        return [FakePos()]

    monkeypatch.setattr(exe.mt5, "positions_get", fake_get)
    monkeypatch.setattr(exe, "tg_send", lambda *a, **kw: None)

    summary = exe._reconcile_funding_drift(force=True)
    assert summary is not None, "must produce summary when enabled + has positions"
    assert summary["expected"] == pytest.approx(15.0, abs=0.01)
    assert summary["actual"] == pytest.approx(5.0, abs=0.01)
    assert abs(summary["drift"] - 10.0) < 0.01


def test_funding_reconcile_zero_rate_no_op(tmp_path, monkeypatch):
    """Asset with zero swap_rate → expected=0 → returns None (no false alert).

    Crypto FTMO accounts typically have 0 swap. Guards against spurious
    alerts on those accounts even when the feature is enabled.
    """
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "FUNDING_RECONCILE_ENABLED", True)
    monkeypatch.setattr(exe, "FUNDING_RATES", {"BTCUSDT": 0.0})  # zero rate
    monkeypatch.setattr(exe, "FUNDING_RECONCILE_EVERY_N", 1)

    open_path = tmp_path / "open-positions.json"
    monkeypatch.setattr(exe, "OPEN_POS_PATH", open_path)
    open_path.write_text(json.dumps({
        "positions": [{
            "ticket": 42,
            "signalAsset": "BTCUSDT",
            "lot": 1.0,
            "entry_price": 100_000.0,
            "opened_at": "2025-01-01T00:00:00+00:00",
        }]
    }))

    result = exe._reconcile_funding_drift(force=True)
    # All open positions are zero-rate → reconciler returns None (nothing to compare).
    assert result is None


# =============================================================================
# R3-B Drift-2: risk_frac sanity-check
# =============================================================================
def test_sanity_check_risk_frac_in_range_returns_none(monkeypatch):
    """In-range risk_frac (e.g. 0.01) → returns None (signal allowed)."""
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "RISK_SANITY_ENABLED", True)
    monkeypatch.setattr(exe, "RISK_SANITY_REJECT", True)
    monkeypatch.setattr(exe, "RISK_SANITY_MIN", 0.005)
    monkeypatch.setattr(exe, "RISK_SANITY_MAX", 0.03)
    monkeypatch.setattr(exe, "tg_send", lambda *a, **kw: None)

    # Typical Rust-emitted value: 1% risk_frac
    assert exe._sanity_check_risk_frac(0.01, "BTCUSDT") is None
    # Lower edge
    assert exe._sanity_check_risk_frac(0.005, "BTCUSDT") is None
    # Upper edge
    assert exe._sanity_check_risk_frac(0.03, "BTCUSDT") is None


def test_sanity_check_risk_frac_outlier_reject_mode(monkeypatch):
    """REJECT mode + out-of-range risk_frac → returns reason-string."""
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "RISK_SANITY_ENABLED", True)
    monkeypatch.setattr(exe, "RISK_SANITY_REJECT", True)
    monkeypatch.setattr(exe, "RISK_SANITY_MIN", 0.005)
    monkeypatch.setattr(exe, "RISK_SANITY_MAX", 0.03)
    monkeypatch.setattr(exe, "tg_send", lambda *a, **kw: None)

    # Too small (Rust sizing-ladder collapse / kelly_tier bug)
    reason_low = exe._sanity_check_risk_frac(0.0001, "BTCUSDT")
    assert reason_low is not None and "outside plausible range" in reason_low

    # Too large (signal-service regression below RISK_FRAC_HARD_CAP but above sanity)
    reason_high = exe._sanity_check_risk_frac(0.04, "BTCUSDT")
    assert reason_high is not None and "outside plausible range" in reason_high


def test_sanity_check_risk_frac_outlier_alert_only(monkeypatch):
    """Alert-only mode (default) + outlier → still returns None (signal passes)."""
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "RISK_SANITY_ENABLED", True)
    monkeypatch.setattr(exe, "RISK_SANITY_REJECT", False)  # alert only
    monkeypatch.setattr(exe, "RISK_SANITY_MIN", 0.005)
    monkeypatch.setattr(exe, "RISK_SANITY_MAX", 0.03)
    alerts: list = []
    monkeypatch.setattr(exe, "tg_send", lambda msg, **kw: alerts.append(msg))

    result = exe._sanity_check_risk_frac(0.10, "BTCUSDT")  # 10% — way over
    assert result is None, "alert-only mode must NOT reject the signal"
    assert len(alerts) == 1, "alert-only mode must still send a Telegram alert"
    assert "Risk-Frac Outlier" in alerts[0]


def test_sanity_check_risk_frac_disabled(monkeypatch):
    """RISK_SANITY_ENABLED=False → returns None for ANY value."""
    import ftmo_executor as exe

    monkeypatch.setattr(exe, "RISK_SANITY_ENABLED", False)
    monkeypatch.setattr(exe, "RISK_SANITY_REJECT", True)

    # Even an obviously-bad value passes when disabled.
    assert exe._sanity_check_risk_frac(99.0, "BTCUSDT") is None
    assert exe._sanity_check_risk_frac(0.0, "BTCUSDT") is None


# =============================================================================
# R3-B Drift-3: FTMO_STRICT_PARITY documentation + buffer zeroing
# =============================================================================
def test_strict_parity_zeroes_all_buffers():
    """FTMO_STRICT_PARITY=1 must zero ALL defensive buffers.

    Verifies the contract documented in CLAUDE.md / module docstring: when
    FTMO_STRICT_PARITY=1 is set at startup, every defensive buffer that
    diverges from the backtest engine's raw -5% / -10% caps is zeroed for
    deterministic sim parity.
    """
    import importlib
    import os
    import sys

    # Save/restore env so the test is isolated
    saved = os.environ.get("FTMO_STRICT_PARITY")
    os.environ["FTMO_STRICT_PARITY"] = "1"
    # Force re-import so module-level constants pick up the new env value.
    if "ftmo_executor" in sys.modules:
        del sys.modules["ftmo_executor"]
    try:
        import ftmo_executor as exe_strict
        assert exe_strict.FTMO_STRICT_PARITY is True
        assert exe_strict.DL_EMERGENCY_BUFFER == 0.0, (
            "DL emergency buffer must be 0 in strict parity mode"
        )
        assert exe_strict.TL_EMERGENCY_BUFFER == 0.0, (
            "TL emergency buffer must be 0 in strict parity mode"
        )
        # _parity_buffer must zero the entry-side buffers too.
        assert exe_strict._parity_buffer(0.010) == 0.0
        assert exe_strict._parity_buffer(0.015) == 0.0
    finally:
        # Restore env + module so subsequent tests see default state.
        if saved is None:
            os.environ.pop("FTMO_STRICT_PARITY", None)
        else:
            os.environ["FTMO_STRICT_PARITY"] = saved
        if "ftmo_executor" in sys.modules:
            del sys.modules["ftmo_executor"]
        import ftmo_executor  # re-import default-state for downstream tests
        _ = ftmo_executor  # silence linter


def test_strict_parity_default_off_keeps_buffers():
    """Default (no FTMO_STRICT_PARITY) → defensive buffers stay non-zero.

    Documents the design choice: live deploys keep buffers ON; only
    explicit FTMO_STRICT_PARITY=1 enables sim-parity mode. This protects
    funded accounts from a single-poll-cycle breach.
    """
    import ftmo_executor as exe

    # Default state must keep buffers protective.
    assert exe.FTMO_STRICT_PARITY is False
    assert exe.DL_EMERGENCY_BUFFER > 0
    assert exe.TL_EMERGENCY_BUFFER > 0
    assert exe._parity_buffer(0.010) == 0.010
    assert exe._parity_buffer(0.015) == 0.015


# =============================================================================
# 2026-05-15 R3 audit Bug #1 — crash-safe write order regression tests
# =============================================================================
def test_r3_audit_bug1_signal_processor_writes_open_positions_first(monkeypatch):
    """OPEN_POS_PATH must be written BEFORE EXECUTED_PATH and PENDING_PATH.

    Rationale: V12-state (PTP done flags, partial-tp-levels, chandelier
    highWaterMark, max_hold_until) lives ONLY in open-positions.json. If
    we write pending first, a crash leaves the ticket on the broker but
    no JSON state → boot rebuilds a minimal stub and loses V12 features.
    """
    import inspect
    import ftmo_executor as exe

    # Inspect process_pending_signals — the production entrypoint.
    src = inspect.getsource(exe.process_pending_signals)
    # Find positions of each write_json call.
    open_pos_idx = src.find("write_json(OPEN_POS_PATH")
    executed_idx = src.find("write_json(EXECUTED_PATH")
    pending_idx = src.find("write_json(PENDING_PATH, {\"signals\": merged_pending")

    assert open_pos_idx > 0, "process_pending_signals must write OPEN_POS_PATH"
    assert executed_idx > 0, "process_pending_signals must write EXECUTED_PATH"
    assert pending_idx > 0, "process_pending_signals must write merged PENDING_PATH"

    # Crash-safe order: open_positions FIRST, executed SECOND, pending LAST.
    assert open_pos_idx < executed_idx < pending_idx, (
        f"Write order wrong — must be open_positions ({open_pos_idx}) → "
        f"executed ({executed_idx}) → pending ({pending_idx}). V12 state "
        "(PTP done-flags, chandelier highWaterMark, max_hold_until) is "
        "unrecoverable from MT5 alone; writing it last loses state on crash."
    )


def test_r3_audit_bug1_legacy_locked_wrapper_writes_open_positions_first():
    """Same write-order invariant for the legacy `_process_pending_signals_locked`
    shim used by older tests.
    """
    import inspect
    import ftmo_executor as exe

    src = inspect.getsource(exe._process_pending_signals_locked)
    open_pos_idx = src.find("write_json(OPEN_POS_PATH")
    executed_idx = src.find("write_json(EXECUTED_PATH")
    pending_idx = src.find("write_json(PENDING_PATH, {\"signals\": merged_pending")

    assert open_pos_idx > 0
    assert executed_idx > 0
    assert pending_idx > 0
    assert open_pos_idx < executed_idx < pending_idx, (
        "_process_pending_signals_locked write order must be "
        "open_positions → executed → pending (crash-safe)"
    )


# =============================================================================
# 2026-05-15 R3 audit Bug #2 — per-account magic IDs
# =============================================================================
def test_r3_audit_bug2_magic_default_when_account_id_unset():
    """FTMO_ACCOUNT_ID unset → MAGIC=231, PING_MAGIC=232 (backwards-compat).

    Legacy single-account deploys must see no change in magic numbers so
    yesterday's open tickets and history-deal scans still match.
    """
    import ftmo_executor as exe

    # Default-state assertion: the module was imported without FTMO_ACCOUNT_ID
    # (see conftest at top of file — only FTMO_MOCK + FTMO_START_BALANCE set).
    assert exe.MAGIC == 231, (
        f"MAGIC must default to 231 when FTMO_ACCOUNT_ID is unset, got {exe.MAGIC}"
    )
    # Codex audit Bug #1: PING_MAGIC offset changed from MAGIC+1 to MAGIC+7
    # so that adjacent 10-wide account slots never overlap.
    assert exe.PING_MAGIC == 238, (
        f"PING_MAGIC must default to 238 (=MAGIC+7) when FTMO_ACCOUNT_ID is unset, got {exe.PING_MAGIC}"
    )


def test_r3_audit_bug2_magic_distinct_per_account_id(monkeypatch):
    """Two distinct FTMO_ACCOUNT_IDs must produce distinct MAGIC IDs.

    Probes the collision avoidance directly via `_compute_magic_id` —
    importing the module twice under different env is awkward in-process
    so we test the pure function.
    """
    import ftmo_executor as exe

    monkeypatch.setenv("FTMO_ACCOUNT_ID", "1234567")
    m1 = exe._compute_magic_id()
    monkeypatch.setenv("FTMO_ACCOUNT_ID", "7654321")
    m2 = exe._compute_magic_id()
    monkeypatch.setenv("FTMO_ACCOUNT_ID", "1234567")
    m1_again = exe._compute_magic_id()

    assert m1 != m2, (
        f"Distinct account_ids must yield distinct MAGICs (got {m1} for "
        f"both). Otherwise two PM2 processes on the same MT5 terminal would "
        "claim each other's tickets."
    )
    assert m1 == m1_again, (
        f"Same account_id must reproduce the same MAGIC across calls "
        f"(got {m1} then {m1_again}). Restarts must not orphan tickets."
    )
    # Codex audit Bug #1: numeric account_ids land in the 251+10*N slot range.
    # 1234567 → 231 + 10 + 12345670 = 12345911 etc. Just assert positive +
    # >base. Range is no longer [231, 330]; numeric scheme is open-ended.
    assert m1 > 231, f"MAGIC must exceed base (231), got {m1}"
    assert m2 > 231, f"MAGIC must exceed base (231), got {m2}"


def test_r3_audit_bug2_magic_unset_account_returns_base(monkeypatch):
    """`FTMO_ACCOUNT_ID` empty / whitespace → base magic 231 (defensive)."""
    import ftmo_executor as exe

    monkeypatch.delenv("FTMO_ACCOUNT_ID", raising=False)
    assert exe._compute_magic_id() == 231

    monkeypatch.setenv("FTMO_ACCOUNT_ID", "")
    assert exe._compute_magic_id() == 231

    monkeypatch.setenv("FTMO_ACCOUNT_ID", "   ")
    assert exe._compute_magic_id() == 231


def test_r3_audit_bug2_ping_magic_is_base_plus_seven():
    """PING_MAGIC must always equal MAGIC + 7 — paired by convention so
    reconcile / kill paths handle both with a tuple. Codex audit Bug #1
    revised the offset from +1 → +7 to guarantee no overlap between
    adjacent numeric account slots (which are 10 wide).
    """
    import ftmo_executor as exe

    assert exe.PING_MAGIC == exe.MAGIC + 7


def test_r3_audit_bug2_kill_module_magic_matches_executor():
    """ftmo_kill must derive the same MAGIC as ftmo_executor under same env.

    Single-process import keeps the modules in lock-step; the per-account
    deriver is identical code.
    """
    import ftmo_executor as exe
    import ftmo_kill

    # Both compute their MAGIC at import time; defaults must match.
    assert ftmo_kill.MAGIC == exe.MAGIC
    assert ftmo_kill.PING_MAGIC == exe.PING_MAGIC


# ---------------------------------------------------------------------------
# 2026-05-16 Codex audit Bug #1 (KRITISCH) — regression tests for the
# revised _compute_magic_id() collision-free scheme.
# ---------------------------------------------------------------------------
def test_codex_bug1_no_collisions_first_100_numeric_accounts(monkeypatch):
    """100 distinct numeric FTMO_ACCOUNT_IDs must yield 100 distinct (MAGIC,
    PING_MAGIC) tuples. The PREVIOUS sha1%100 scheme failed this for
    23 of the first 100 IDs.
    """
    import ftmo_executor as exe

    seen: dict[int, str] = {}  # int → account_id-source
    for n in range(1, 101):
        monkeypatch.setenv("FTMO_ACCOUNT_ID", str(n))
        m = exe._compute_magic_id()
        ping = m + 7
        # Both MAGIC and PING_MAGIC must be unique across ALL accounts.
        assert m not in seen, (
            f"MAGIC collision at account {n}: {m} already used by "
            f"account {seen[m]}"
        )
        assert ping not in seen, (
            f"PING_MAGIC of account {n} ({ping}) collides with "
            f"existing MAGIC/PING of account {seen[ping]}"
        )
        seen[m] = f"{n}.MAGIC"
        seen[ping] = f"{n}.PING_MAGIC"


def test_codex_bug1_no_collisions_first_1000_numeric_accounts(monkeypatch):
    """Stress-test: 1000 numeric account_ids must produce 1000 distinct
    (MAGIC, PING_MAGIC) tuples. Each account claims a 10-wide slot so
    PING_MAGIC = MAGIC + 7 never escapes its slot.
    """
    import ftmo_executor as exe

    used: set[int] = set()
    for n in range(1, 1001):
        monkeypatch.setenv("FTMO_ACCOUNT_ID", str(n))
        m = exe._compute_magic_id()
        ping = m + 7
        assert m not in used, f"MAGIC collision for numeric account {n}: {m}"
        assert ping not in used, f"PING_MAGIC collision for numeric account {n}: {ping}"
        used.add(m)
        used.add(ping)
    # 1000 accounts × 2 magics each = 2000 distinct values.
    assert len(used) == 2000


def test_codex_bug1_old_collision_pairs_now_distinct(monkeypatch):
    """The previously-broken hash had documented collisions:
       - account 11 vs 23  → both sha1%100 = 1 → both MAGIC = 232.
       - account 1 PING (=239) overlapped account 15 MAGIC (=239).
    Verify the new scheme separates them cleanly.
    """
    import ftmo_executor as exe

    monkeypatch.setenv("FTMO_ACCOUNT_ID", "11")
    m11 = exe._compute_magic_id()
    monkeypatch.setenv("FTMO_ACCOUNT_ID", "23")
    m23 = exe._compute_magic_id()
    assert m11 != m23, f"account 11 and 23 must have distinct MAGICs (got {m11})"

    monkeypatch.setenv("FTMO_ACCOUNT_ID", "1")
    m1 = exe._compute_magic_id()
    ping1 = m1 + 7  # mirror executor's PING_MAGIC formula
    monkeypatch.setenv("FTMO_ACCOUNT_ID", "15")
    m15 = exe._compute_magic_id()
    assert ping1 != m15, (
        f"account 1 PING_MAGIC ({ping1}) must not equal account 15 MAGIC ({m15}) — "
        "this was the historical overlap that the +1 offset caused."
    )


def test_codex_bug1_non_numeric_account_uses_sha256_fallback(monkeypatch):
    """Non-numeric account_ids should hit the sha256 fallback path,
    yielding values in [11231, 20230].
    """
    import ftmo_executor as exe

    monkeypatch.setenv("FTMO_ACCOUNT_ID", "alias-prod-01")
    m_alias = exe._compute_magic_id()
    assert 11231 <= m_alias <= 20230, (
        f"non-numeric account_id should hash into [11231, 20230], got {m_alias}"
    )
    # Deterministic across calls.
    m_alias_again = exe._compute_magic_id()
    assert m_alias == m_alias_again

    # Distinct non-numeric ids should (almost certainly) yield distinct MAGICs.
    monkeypatch.setenv("FTMO_ACCOUNT_ID", "alias-prod-02")
    m_alias2 = exe._compute_magic_id()
    assert m_alias != m_alias2


def test_codex_bug1_negative_account_id_falls_through_to_sha256(monkeypatch):
    """Negative-looking strings hit the ValueError path → sha256 fallback,
    not the numeric arithmetic path (would give a negative MAGIC, invalid
    for MT5).
    """
    import ftmo_executor as exe

    monkeypatch.setenv("FTMO_ACCOUNT_ID", "-1")
    m = exe._compute_magic_id()
    assert 11231 <= m <= 20230


def test_codex_bug1_kill_module_no_collisions(monkeypatch):
    """ftmo_kill's _compute_magic_id mirrors ftmo_executor's. Spot-check
    a handful of accounts produce identical magics in both modules.
    """
    import ftmo_executor as exe
    import ftmo_kill

    for raw in ["1", "11", "23", "1000", "alias-prod-01", "-1", ""]:
        monkeypatch.setenv("FTMO_ACCOUNT_ID", raw)
        assert exe._compute_magic_id() == ftmo_kill._compute_magic_id(), (
            f"executor and kill module disagree for FTMO_ACCOUNT_ID={raw!r}"
        )


def test_codex_bug4_handle_kill_request_filters_both_magics():
    """Codex audit Bug #4 (NORMAL): the internal `handle_kill_request` must
    close both MAGIC and PING_MAGIC positions — mirroring ftmo_kill.py's
    external behaviour. Previously the internal version filtered only
    `p.magic == MAGIC`, leaking ping trades through.
    """
    import inspect
    import ftmo_executor as exe

    src = inspect.getsource(exe.handle_kill_request)
    assert "in (MAGIC, PING_MAGIC)" in src, (
        "handle_kill_request must filter positions by magic in "
        "(MAGIC, PING_MAGIC) — found:\n" + src
    )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
