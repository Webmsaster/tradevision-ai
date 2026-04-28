"""
Mock MT5 backend — implements the same interface as MetaTrader5 but simulates
everything using Binance prices. Lets you test ftmo_executor.py on Linux/Mac
without needing Windows + MT5 Terminal.

Only implements the subset the executor actually uses. Fills orders at current
Binance mid-price with tiny simulated slippage. SL/TP are tracked internally
and "fire" when price crosses them during subsequent polling.

Usage:
    # Set env FTMO_MOCK=1, then:
    python tools/ftmo_executor.py
    # The executor auto-detects FTMO_MOCK and imports this instead of MetaTrader5.
"""
from __future__ import annotations

import json
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone


# MT5 constants (partial — only what executor uses)
TRADE_ACTION_DEAL = 1
TRADE_ACTION_SLTP = 2  # Modify SL/TP on existing position
ORDER_TYPE_BUY = 0
ORDER_TYPE_SELL = 1
POSITION_TYPE_BUY = 0
POSITION_TYPE_SELL = 1
ORDER_TIME_GTC = 0
ORDER_FILLING_IOC = 2
TRADE_RETCODE_DONE = 10009
DEAL_ENTRY_OUT = 1

# Binance symbol mapping for price feed
BINANCE_MAP = {
    "ETHUSD": "ETHUSDT",
    "BTCUSD": "BTCUSDT",
    "SOLUSD": "SOLUSDT",
    "ETHUSDT": "ETHUSDT",
    "BTCUSDT": "BTCUSDT",
    "SOLUSDT": "SOLUSDT",
}


# ---------------- State (in-memory simulation) ----------------
_STATE = {
    "equity": 100000.0,
    "balance": 100000.0,
    "margin": 0.0,
    "margin_free": 100000.0,
    "initialized": False,
    "next_ticket": 1000000,
    "positions": {},  # ticket -> dict
    "deals": [],  # list of dict
}

# Lightweight Binance price cache (symbol -> (price, fetched_at_ms))
_PRICE_CACHE: dict[str, tuple[float, int]] = {}
_PRICE_TTL_MS = 5000


def _fetch_binance_price(binance_symbol: str) -> float:
    now = int(time.time() * 1000)
    cached = _PRICE_CACHE.get(binance_symbol)
    if cached and (now - cached[1]) < _PRICE_TTL_MS:
        return cached[0]
    try:
        url = f"https://api.binance.com/api/v3/ticker/price?symbol={binance_symbol}"
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            price = float(data["price"])
            _PRICE_CACHE[binance_symbol] = (price, now)
            return price
    except Exception as e:
        print(f"[mock_mt5] price fetch failed for {binance_symbol}: {e}")
        return cached[0] if cached else 0.0


def _get_price(ftmo_symbol: str) -> float:
    binance_sym = BINANCE_MAP.get(ftmo_symbol, ftmo_symbol)
    return _fetch_binance_price(binance_sym)


# ---------------- Classes that mimic mt5 returns ----------------
@dataclass
class AccountInfo:
    login: int = 999999
    server: str = "FTMO-Demo-Mock"
    balance: float = 0.0
    equity: float = 0.0
    margin: float = 0.0
    margin_free: float = 0.0


@dataclass
class SymbolInfo:
    name: str
    bid: float
    ask: float
    point: float = 0.01
    trade_tick_size: float = 0.01
    trade_tick_value: float = 0.01  # $ per tick per lot — simplified
    volume_min: float = 0.01
    volume_max: float = 100.0
    volume_step: float = 0.01


@dataclass
class Position:
    ticket: int
    symbol: str
    volume: float
    type: int  # POSITION_TYPE_BUY / SELL
    price_open: float
    sl: float
    tp: float
    magic: int
    comment: str
    time: int  # unix seconds
    max_hold_until: int  # ms (mock-only, not in real MT5)
    # BUGFIX 2026-04-28 (Round 37 Bug 1): real mt5 returns positions with
    # price_current; without this every _apply_trailing_stop /
    # _apply_partial_tp / _apply_chandelier_stop / _apply_break_even /
    # _apply_time_exit raised AttributeError in mock mode → silently
    # skipped all position management in CI tests.
    price_current: float = 0.0


