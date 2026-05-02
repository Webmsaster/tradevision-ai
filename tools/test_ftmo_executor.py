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


def test_regime_gate_classification_returns_known_label():
    import ftmo_executor as exe
    exe._REGIME_CACHE["ts"] = 0
    exe._REGIME_CACHE["regime"] = None
    regime = exe.classify_btc_regime()
    assert regime in {"trend-up", "trend-down", "chop", "high-vol", "calm", None}


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


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
