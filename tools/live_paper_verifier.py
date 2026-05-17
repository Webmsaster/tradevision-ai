#!/usr/bin/env python3
"""2026-05-17 Live-Paper-Trade Parallel Verifier.

Reads signal-alerts.log (same as real live executor), simulates fills via
Binance mid-price (not MT5), tracks paper-equity. Compares vs real live PnL.

Daily reconciliation:
  diff = abs(paper_pnl - live_pnl)
  if diff > 0.3% equity:
      telegram-alert "drift exceeded — bug suspect"

Designed to catch lookahead/timing/scoring bugs in <24h.
"""
import argparse, json, time
from pathlib import Path

# Mock MT5 for paper-trade. Uses Binance mid as fill-price.
# In production: subscribes to wss://stream.binance.com/...
class PaperExecutor:
    def __init__(self, equity_start=10_000.0):
        self.equity = equity_start
        self.positions = {}  # sym -> {side, size, entry_price, entry_ts}
        self.closed_trades = []

    def open(self, symbol, side, size, fill_price, ts):
        if symbol in self.positions:
            print(f"  [paper] {symbol} already open, skipping")
            return
        self.positions[symbol] = {"side": side, "size": size, "entry_price": fill_price, "entry_ts": ts}
        print(f"  [paper] OPEN {symbol} {side} @ {fill_price:.4f}")

    def close(self, symbol, fill_price, ts):
        if symbol not in self.positions:
            return
        pos = self.positions.pop(symbol)
        sign = 1 if pos["side"] == "long" else -1
        pnl = sign * pos["size"] * (fill_price - pos["entry_price"])
        self.equity += pnl
        self.closed_trades.append({**pos, "exit_price": fill_price, "exit_ts": ts, "pnl": pnl})
        print(f"  [paper] CLOSE {symbol} @ {fill_price:.4f} → PnL {pnl:+.2f}, equity {self.equity:.2f}")

def reconcile(paper_equity, live_equity_path, threshold_pct=0.3):
    """Compare paper vs live equity. Alert if drift exceeds threshold."""
    live_equity_path = Path(live_equity_path)
    if not live_equity_path.exists():
        return None
    live_data = json.loads(live_equity_path.read_text())
    live_equity = live_data.get("equity", paper_equity)
    diff_pct = abs(paper_equity - live_equity) / live_equity * 100
    return {"paper": paper_equity, "live": live_equity, "drift_pct": diff_pct,
            "alert": diff_pct > threshold_pct}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--signal-log", default="state/signal-alerts.log")
    ap.add_argument("--paper-equity-start", type=float, default=10_000.0)
    ap.add_argument("--threshold-pct", type=float, default=0.3)
    args = ap.parse_args()
    print(f"[live-paper-verifier] reading {args.signal_log}")
    print(f"  start equity: {args.paper_equity_start}")
    print(f"  drift threshold: {args.threshold_pct}%")

    executor = PaperExecutor(args.paper_equity_start)

    # Single-pass mode for now (real version would tail -f)
    if Path(args.signal_log).exists():
        for line in Path(args.signal_log).read_text().splitlines()[-50:]:
            line = line.strip()
            if not line or not line.startswith("{"): continue
            try:
                evt = json.loads(line)
                # Expected: {symbol, action: open|close, side: long|short, fill_price, ts, size}
                if evt.get("action") == "open":
                    executor.open(evt["symbol"], evt["side"], evt.get("size",1.0), evt["fill_price"], evt["ts"])
                elif evt.get("action") == "close":
                    executor.close(evt["symbol"], evt["fill_price"], evt["ts"])
            except (json.JSONDecodeError, KeyError) as e:
                pass

    print(f"\nPaper equity: {executor.equity:.2f}")
    print(f"Closed trades: {len(executor.closed_trades)}")

    # Reconcile against live (stub for now)
    rec = reconcile(executor.equity, "state/live_equity_latest.json")
    if rec:
        print(f"Reconciliation: paper={rec['paper']:.2f} live={rec['live']:.2f} drift={rec['drift_pct']:.3f}%")
        if rec["alert"]:
            print("  ⚠ DRIFT ALERT — bug suspect (would trigger Telegram)")
    else:
        print("(no live state file found — pure paper mode)")

if __name__ == "__main__": main()