@dataclass
class Deal:
    ticket: int
    position_id: int
    symbol: str
    volume: float
    type: int
    entry: int  # DEAL_ENTRY_IN / OUT
    price: float
    profit: float
    magic: int
    comment: str
    time: int


@dataclass
class OrderResult:
    retcode: int
    order: int = 0
    price: float = 0.0
    comment: str = ""


# ---------------- Public mt5-like API ----------------
def initialize() -> bool:
    _STATE["initialized"] = True
    print("[mock_mt5] initialized (simulating $100k FTMO demo)")
    return True


def shutdown() -> None:
    _STATE["initialized"] = False
    print("[mock_mt5] shutdown")


def last_error() -> tuple:
    return (0, "no error")


def account_info() -> AccountInfo | None:
    if not _STATE["initialized"]:
        return None
    # Recompute floating PnL from open positions
    _update_floating_equity()
    return AccountInfo(
        balance=_STATE["balance"],
        equity=_STATE["equity"],
        margin=_STATE["margin"],
        margin_free=_STATE["margin_free"],
    )


def symbol_select(symbol: str, enable: bool) -> bool:
    # Mock: always succeed if we know it
    return symbol in BINANCE_MAP


def symbol_info(symbol: str) -> SymbolInfo | None:
    price = _get_price(symbol)
    if price <= 0:
        return None
    # Simulate 2-3 bp half-spread
    spread = price * 0.00025
    return SymbolInfo(
        name=symbol,
        bid=price - spread,
        ask=price + spread,
    )


# BUGFIX 2026-04-28: parity with real mt5 module — Pyright now sees both
# `symbol_info_tick` and the `symbol=` kwarg on `positions_get`.
@dataclass
class SymbolTick:
    bid: float
    ask: float
    last: float
    volume: int = 0
    time: int = 0


def symbol_info_tick(symbol: str) -> SymbolTick | None:
    info = symbol_info(symbol)
    if info is None:
        return None
    mid = (info.bid + info.ask) / 2
    return SymbolTick(bid=info.bid, ask=info.ask, last=mid, time=int(datetime.now(timezone.utc).timestamp()))


def positions_get(ticket: int | None = None, symbol: str | None = None, magic: int | None = None) -> tuple:
    _check_position_exits()
    if ticket is not None:
        p = _STATE["positions"].get(ticket)
        if p is None:
            return ()
        _refresh_price_current(p)
        return (p,)
    out = list(_STATE["positions"].values())
    if symbol is not None:
        out = [p for p in out if getattr(p, "symbol", None) == symbol]
    if magic is not None:
        out = [p for p in out if getattr(p, "magic", None) == magic]
    for p in out:
        _refresh_price_current(p)
    return tuple(out)


def _refresh_price_current(p: Position) -> None:
    """Populate price_current with the latest mid-quote so callers can read
    `pos.price_current` like the real mt5 module returns."""
    px = _get_price(p.symbol)
    if px > 0:
        p.price_current = px


def history_deals_get(from_dt: datetime, to_dt: datetime) -> tuple:
    from_ts = int(from_dt.timestamp())
    to_ts = int(to_dt.timestamp())
    deals = [d for d in _STATE["deals"] if from_ts <= d.time <= to_ts]
    return tuple(deals)


