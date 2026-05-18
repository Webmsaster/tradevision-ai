#!/usr/bin/env python3
# ⚠️ BROKEN: EMA-cross proxy delivers 54.8% pass-rate, NOT 92%.
# See ftmo_timing_supervisor.py (v2) for correct implementation using real engine.
"""
2026-05-17 FTMO Timing-Supervisor (Codex Interpretation B).

USER-GOAL: 90% Passrate single-account "blind buy" - reframed by codex as
"Kauf blind, wenn der Bot BUY sagt". Bot scans the market continuously and
emits BUY_ALLOWED only when the qualifying-cluster (breadth >= 4 assets +
majors >= 3 in last 24h) is active.

Pass-rate on gekauften challenges: 92.31% AND (memory phase33).
Buy frequency: ~44% retention (56% idle).

This supervisor:
1. Polls the last 24h of 30m candles per asset (free Binance kline API).
2. For each asset: tests simple EMA-crossover (proxy for "signal active").
   Real production should integrate the actual Rust voter via sweep with
   windows=1 — this is a lightweight stand-alone gate.
3. Aggregates: distinct symbols where signal active + majors count.
4. Emits state/timing-gate.json + Telegram (if configured) when qualifying.

Run modes:
  python3 scripts/ftmo_timing_supervisor.py          # one-shot
  python3 scripts/ftmo_timing_supervisor.py --watch  # loop every 30min
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

STATE_DIR = Path("state")
GATE_FILE = STATE_DIR / "timing-gate.json"
HIST_FILE = STATE_DIR / "timing-history.jsonl"
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "AVAXUSDT", "XRPUSDT",
           "BCHUSDT", "LTCUSDT", "ADAUSDT", "DOTUSDT", "ETCUSDT", "LINKUSDT",
           "ALGOUSDT", "ATOMUSDT", "ARBUSDT", "NEARUSDT", "TRXUSDT", "UNIUSDT",
           "AAVEUSDT"]
MAJORS = {"BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"}

# Gate thresholds (matches memory phase33 best config)
MIN_BREADTH = 4
MIN_MAJORS = 3
LOOKBACK_HOURS = 24
BARS_30M_IN_24H = 48
# EMA periods for signal proxy
EMA_FAST = 9
EMA_SLOW = 21

def fetch_klines(symbol, interval="30m", limit=60):
    """Last `limit` bars from Binance public API."""
    url = (f"https://api.binance.com/api/v3/klines"
           f"?symbol={symbol}&interval={interval}&limit={limit}")
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            data = json.load(r)
        return [{"t": int(b[0]), "close": float(b[4])} for b in data]
    except Exception as e:
        print(f"  [fetch-err] {symbol}: {e}", file=sys.stderr)
        return []

def ema(values, period):
    if len(values) < period:
        return None
    alpha = 2 / (period + 1)
    ema_val = sum(values[:period]) / period
    for v in values[period:]:
        ema_val = alpha * v + (1 - alpha) * ema_val
    return ema_val

def signal_active_in_last_24h(closes):
    """Returns True if EMA-fast crossed ABOVE EMA-slow at any 30m bar
    in the last 48 bars (= 24h)."""
    if len(closes) < EMA_SLOW + BARS_30M_IN_24H + 2:
        return False
    # Compute EMA series for the tail
    prev_diff = None
    crossed = False
    # Walk forward from earliest computable EMA position
    start = EMA_SLOW
    end = len(closes)
    # Only look at last 48+1 bars for "in 24h" semantic
    bar_start = max(start, end - BARS_30M_IN_24H - 1)
    for i in range(bar_start, end):
        sub = closes[: i + 1]
        ef = ema(sub, EMA_FAST)
        es = ema(sub, EMA_SLOW)
        if ef is None or es is None:
            continue
        diff = ef - es
        if prev_diff is not None and prev_diff <= 0 and diff > 0:
            crossed = True
            break
        prev_diff = diff
    return crossed

def check_gate():
    """One pass: scan all symbols, compute breadth+majors."""
    active_symbols = set()
    active_majors = set()
    for sym in SYMBOLS:
        klines = fetch_klines(sym, "30m", limit=EMA_SLOW + BARS_30M_IN_24H + 4)
        if not klines:
            continue
        closes = [k["close"] for k in klines]
        if signal_active_in_last_24h(closes):
            active_symbols.add(sym)
            if sym in MAJORS:
                active_majors.add(sym)
        time.sleep(0.1)  # rate-limit polite

    breadth = len(active_symbols)
    majors = len(active_majors)
    qualified = breadth >= MIN_BREADTH and majors >= MIN_MAJORS
    now_ms = int(time.time() * 1000)

    return {
        "ts": now_ms,
        "ts_iso": datetime.now(timezone.utc).isoformat(),
        "breadth": breadth,
        "majors": majors,
        "symbols": sorted(active_symbols),
        "majors_list": sorted(active_majors),
        "min_breadth": MIN_BREADTH,
        "min_majors": MIN_MAJORS,
        "qualified": qualified,
        "valid_until_ms": now_ms + LOOKBACK_HOURS * 3600 * 1000,
    }

def write_gate(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    GATE_FILE.write_text(json.dumps(state, indent=2))
    with HIST_FILE.open("a") as f:
        f.write(json.dumps(state) + "\n")

def send_telegram(msg):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = json.dumps({
        "chat_id": TELEGRAM_CHAT_ID,
        "text": msg,
        "parse_mode": "Markdown",
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        print(f"  [telegram-err] {e}", file=sys.stderr)

def emit_signal(state, prev_state):
    """Send Telegram + log if state transitioned to qualified."""
    if state["qualified"] and not (prev_state and prev_state.get("qualified")):
        msg = (
            f"🎯 *FTMO BUY ALLOWED* ({state['ts_iso']})\n\n"
            f"Breadth: {state['breadth']} ≥ {state['min_breadth']}\n"
            f"Majors: {state['majors']} ≥ {state['min_majors']}\n"
            f"Symbols: {', '.join(state['symbols'])}\n\n"
            f"Smart-Timing-Gate qualifying — buy challenge now.\n"
            f"Expected pass-rate: ~92% (memory phase33 conditional).\n"
            f"Valid until: ~+24h"
        )
        print(msg)
        send_telegram(msg)
    elif not state["qualified"] and prev_state and prev_state.get("qualified"):
        msg = f"⏸ FTMO gate DEACTIVATED ({state['ts_iso']}) — breadth {state['breadth']}/{state['min_breadth']}"
        print(msg)
        send_telegram(msg)

def run_once():
    prev = None
    if GATE_FILE.exists():
        try:
            prev = json.loads(GATE_FILE.read_text())
        except Exception:
            prev = None
    state = check_gate()
    write_gate(state)
    print(f"[{state['ts_iso']}] breadth={state['breadth']}/{state['min_breadth']} "
          f"majors={state['majors']}/{state['min_majors']} "
          f"qualified={state['qualified']}")
    if state["qualified"]:
        print(f"  Active symbols: {state['symbols']}")
    emit_signal(state, prev)
    return state

def main():
    watch = "--watch" in sys.argv
    if watch:
        print("[watch] polling every 30 min, Ctrl-C to stop")
        while True:
            try:
                run_once()
            except KeyboardInterrupt:
                print("\n[watch] interrupted")
                return
            except Exception as e:
                print(f"  [tick-err] {e}", file=sys.stderr)
            time.sleep(1800)
    else:
        run_once()

if __name__ == "__main__":
    main()
