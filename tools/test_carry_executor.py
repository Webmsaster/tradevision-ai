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
    """Minimal stateful MT5 double: orders mutate the position table."""
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    TRADE_ACTION_DEAL = 1
    ORDER_TIME_GTC = 0
    TRADE_RETCODE_DONE = 10009

    def __init__(self, equity=10_000.0):
        self.equity = equity
        self.pos: dict[str, float] = {}     # symbol -> signed lots
        self.orders: list[dict] = []

    def account_info(self):
        return SimpleNamespace(equity=self.equity)

    def positions_get(self):
        out = []
        for i, (sym, lots) in enumerate(self.pos.items()):
            out.append(SimpleNamespace(
                symbol=sym, volume=abs(lots), magic=MAGIC, ticket=i,
                type=self.POSITION_TYPE_BUY if lots > 0 else self.POSITION_TYPE_SELL))
        return out

    def order_send(self, req):
        self.orders.append(req)
        sign = 1.0 if req["type"] == self.ORDER_TYPE_BUY else -1.0
        sym = req["symbol"]
        self.pos[sym] = round(self.pos.get(sym, 0.0) + sign * req["volume"], 4)
        if abs(self.pos[sym]) < 1e-9:
            del self.pos[sym]
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
