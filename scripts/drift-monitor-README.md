# Live-vs-Backtest Drift Monitor

Daily measurement of how the live FTMO bot performs vs the backtest expectation.
Surfaces slippage, spread cost, and per-asset realised-vs-expected drift so
you know when broker conditions shift, signals decay, or news-blackout
windows need tuning.

## Anatomy

```
                                       ┌─────────────────────────┐
   FTMO MT5 ──fills──▶ ftmo_executor ──▶ executor-log.jsonl       │
                              │           (order_placed / closed) │
                              │           with signal_entry,      │
                              │           actual_fill, slippage_bps│
                              ▼                                    │
                        signals_log                                │
                                                                   │
                                          ┌──────────────────────┐ │
   cron 23:17 UTC ──▶ driftTelegram.ts  ──▶ driftMonitor.ts ◀────┘
                              │                  │
                              │                  ▼
                              │             Markdown report
                              ▼
                        Telegram bot
                        (HTML chunks)
```

## Files

- `tools/ftmo_executor.py` — extended `order_placed` and `closed` events
  with `signal_entry`, `slippage_bps`, `spread_pts`, `planned_exit`,
  `exit_reason`. **No new dependencies; backwards-compatible** with older
  log lines that don't have these fields.
- `scripts/driftMonitor.ts` — joins events on `ticket`, builds the report
  (Markdown). Reads `--state-dir`, optional `--days`, `--out`.
- `scripts/driftTelegram.ts` — wraps driftMonitor + posts to Telegram.
  Auto-routes per-account env vars (`TELEGRAM_BOT_TOKEN_<ACCOUNT_ID>`).

## Quick start

```bash
# One-shot manual run, prints to stdout
FTMO_STATE_DIR=ftmo-state-2h-trend-v5-r28-v6-passlock-demo1 \
  npx tsx scripts/driftMonitor.ts --days 7

# With Telegram (token+chat must be set; per-account env optional)
FTMO_STATE_DIR=ftmo-state-2h-trend-v5-r28-v6-passlock-demo1 \
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy \
  npx tsx scripts/driftTelegram.ts
```

## VPS cron setup (Linux)

```bash
# /etc/cron.d/ftmo-drift  (UTC)
17 23 * * * flooe cd /opt/ftmo && \
  FTMO_STATE_DIR=ftmo-state-2h-trend-v5-r28-v6-passlock-demo1 \
  TELEGRAM_BOT_TOKEN_DEMO1="$DEMO1_BOT_TOKEN" \
  TELEGRAM_CHAT_ID_DEMO1="$DEMO1_CHAT_ID" \
  FTMO_ACCOUNT_ID=DEMO1 \
  /opt/ftmo/node_modules/tsx/dist/cli.mjs scripts/driftTelegram.ts
```

For multi-account, repeat the cron line with different account IDs and
state dirs.

## Windows VPS (Task Scheduler)

```powershell
schtasks /create /tn "ftmo-drift-daily" `
  /tr "node C:\opt\ftmo\node_modules\tsx\dist\cli.mjs C:\opt\ftmo\scripts\driftTelegram.ts" `
  /sc daily /st 23:17 /f
```

(set env vars via `[System.Environment]::SetEnvironmentVariable` ahead of
time so the scheduled task inherits them).

## Report shape

Aggregate section gives the headline metric: **drift in pp**. If realised
average return is below expected by more than 1pp, the report flags it as
🚨. Per-asset breakdown shows _which_ assets are responsible — typically
high-spread or low-liquidity tokens are the worst.

The slippage health section reports median entry / exit slippage in basis
points. Targets:

| Metric            | Healthy  | Investigate                                |
| ----------------- | -------- | ------------------------------------------ |
| Entry slip median | ≤ 5 bps  | > 5 bps                                    |
| Exit slip median  | ≤ 10 bps | > 10 bps (stop-out drift, broker LP issue) |
| Drift vs expected | ±1pp     | < -1pp                                     |

## Operational tips

- **Run AFTER market quiet hours** (cron at 23:17 UTC = post-NY-close,
  before Asia-open) so the report covers a full day's trades.
- **Set `DRIFT_DAYS=7`** for daily summaries; longer windows smooth out
  noise but mask sudden regime changes.
- **Per-account routing** keeps reports isolated — multi-account ops
  shouldn't see each other's data.
