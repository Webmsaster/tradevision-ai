#!/usr/bin/env python3
"""Generate PNG charts comparing worst-fail vs best-pass windows.
BTC 2h price + signal entry markers, side-by-side.
"""
import sys
sys.path.insert(0, '/home/flooe/.local/lib/python3.12/site-packages')

import json
from collections import defaultdict
from pathlib import Path
from datetime import datetime, timezone

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

CACHE = Path(__file__).resolve().parent / "cache_bakeoff"


def load_btc():
    with (CACHE / "BTCUSDT_2h.json").open() as f:
        return sorted(json.load(f), key=lambda c: c["openTime"])


def load_windows_trades():
    windows = {}
    with (CACHE / "cluster_audit/champion.jsonl").open() as f:
        for line in f:
            r = json.loads(line)
            windows[r["win_idx"]] = r
    trades = defaultdict(list)
    with (CACHE / "cluster_audit/champion_trades.jsonl").open() as f:
        for line in f:
            r = json.loads(line)
            trades[r["winIdx"]].append(r)
    for k in trades:
        trades[k].sort(key=lambda t: t["entryTime"])
    return windows, trades


def plot_window(ax, btc, trades_in_w, w_data, label):
    if not trades_in_w:
        ax.set_title(f"{label}: NO TRADES")
        return
    t_start = trades_in_w[0]["entryTime"]
    t_end = max(t["exitTime"] for t in trades_in_w) + 4 * 3_600_000
    t_pre = t_start - 7 * 24 * 3_600_000

    bars = [c for c in btc if t_pre <= c["openTime"] <= t_end]
    if len(bars) < 5:
        ax.set_title(f"{label}: insufficient bars")
        return
    xs = [datetime.fromtimestamp(c["openTime"]/1000, tz=timezone.utc) for c in bars]
    closes = [c["close"] for c in bars]
    highs = [c["high"] for c in bars]
    lows = [c["low"] for c in bars]

    ax.plot(xs, closes, color='black', linewidth=0.7)
    ax.fill_between(xs, lows, highs, alpha=0.15, color='gray')

    # Mark challenge start
    t_start_dt = datetime.fromtimestamp(t_start/1000, tz=timezone.utc)
    ax.axvline(t_start_dt, color='blue', linestyle='--', alpha=0.7, label='challenge start')

    # Mark entries (long=green, short=red)
    long_xs = []; long_ys = []; short_xs = []; short_ys = []
    win_xs = []; win_ys = []; lose_xs = []; lose_ys = []
    for t in trades_in_w:
        et = datetime.fromtimestamp(t["entryTime"]/1000, tz=timezone.utc)
        # Map entry to closest BTC close price for visual reference
        bar = min(bars, key=lambda c: abs(c["openTime"] - t["entryTime"]))
        y = bar["close"]
        if t["direction"] == "long":
            long_xs.append(et); long_ys.append(y)
        else:
            short_xs.append(et); short_ys.append(y)
        # Mark win/loss
        if t.get("effPnl", 0) > 0:
            win_xs.append(et); win_ys.append(y)
        else:
            lose_xs.append(et); lose_ys.append(y)

    ax.scatter(long_xs, long_ys, marker='^', color='green', s=30, alpha=0.7, label='long entry')
    ax.scatter(short_xs, short_ys, marker='v', color='red', s=30, alpha=0.7, label='short entry')
    ax.scatter(win_xs, win_ys, marker='o', color='lime', s=10, alpha=0.4)
    ax.scatter(lose_xs, lose_ys, marker='x', color='red', s=20, alpha=0.5)

    passed = w_data['passed']
    fail_reason = w_data.get('fail_reason', '')
    eq = w_data['final_equity_pct'] * 100
    n_t = len(trades_in_w)
    b = w_data.get('first_cluster_size', 0)
    m = w_data.get('first_cluster_majors', 0)
    status = "✓ PASS" if passed else f"✗ FAIL ({fail_reason})"
    ax.set_title(f"{label} — win={w_data['win_idx']} {status} eq={eq:+.1f}% trades={n_t} b/m={b}/{m}", fontsize=9)
    ax.legend(loc='upper left', fontsize=7)
    ax.grid(True, alpha=0.3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d'))
    plt.setp(ax.xaxis.get_majorticklabels(), rotation=30, fontsize=7)


def main():
    btc = load_btc()
    windows, trades_by_w = load_windows_trades()

    # Pick 3 worst fails (lowest final equity) + 3 best passes (highest final equity)
    wins = list(windows.values())
    qual_fails = sorted([w for w in wins if w.get('qualified_at_start') and not w['passed']],
                        key=lambda w: w['final_equity_pct'])[:3]
    qual_passes = sorted([w for w in wins if w.get('qualified_at_start') and w['passed']],
                         key=lambda w: -w['final_equity_pct'])[:3]
    unq_fails = sorted([w for w in wins if not w.get('qualified_at_start') and not w['passed']],
                       key=lambda w: w['final_equity_pct'])[:3]

    fig, axes = plt.subplots(3, 3, figsize=(20, 12))

    # Row 1: 3 worst QUAL-fail
    for ax, w in zip(axes[0], qual_fails):
        plot_window(ax, btc, trades_by_w[w['win_idx']], w, "QUAL-FAIL")

    # Row 2: 3 best QUAL-pass
    for ax, w in zip(axes[1], qual_passes):
        plot_window(ax, btc, trades_by_w[w['win_idx']], w, "QUAL-PASS")

    # Row 3: 3 worst UNQ-fail (typical chop windows)
    for ax, w in zip(axes[2], unq_fails):
        plot_window(ax, btc, trades_by_w[w['win_idx']], w, "UNQ-FAIL")

    plt.suptitle("BTC 2h — Window comparison: top fails vs top passes\n"
                 "Blue dashed = challenge start | green ^ = long entry | red v = short entry "
                 "| o = win | x = loss", fontsize=11)
    plt.tight_layout(rect=[0, 0, 1, 0.96])
    out = CACHE / "cluster_audit/visual_chart_comparison.png"
    plt.savefig(out, dpi=110, bbox_inches='tight')
    print(f"Saved: {out}")


if __name__ == "__main__":
    main()
