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
            _frozen_now = None

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
            _frozen_now = None

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
    assert json.loads(target.read_text()) == {"ok": True}


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
    assert json.loads(target.read_text()) == {"ok": True}


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


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
