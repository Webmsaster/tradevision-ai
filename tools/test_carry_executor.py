"""Unit tests for tools/carry_executor.py — guard, re-open, book sync.

Run:
    /usr/bin/python3 -m pytest tools/test_carry_executor.py -v
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

TOOLS = Path(__file__).parent
sys.path.insert(0, str(TOOLS))

from carry_executor import MAGIC, CarryExecutor  # noqa: E402

TZ = ZoneInfo("Europe/Prague")


class FakeMT5:
    """Stateful MT5 double in HEDGE mode (like real FTMO accounts): an order
    without `position` opens a NEW position; with `position` it reduces that
    ticket. The old netting double masked the 2026-06-10 hedge-leg incident."""
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    TRADE_ACTION_DEAL = 1
    ORDER_TIME_GTC = 0
    TRADE_RETCODE_DONE = 10009

    def __init__(self, equity=10_000.0):
        self.equity = equity
        self._legs: dict[int, SimpleNamespace] = {}   # ticket -> position
        self._next_ticket = 1
        self.steps: dict[str, float] = {}             # symbol -> volume_step
        self.orders: list[dict] = []

    @property
    def pos(self) -> dict[str, float]:
        """Net signed lots per symbol (the view most tests assert on)."""
        out: dict[str, float] = {}
        for p in self._legs.values():
            sign = 1.0 if p.type == self.POSITION_TYPE_BUY else -1.0
            out[p.symbol] = round(out.get(p.symbol, 0.0) + sign * p.volume, 4)
        return {s: v for s, v in out.items() if abs(v) > 1e-9}

    def legs(self, symbol: str) -> list:
        return [p for p in self._legs.values() if p.symbol == symbol]

    def account_info(self):
        return SimpleNamespace(equity=self.equity)

    def positions_get(self):
        return list(self._legs.values())

    def symbol_info(self, symbol):
        return SimpleNamespace(volume_step=self.steps.get(symbol, 0.01))

    def order_send(self, req):
        self.orders.append(req)
        sign = 1.0 if req["type"] == self.ORDER_TYPE_BUY else -1.0
        ticket = req.get("position")
        if ticket is not None and ticket in self._legs:    # reduce/close leg
            p = self._legs[ticket]
            p_sign = 1.0 if p.type == self.POSITION_TYPE_BUY else -1.0
            assert sign == -p_sign, "close order must oppose the targeted leg"
            p.volume = round(p.volume - req["volume"], 4)
            if p.volume <= 1e-9:
                del self._legs[ticket]
        else:                                              # hedge mode: NEW leg
            t = self._next_ticket
            self._next_ticket += 1
            self._legs[t] = SimpleNamespace(
                symbol=req["symbol"], volume=req["volume"], magic=MAGIC,
                ticket=t,
                type=self.POSITION_TYPE_BUY if sign > 0 else self.POSITION_TYPE_SELL)
        return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE)


@pytest.fixture
def setup(tmp_path):
    book = {"date": "2026-06-09", "capital": 10000, "positions": {
        "USOIL.cash": {"side": "long", "lots": 0.14},
        "NATGAS.cash": {"side": "short", "lots": 0.23},
        "COFFEE.c": {"side": "long", "lots": 5.10},
    }}
    book_f = tmp_path / "book.json"
    book_f.write_text(json.dumps(book))
    fake = FakeMT5()
    ex = CarryExecutor(fake, book_f, tmp_path / "state")
    return fake, ex


def at(day: int, hour: int = 12) -> datetime:
    return datetime(2026, 6, day, hour, 0, tzinfo=TZ)


def test_sync_opens_full_book(setup):
    fake, ex = setup
    assert ex.poll_once(at(9)) == "synced"
    assert fake.pos == {"USOIL.cash": 0.14, "NATGAS.cash": -0.23, "COFFEE.c": 5.10}


def test_guard_fires_and_halts_same_day(setup):
    fake, ex = setup
    ex.poll_once(at(9, 9))                      # book opened, day_start=10000
    fake.equity = 10_000 * (1 - 0.036)          # -3.6% intraday
    assert ex.poll_once(at(9, 15)) == "stopped"
    assert fake.pos == {}                       # everything closed
    fake.equity = 9_900                         # recovers a bit same day
    assert ex.poll_once(at(9, 18)) == "halted"  # must NOT re-open today
    assert fake.pos == {}


def test_reopens_next_server_day(setup):
    fake, ex = setup
    ex.poll_once(at(9, 9))
    fake.equity = 9_600
    ex.poll_once(at(9, 15))                     # stopped
    fake.equity = 9_640
    assert ex.poll_once(at(10, 1)) == "synced"  # new server day -> re-open
    assert set(fake.pos) == {"USOIL.cash", "NATGAS.cash", "COFFEE.c"}


def test_rollover_resets_day_start_so_guard_uses_new_base(setup):
    fake, ex = setup
    ex.poll_once(at(9))                         # day_start = 10000
    fake.equity = 9_700                         # -3.0%: below nothing yet
    assert ex.poll_once(at(9, 20)) == "synced"
    assert ex.poll_once(at(10, 1)) == "synced"  # rollover: day_start = 9700
    fake.equity = 9_400                         # -3.09% from NEW base
    assert ex.poll_once(at(10, 9)) == "synced"  # 9700*(1-.035)=9360.5 -> no stop
    fake.equity = 9_350
    assert ex.poll_once(at(10, 10)) == "stopped"


def test_rebalance_only_sends_diffs(setup):
    fake, ex = setup
    ex.poll_once(at(9))
    fake.orders.clear()
    book = json.loads(ex.book_path.read_text())
    book["positions"]["USOIL.cash"]["lots"] = 0.20      # resize
    del book["positions"]["COFFEE.c"]                   # drop
    ex.book_path.write_text(json.dumps(book))
    ex.poll_once(at(9, 14))
    sent = {(o["symbol"], o["type"], o["volume"]) for o in fake.orders}
    assert sent == {("USOIL.cash", FakeMT5.ORDER_TYPE_BUY, 0.06),
                    ("COFFEE.c", FakeMT5.ORDER_TYPE_SELL, 5.10)}
    assert fake.pos["USOIL.cash"] == pytest.approx(0.20)
    assert "COFFEE.c" not in fake.pos


def test_state_survives_restart(setup, tmp_path):
    fake, ex = setup
    ex.poll_once(at(9, 9))
    fake.equity = 9_600
    ex.poll_once(at(9, 15))                     # stopped, persisted
    ex2 = CarryExecutor(fake, ex.book_path, tmp_path / "state")
    assert ex2.poll_once(at(9, 16)) == "halted"  # restart must not re-open


def test_reduce_closes_partially_instead_of_hedging(setup):
    """2026-06-10 live incident: shrinking a leg must NOT open an opposite
    hedge position (both legs pay swap on a hedge-mode account)."""
    fake, ex = setup
    ex.poll_once(at(9))
    book = json.loads(ex.book_path.read_text())
    book["positions"]["COFFEE.c"]["lots"] = 4.00        # 5.10 -> 4.00
    ex.book_path.write_text(json.dumps(book))
    ex.poll_once(at(9, 14))
    legs = fake.legs("COFFEE.c")
    assert len(legs) == 1                               # no second hedge leg
    assert legs[0].type == FakeMT5.POSITION_TYPE_BUY
    assert legs[0].volume == pytest.approx(4.00)
    assert fake.orders[-1]["position"] == legs[0].ticket


def test_existing_hedge_pair_gets_cleaned_up(setup):
    fake, ex = setup
    ex.poll_once(at(9))
    # stray opposite leg, as left behind by the pre-fix executor
    fake.order_send({"symbol": "NATGAS.cash", "type": FakeMT5.ORDER_TYPE_BUY,
                     "volume": 0.10})
    assert len(fake.legs("NATGAS.cash")) == 2
    ex.poll_once(at(9, 14))
    legs = fake.legs("NATGAS.cash")
    assert len(legs) == 1                               # hedge leg closed...
    assert fake.pos["NATGAS.cash"] == pytest.approx(-0.23)  # ...net restored


def test_sub_step_diff_sends_no_order(setup):
    """Book lots finer than the broker volume_step must not spam orders
    every poll (e.g. WHEAT book 12.1 vs step 1.0)."""
    fake, ex = setup
    fake.steps["COFFEE.c"] = 1.0
    ex.poll_once(at(9))                                 # opens 5.0 (rounded)
    assert fake.pos["COFFEE.c"] == pytest.approx(5.0)
    fake.orders.clear()
    book = json.loads(ex.book_path.read_text())
    book["positions"]["COFFEE.c"]["lots"] = 5.40        # < half a step away
    ex.book_path.write_text(json.dumps(book))
    ex.poll_once(at(9, 14))
    assert not [o for o in fake.orders if o["symbol"] == "COFFEE.c"]
