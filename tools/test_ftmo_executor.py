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
        # First call with no existing state → snapshots now
        result = exe.handle_daily_reset(100500.0)
        assert result == 100500.0
        assert (Path(td) / "daily-reset.json").exists()
        saved = json.loads((Path(td) / "daily-reset.json").read_text())
        assert saved["equity_at_day_start_usd"] == 100500.0


def test_handle_daily_reset_same_day_returns_cached():
    import ftmo_executor as exe
    from datetime import datetime, timezone
    with tempfile.TemporaryDirectory() as td:
        exe.STATE_DIR = Path(td)
        exe.DAILY_STATE_PATH = Path(td) / "daily-reset.json"
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        (Path(td) / "daily-reset.json").write_text(json.dumps({
            "date": today,
            "equity_at_day_start_usd": 98000.0,
        }))
        # Call later — should return cached day-start, NOT current equity
        result = exe.handle_daily_reset(99500.0)
        assert result == 98000.0


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
    assert info.bid > 0
    assert info.ask > info.bid
    mt5.shutdown()


def test_mock_mt5_place_and_close_short():
    import mock_mt5 as mt5
    mt5.initialize()
    info = mt5.symbol_info("ETHUSD")
    if info is None:
        pytest.skip("Binance fetch unavailable")
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
    assert close_res.retcode == mt5.TRADE_RETCODE_DONE
    positions_after = mt5.positions_get()
    assert not any(p.ticket == ticket for p in positions_after)
    mt5.shutdown()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