def order_send(request: dict) -> OrderResult | None:
    symbol = request.get("symbol") or ""
    volume = float(request.get("volume", 0))
    order_type = request.get("type")
    position_id = request.get("position", 0)

    if not symbol:
        return OrderResult(retcode=10013, comment="no symbol in request")
    info = symbol_info(symbol)
    if info is None:
        return OrderResult(retcode=10013, comment=f"symbol {symbol} not found")

    # Close existing position
    if position_id and position_id in _STATE["positions"]:
        pos = _STATE["positions"][position_id]
        fill_price = info.ask if pos.type == POSITION_TYPE_SELL else info.bid
        pnl = _compute_pnl(pos, fill_price)
        _STATE["balance"] += pnl
        _record_deal(pos, fill_price, pnl, DEAL_ENTRY_OUT)
        del _STATE["positions"][position_id]
        return OrderResult(retcode=TRADE_RETCODE_DONE, order=position_id, price=fill_price, comment="mock close")

    # Open new position
    if order_type == ORDER_TYPE_SELL:
        fill_price = info.bid
        pos_type = POSITION_TYPE_SELL
    elif order_type == ORDER_TYPE_BUY:
        fill_price = info.ask
        pos_type = POSITION_TYPE_BUY
    else:
        return OrderResult(retcode=10013, comment="unknown order type")

    ticket = _STATE["next_ticket"]
    _STATE["next_ticket"] += 1

    pos = Position(
        ticket=ticket,
        symbol=symbol,
        volume=volume,
        type=pos_type,
        price_open=fill_price,
        sl=float(request.get("sl", 0)),
        tp=float(request.get("tp", 0)),
        magic=int(request.get("magic", 0)),
        comment=str(request.get("comment", ""))[:31],
        time=int(time.time()),
        max_hold_until=0,  # executor sets this separately in its own state
    )
    _STATE["positions"][ticket] = pos

    # Record entry deal
    _record_deal(pos, fill_price, 0.0, 0)  # DEAL_ENTRY_IN = 0

    print(f"[mock_mt5] OPEN {symbol} {['BUY','SELL'][pos_type]} {volume} @ {fill_price:.4f} (ticket {ticket})")
    return OrderResult(retcode=TRADE_RETCODE_DONE, order=ticket, price=fill_price, comment="mock open")


# ---------------- Internal helpers ----------------
def _compute_pnl(pos: Position, exit_price: float) -> float:
    info = symbol_info(pos.symbol)
    if info is None:
        return 0.0
    tick_size = info.trade_tick_size or 0.01
    tick_value = info.trade_tick_value or 0.01
    if pos.type == POSITION_TYPE_SELL:
        raw_move = pos.price_open - exit_price
    else:
        raw_move = exit_price - pos.price_open
    ticks = raw_move / tick_size
    return ticks * tick_value * pos.volume


def _update_floating_equity() -> None:
    floating = 0.0
    for pos in _STATE["positions"].values():
        info = symbol_info(pos.symbol)
        if info is None:
            continue
        current = info.bid if pos.type == POSITION_TYPE_SELL else info.ask
        floating += _compute_pnl(pos, current)
    _STATE["equity"] = _STATE["balance"] + floating
    _STATE["margin_free"] = _STATE["equity"] - _STATE["margin"]


def _check_position_exits() -> None:
    """Auto-close positions that hit SL or TP."""
    to_close: list[int] = []
    for ticket, pos in _STATE["positions"].items():
        info = symbol_info(pos.symbol)
        if info is None:
            continue
        bid = info.bid
        ask = info.ask
        if pos.type == POSITION_TYPE_SELL:
            # SL above entry, TP below
            if pos.sl > 0 and ask >= pos.sl:
                _close_at(pos, ask, "SL")
                to_close.append(ticket)
            elif pos.tp > 0 and bid <= pos.tp:
                _close_at(pos, bid, "TP")
                to_close.append(ticket)
        else:
            if pos.sl > 0 and bid <= pos.sl:
                _close_at(pos, bid, "SL")
                to_close.append(ticket)
            elif pos.tp > 0 and ask >= pos.tp:
                _close_at(pos, ask, "TP")
                to_close.append(ticket)
    for t in to_close:
        del _STATE["positions"][t]


def _close_at(pos: Position, price: float, reason: str) -> None:
    pnl = _compute_pnl(pos, price)
    _STATE["balance"] += pnl
    _record_deal(pos, price, pnl, DEAL_ENTRY_OUT)
    print(f"[mock_mt5] CLOSE {pos.symbol} @ {price:.4f} ({reason}) pnl=${pnl:+.2f}")


def _record_deal(pos: Position, price: float, profit: float, entry: int) -> None:
    _STATE["deals"].append(Deal(
        ticket=_STATE["next_ticket"],
        position_id=pos.ticket,
        symbol=pos.symbol,
        volume=pos.volume,
        type=pos.type,
        entry=entry,
        price=price,
        profit=profit,
        magic=pos.magic,
        comment=pos.comment,
        time=int(time.time()),
    ))
    _STATE["next_ticket"] += 1
