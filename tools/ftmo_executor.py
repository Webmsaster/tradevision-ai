"""
FTMO MT5 Executor — polls signals, places orders, manages positions.

Features:
- Places market orders with correct lot size computed from risk%
- Sets SL/TP at broker
- Enforces FTMO rules (daily loss, total loss) before each entry
- Writes account.json back so Node service has live equity
- Manages hold-time expiry (closes positions after maxHoldHours)
- **Daily reset** at UTC 00:00 — saves equityAtDayStart
- **Auto-reconnect** on MT5 disconnect — retries indefinitely
- **Mock mode** via FTMO_MOCK=1 — uses tools/mock_mt5.py for Linux/Mac testing
- **Telegram alerts** via TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars

Run real:
    pip install MetaTrader5
    python tools/ftmo_executor.py

Run mock (no MT5 needed, simulates on Binance prices):
    FTMO_MOCK=1 python tools/ftmo_executor.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Resolve tools/ dir so we can import mock_mt5 when needed
_TOOLS_DIR = Path(__file__).resolve().parent
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

MOCK_MODE = os.environ.get("FTMO_MOCK", "").lower() in ("1", "true", "yes")

if MOCK_MODE:
    print("[executor] MOCK MODE — using tools/mock_mt5.py (no real MT5)")
    import mock_mt5 as mt5  # type: ignore
else:
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError:
        print("ERROR: MetaTrader5 library not found. Install with: pip install MetaTrader5")
        print("       OR run in mock mode: FTMO_MOCK=1 python tools/ftmo_executor.py")
        sys.exit(1)

from telegram_notify import tg_send, html_escape  # type: ignore


# =============================================================================
# Config — via env vars
# =============================================================================
STATE_DIR = Path(os.environ.get("FTMO_STATE_DIR", "./ftmo-state"))
POLL_INTERVAL_SEC = 30
RECONNECT_BACKOFF_SEC = 10
CHALLENGE_START_BALANCE = float(os.environ.get("FTMO_START_BALANCE", "100000"))
MAX_DAILY_LOSS_PCT = 0.05
MAX_TOTAL_LOSS_PCT = 0.10
CHALLENGE_START_DATE = os.environ.get("FTMO_START_DATE")

# Circuit breaker — pause trading after N consecutive losses
CB_LOSS_STREAK = int(os.environ.get("FTMO_CB_LOSS_STREAK", "3"))
# Daily DD warning threshold (alert only, not pause)
CB_DAILY_DD_WARN_PCT = float(os.environ.get("FTMO_CB_DAILY_DD_WARN", "0.03"))
# Equity history sample interval
EQUITY_HISTORY_INTERVAL_SEC = 300  # 5 minutes

SYMBOL_MAP = {
    "ETHUSDT": os.environ.get("FTMO_ETH_SYMBOL", "ETHUSD"),
    "BTCUSDT": os.environ.get("FTMO_BTC_SYMBOL", "BTCUSD"),
    "SOLUSDT": os.environ.get("FTMO_SOL_SYMBOL", "SOLUSD"),
}

PENDING_PATH = STATE_DIR / "pending-signals.json"
EXECUTED_PATH = STATE_DIR / "executed-signals.json"
ACCOUNT_PATH = STATE_DIR / "account.json"
OPEN_POS_PATH = STATE_DIR / "open-positions.json"
EXECUTOR_LOG_PATH = STATE_DIR / "executor-log.jsonl"
DAILY_STATE_PATH = STATE_DIR / "daily-reset.json"
CONTROLS_PATH = STATE_DIR / "bot-controls.json"
EQUITY_HISTORY_PATH = STATE_DIR / "equity-history.jsonl"


# =============================================================================
# IO helpers
# =============================================================================
def log_event(event: str, **kwargs: Any) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **kwargs}
    with open(EXECUTOR_LOG_PATH, "a") as f:
        f.write(json.dumps(entry) + "\n")
    print(f"[executor] {event}: {kwargs}")


def read_json(path: Path, fallback: Any) -> Any:
    try:
        if not path.exists():
            return fallback
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"[executor] failed to read {path}: {e}")
        return fallback


def write_json(path: Path, obj: Any) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    tmp.replace(path)


# =============================================================================
# MT5 connection — with reconnect
# =============================================================================
def mt5_init_with_retry() -> bool:
    """Try to initialize. On success returns True. Caller handles retry."""
    if mt5.initialize():
        info = mt5.account_info()
        if info is not None:
            log_event("mt5_connected", login=info.login, server=info.server, balance=info.balance, equity=info.equity)
            return True
    err = mt5.last_error() if hasattr(mt5, "last_error") else ("?", "?")
    log_event("mt5_init_failed", error=str(err))
    return False


def mt5_ensure_connected() -> bool:
    """Check if MT5 is still connected. If not, try to reconnect. Blocks until success."""
    info = mt5.account_info()
    if info is not None:
        return True
    log_event("mt5_disconnected", action="attempting_reconnect")
    tg_send(f"⚠️ <b>MT5 Disconnected</b>\nExecutor attempting reconnect every {RECONNECT_BACKOFF_SEC}s…")
    attempt = 0
    while True:
        attempt += 1
        try:
            mt5.shutdown()
        except Exception:
            pass
        time.sleep(RECONNECT_BACKOFF_SEC)
        if mt5_init_with_retry():
            log_event("mt5_reconnected", attempt=attempt)
            tg_send(f"✅ <b>MT5 Reconnected</b> after {attempt} attempt(s)")
            return True
        if attempt == 3 or attempt == 10 or attempt % 30 == 0:
            log_event("mt5_still_disconnected", attempt=attempt)
            tg_send(f"🔴 <b>MT5 still down</b> — attempt #{attempt}, backoff {RECONNECT_BACKOFF_SEC}s")


def mt5_get_equity() -> dict:
    info = mt5.account_info()
    if info is None:
        return {"equity": None, "balance": None, "margin": None, "free_margin": None}
    return {
        "equity": float(info.equity),
        "balance": float(info.balance),
        "margin": float(info.margin),
        "free_margin": float(info.margin_free),
    }


# =============================================================================
# FTMO rules + daily reset
# =============================================================================
def check_ftmo_rules(current_equity: float, day_start_equity: float) -> Optional[str]:
    daily_pct = (current_equity - day_start_equity) / day_start_equity
    if daily_pct <= -MAX_DAILY_LOSS_PCT + 0.005:
        return f"daily_loss: {daily_pct:.2%} near -{MAX_DAILY_LOSS_PCT:.0%} cap"
    total_pct = (current_equity - CHALLENGE_START_BALANCE) / CHALLENGE_START_BALANCE
    if total_pct <= -MAX_TOTAL_LOSS_PCT + 0.01:
        return f"total_loss: {total_pct:.2%} near -{MAX_TOTAL_LOSS_PCT:.0%} cap"
    return None


def get_challenge_day() -> int:
    if not CHALLENGE_START_DATE:
        return 0
    try:
        start = datetime.fromisoformat(CHALLENGE_START_DATE).replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        return max(0, (now - start).days)
    except Exception:
        return 0


def handle_daily_reset(current_equity_usd: float) -> float:
    """
    Return the equity-at-day-start (in USD). At UTC 00:00 each calendar day,
    snapshots the current equity as the new day-start baseline.
    Persists to daily-reset.json.
    """
    today_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    state = read_json(DAILY_STATE_PATH, {})
    last_date = state.get("date")

    if last_date != today_utc:
        # New UTC day — snapshot current equity
        new_state = {
            "date": today_utc,
            "equity_at_day_start_usd": current_equity_usd,
            "snapped_at": datetime.now(timezone.utc).isoformat(),
        }
        write_json(DAILY_STATE_PATH, new_state)
        if last_date is not None:
            prev_start = state.get("equity_at_day_start_usd", current_equity_usd)
            prev_pnl = current_equity_usd - prev_start
            prev_pct = prev_pnl / prev_start if prev_start else 0
            log_event("daily_reset", prev_date=last_date, new_date=today_utc, prev_day_pnl=prev_pnl)
            tg_send(
                f"📅 <b>Daily Reset {today_utc}</b>\n"
                f"Yesterday ({last_date}): <b>{prev_pct:+.2%}</b> (${prev_pnl:+,.2f})\n"
                f"Today starts at equity: <b>${current_equity_usd:,.2f}</b>"
            )
        else:
            log_event("daily_state_first_write", date=today_utc, equity=current_equity_usd)
        return current_equity_usd
    return float(state.get("equity_at_day_start_usd", current_equity_usd))


# =============================================================================
# Orders
# =============================================================================
@dataclass
class OrderResult:
    ok: bool
    ticket: Optional[int]
    error: Optional[str]
    lot: Optional[float]
    entry_price: Optional[float]


def compute_lot_size(symbol_info: Any, risk_frac: float, stop_pct: float, account_equity: float) -> float:
    risk_usd = account_equity * risk_frac
    tick_size = symbol_info.trade_tick_size or symbol_info.point
    tick_value = symbol_info.trade_tick_value or 1.0
    current_price = (symbol_info.ask + symbol_info.bid) / 2 if (symbol_info.ask and symbol_info.bid) else 0
    if tick_size <= 0 or tick_value <= 0 or current_price <= 0:
        return 0.0
    stop_distance_price = current_price * stop_pct
    loss_per_lot = (stop_distance_price / tick_size) * tick_value
    if loss_per_lot <= 0:
        return 0.0
    lot = risk_usd / loss_per_lot
    step = symbol_info.volume_step or 0.01
    lot = max(symbol_info.volume_min or 0.01, round(lot / step) * step)
    if symbol_info.volume_max:
        lot = min(lot, symbol_info.volume_max)
    return float(lot)


def place_short_market(
    binance_symbol: str, risk_frac: float, stop_pct: float, tp_pct: float,
    account_equity: float, comment: str,
) -> OrderResult:
    ftmo_symbol = SYMBOL_MAP.get(binance_symbol)
    if not ftmo_symbol:
        return OrderResult(False, None, f"unknown symbol {binance_symbol}", None, None)
    if not mt5.symbol_select(ftmo_symbol, True):
        return OrderResult(False, None, f"symbol_select failed for {ftmo_symbol}", None, None)
    info = mt5.symbol_info(ftmo_symbol)
    if info is None or info.bid == 0 or info.ask == 0:
        return OrderResult(False, None, f"symbol_info not ready for {ftmo_symbol}", None, None)

    lot = compute_lot_size(info, risk_frac, stop_pct, account_equity)
    if lot <= 0:
        return OrderResult(False, None, "lot computation returned 0", None, None)

    entry_price = info.bid
    stop_price = entry_price * (1 + stop_pct)
    tp_price = entry_price * (1 - tp_pct)

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": ftmo_symbol,
        "volume": lot,
        "type": mt5.ORDER_TYPE_SELL,
        "price": entry_price,
        "sl": stop_price,
        "tp": tp_price,
        "deviation": 20,
        "magic": 231,
        "comment": comment[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    if result is None:
        return OrderResult(False, None, "order_send returned None", lot, entry_price)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return OrderResult(False, None, f"retcode={result.retcode} {getattr(result, 'comment', '')}", lot, entry_price)
    return OrderResult(True, result.order, None, lot, result.price)


def close_position(ticket: int) -> bool:
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        return True
    pos = positions[0]
    info = mt5.symbol_info(pos.symbol)
    if info is None:
        return False
    price = info.ask if pos.type == mt5.POSITION_TYPE_SELL else info.bid
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": pos.volume,
        "type": mt5.ORDER_TYPE_BUY if pos.type == mt5.POSITION_TYPE_SELL else mt5.ORDER_TYPE_SELL,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "magic": 231,
        "comment": "iter231 close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
    if ok:
        log_event("closed", ticket=ticket, close_price=result.price)
    else:
        log_event("close_failed", ticket=ticket, retcode=getattr(result, "retcode", None))
    return ok


# =============================================================================
# Main loop
# =============================================================================
def process_pending_signals() -> None:
    data = read_json(PENDING_PATH, {"signals": []})
    pending = data.get("signals", [])
    if not pending:
        return

    executed = read_json(EXECUTED_PATH, {"executions": []})
    open_positions = read_json(OPEN_POS_PATH, {"positions": []})

    acct = mt5_get_equity()
    account_equity = acct["equity"] or CHALLENGE_START_BALANCE
    day_start_usd = handle_daily_reset(account_equity)

    remaining: list[dict] = []
    for sig in pending:
        blocker = check_ftmo_rules(account_equity, day_start_usd)
        if blocker:
            log_event("rule_block", asset=sig["assetSymbol"], reason=blocker)
            tg_send(f"🛑 <b>FTMO Rule Block</b>\nAsset: {sig['assetSymbol']}\nReason: {html_escape(blocker)}")
            executed["executions"].append({
                "signal": sig, "result": "blocked", "reason": blocker,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        result = place_short_market(
            binance_symbol=sig["sourceSymbol"],
            risk_frac=sig["riskFrac"],
            stop_pct=sig["stopPct"],
            tp_pct=sig["tpPct"],
            account_equity=account_equity,
            comment=f"iter231 {sig['assetSymbol']}",
        )
        if result.ok:
            log_event("order_placed", asset=sig["assetSymbol"], ticket=result.ticket, lot=result.lot, entry=result.entry_price)
            tg_send(
                f"✅ <b>ORDER PLACED</b>\n"
                f"{sig['assetSymbol']} SHORT\n"
                f"Ticket: <code>{result.ticket}</code>\n"
                f"Lot: {result.lot} @ ${result.entry_price:.4f}\n"
                f"Risk: {sig['riskFrac']*100:.3f}% of equity"
            )
            open_positions["positions"].append({
                "ticket": result.ticket,
                "signalAsset": sig["assetSymbol"],
                "sourceSymbol": sig["sourceSymbol"],
                "direction": "short",
                "lot": result.lot,
                "entry_price": result.entry_price,
                "stop_price": sig["stopPrice"],
                "tp_price": sig["tpPrice"],
                "max_hold_until": sig["maxHoldUntil"],
                "opened_at": datetime.now(timezone.utc).isoformat(),
            })
            executed["executions"].append({
                "signal": sig, "result": "placed", "ticket": result.ticket,
                "actual_entry": result.entry_price, "lot": result.lot,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
        else:
            log_event("order_failed", asset=sig["assetSymbol"], error=result.error)
            tg_send(f"❌ <b>ORDER FAILED</b>\n{sig['assetSymbol']}\nError: {html_escape(result.error or 'unknown')}")
            executed["executions"].append({
                "signal": sig, "result": "failed", "error": result.error,
                "ts": datetime.now(timezone.utc).isoformat(),
            })

    write_json(PENDING_PATH, {"signals": remaining})
    write_json(EXECUTED_PATH, executed)
    write_json(OPEN_POS_PATH, open_positions)


def manage_open_positions() -> None:
    open_positions = read_json(OPEN_POS_PATH, {"positions": []})
    now_ms = int(time.time() * 1000)
    still_open: list[dict] = []
    for pos in open_positions.get("positions", []):
        live = mt5.positions_get(ticket=pos["ticket"])
        if not live:
            log_event("position_gone", ticket=pos["ticket"], reason="closed by SL/TP or manually")
            tg_send(f"📉 <b>Position Closed (SL/TP)</b>\n{pos['signalAsset']} ticket <code>{pos['ticket']}</code>")
            continue
        if now_ms >= pos.get("max_hold_until", 0):
            log_event("hold_expired", ticket=pos["ticket"])
            if close_position(pos["ticket"]):
                tg_send(f"⏱ <b>Hold Expired — Closed</b>\n{pos['signalAsset']} ticket <code>{pos['ticket']}</code>")
            continue
        still_open.append(pos)
    write_json(OPEN_POS_PATH, {"positions": still_open})


def sync_account_state() -> None:
    acct = mt5_get_equity()
    if acct["equity"] is None:
        return
    equity_frac = acct["equity"] / CHALLENGE_START_BALANCE
    day_start_usd = handle_daily_reset(acct["equity"])

    deals = mt5.history_deals_get(datetime.fromtimestamp(time.time() - 30 * 86400), datetime.now())
    recent_pnls: list[float] = []
    if deals:
        closes = [d for d in deals if d.magic == 231 and d.entry == mt5.DEAL_ENTRY_OUT]
        closes.sort(key=lambda d: d.time)
        for d in closes[-20:]:
            recent_pnls.append(d.profit / CHALLENGE_START_BALANCE)

    state = {
        "equity": equity_frac,
        "day": get_challenge_day(),
        "recentPnls": recent_pnls,
        "equityAtDayStart": day_start_usd / CHALLENGE_START_BALANCE,
        "raw_equity_usd": acct["equity"],
        "raw_balance_usd": acct["balance"],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(ACCOUNT_PATH, state)


def handle_kill_request() -> bool:
    """Check bot-controls.json for killRequested. If set, close all positions
    and reset the flag. Returns True if kill was processed."""
    controls = read_json(CONTROLS_PATH, {})
    if not controls.get("killRequested"):
        return False
    log_event("kill_requested", from_controls=True)
    tg_send("🛑 <b>Kill-request received</b> — closing all bot positions...")
    positions = mt5.positions_get()
    closed = 0
    for pos in positions or []:
        if pos.magic == 231:
            if close_position(pos.ticket):
                closed += 1
    # Reset flag, keep paused
    controls["killRequested"] = False
    controls["paused"] = True
    write_json(CONTROLS_PATH, controls)
    tg_send(f"🛑 <b>Kill complete</b> — {closed} position(s) closed. Bot is PAUSED. Send /resume to re-enable.")
    log_event("kill_complete", closed=closed)
    return True


def is_paused() -> bool:
    controls = read_json(CONTROLS_PATH, {})
    return bool(controls.get("paused"))


_last_equity_snapshot = [0.0]  # wrapped in list for closure mutation
_last_cb_check_streak = [0]
_last_dd_warn_sent = [""]  # date of last dd warn sent, to avoid spam


def sample_equity_history(current_equity_usd: float) -> None:
    """Append equity snapshot to equity-history.jsonl every EQUITY_HISTORY_INTERVAL_SEC."""
    now = time.time()
    if now - _last_equity_snapshot[0] < EQUITY_HISTORY_INTERVAL_SEC:
        return
    _last_equity_snapshot[0] = now
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "equity_usd": current_equity_usd,
        "equity_pct": (current_equity_usd - CHALLENGE_START_BALANCE) / CHALLENGE_START_BALANCE,
    }
    with open(EQUITY_HISTORY_PATH, "a") as f:
        f.write(json.dumps(entry) + "\n")


def check_circuit_breaker() -> Optional[str]:
    """
    Check recent closed trades (last 20 in 30d window) for consecutive losses.
    Returns a block-reason string if the CB trips, else None.
    Also sends daily-DD warning via Telegram once per day if threshold exceeded.
    """
    deals = mt5.history_deals_get(datetime.fromtimestamp(time.time() - 30 * 86400), datetime.now())
    if not deals:
        return None

    closes = [d for d in deals if d.magic == 231 and d.entry == mt5.DEAL_ENTRY_OUT]
    closes.sort(key=lambda d: d.time)

    # Count consecutive losses from most recent
    streak = 0
    for d in reversed(closes[-CB_LOSS_STREAK * 2:]):
        if d.profit < 0:
            streak += 1
        else:
            break

    if streak > _last_cb_check_streak[0]:
        # Streak grew
        if streak >= CB_LOSS_STREAK:
            # Trip the breaker: set paused flag
            controls = read_json(CONTROLS_PATH, {})
            if not controls.get("paused"):
                controls["paused"] = True
                controls["lastCommand"] = {
                    "from": "circuit-breaker",
                    "cmd": "/pause",
                    "ts": datetime.now(timezone.utc).isoformat(),
                }
                write_json(CONTROLS_PATH, controls)
                log_event("circuit_breaker_tripped", streak=streak)
                tg_send(
                    f"🚨 <b>CIRCUIT BREAKER TRIPPED</b>\n"
                    f"{streak} consecutive losses detected.\n"
                    f"Bot auto-PAUSED. Review and send /resume when ready.",
                )
                _last_cb_check_streak[0] = streak
                return f"circuit_breaker: {streak} consecutive losses"
    _last_cb_check_streak[0] = streak
    return None


def check_daily_dd_warning(current_equity_usd: float, day_start_usd: float) -> None:
    """Send one Telegram warning per day if daily DD passes CB_DAILY_DD_WARN_PCT."""
    if day_start_usd <= 0:
        return
    daily_pct = (current_equity_usd - day_start_usd) / day_start_usd
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if daily_pct <= -CB_DAILY_DD_WARN_PCT and _last_dd_warn_sent[0] != today:
        _last_dd_warn_sent[0] = today
        dd_usd = current_equity_usd - day_start_usd
        log_event("daily_dd_warning", daily_pct=daily_pct)
        tg_send(
            f"⚠️ <b>Daily Drawdown Warning</b>\n"
            f"Today: <b>{daily_pct:.2%}</b> (${dd_usd:+,.2f})\n"
            f"Daily-loss cap: -{MAX_DAILY_LOSS_PCT:.0%}. Buffer left: {(daily_pct + MAX_DAILY_LOSS_PCT):.2%}\n"
            f"Consider /pause if this gets worse.",
        )


def main_loop() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    # Connect with retry
    while not mt5_init_with_retry():
        log_event("initial_connect_retry", backoff_sec=RECONNECT_BACKOFF_SEC)
        time.sleep(RECONNECT_BACKOFF_SEC)

    mode = "MOCK" if MOCK_MODE else "LIVE (MT5)"
    tg_send(
        f"🤖 <b>FTMO Executor ONLINE</b> [{mode}]\n"
        f"Start balance: ${CHALLENGE_START_BALANCE:,.0f}\n"
        f"Daily-loss cap: -{MAX_DAILY_LOSS_PCT:.0%}\n"
        f"Total-loss cap: -{MAX_TOTAL_LOSS_PCT:.0%}\n"
        f"Poll interval: {POLL_INTERVAL_SEC}s"
    )
    log_event("executor_started", mode=mode, state_dir=str(STATE_DIR))

    try:
        while True:
            try:
                if not mt5_ensure_connected():
                    continue
                handle_kill_request()
                sync_account_state()

                # Sample equity history for dashboard charts
                acct = mt5_get_equity()
                if acct["equity"] is not None:
                    sample_equity_history(acct["equity"])
                    day_start_usd = read_json(DAILY_STATE_PATH, {}).get("equity_at_day_start_usd", acct["equity"])
                    check_daily_dd_warning(acct["equity"], day_start_usd)

                # Circuit breaker (may trip → set paused)
                check_circuit_breaker()

                if is_paused():
                    # Paused: skip placing new orders but still manage open positions
                    manage_open_positions()
                else:
                    process_pending_signals()
                    manage_open_positions()
            except Exception as e:
                log_event("loop_error", error=str(e))
                tg_send(f"⚠️ <b>Executor Loop Error</b>\n<code>{html_escape(str(e))}</code>")
            time.sleep(POLL_INTERVAL_SEC)
    except KeyboardInterrupt:
        log_event("executor_stopped", reason="keyboard_interrupt")
        tg_send("🛑 <b>Executor Stopped</b> (Ctrl+C)")
    finally:
        try:
            mt5.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    main_loop()
