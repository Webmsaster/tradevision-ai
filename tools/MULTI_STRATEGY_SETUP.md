# Multi-Strategy 3-Account Setup — ~94% min-1-pass

The single-account ceiling for R28_V6_PASSLOCK is **63.24%** full-sweep / **64.77%** preliminary (V4-Engine, 5.55y, sharded — Round 60 champion). Baseline R28_V6 (no PASSLOCK) is **56.62%**. To push pass-rate to 90%+, run **3 different strategies** on 3 separate FTMO accounts.

## Math (uncorrelated assumption)

| Strategy        | Pass-Rate | Fail-Rate | Source                           |
| --------------- | --------: | --------: | -------------------------------- |
| R28_V6_PASSLOCK |    63.24% |    36.76% | 9 cryptos, 5.55y, V4-Engine, R60 |
| V5_TITANIUM     |    58.24% |    41.76% | 14 cryptos, 5.52y, step=1d       |
| V5_AMBER        |    62.83% |    37.17% | 14 cryptos, 3.04y, best step=1d  |

**min-1-pass** = `1 - (1 - 0.6324) × (1 - 0.5824) × (1 - 0.6283)` ≈ **94.3%**

vs alternatives:

- `1× R28_V6_PASSLOCK`: 63.24% (single)
- `2× R28_V6_PASSLOCK`: 86.48% (correlated — both fail when crypto crashes)
- `3× R28_V6_PASSLOCK`: 95.03% (still correlated)
- **`R28_V6_PASSLOCK + TITANIUM + AMBER`: ~94.3%** (uncorrelated → robust)

> Note: baseline R28_V6 numbers (56.62% / 81.18% / 91.79%) are kept in older sections of this doc for historical reference — the Round 60 champion is PASSLOCK.

The decorrelation comes from:

- Different asset baskets (R28_V6: 9 cryptos / TITANIUM: 14 / AMBER: 14 minus different)
- Different TP/SL profiles (R28_V6 ×0.55 tight TPs vs TITANIUM/AMBER baseline)
- Different lookback periods (3-5y validation)

## Setup steps

### 1. Acquire 3 FTMO accounts

- Either 3× FTMO Demo (free) or 3× Funded ($330+ each)
- Each must have unique MT5 login + password
- Recommended: start with 3× Demo for 1 week stability, then promote winners to Funded

### 2. Copy env templates

```bash
cd /path/to/tradevision-ai
cp .env.ftmo.demo1.example .env.ftmo.demo1
cp .env.ftmo.titanium.example .env.ftmo.titanium
cp .env.ftmo.amber.example .env.ftmo.amber
```

### 3. Fill placeholders in each `.env.ftmo.*`

Required per-file:

- `FTMO_EXPECTED_LOGIN=<MT5-login-number>` — different per account
- `TELEGRAM_BOT_TOKEN_<account_id>=<bot-token>` — same bot, different env-var key
- `TELEGRAM_CHAT_ID_<account_id>=<chat-id>` — usually same chat for all 3

**Critical:** `FTMO_TELEGRAM_BOT_MASTER=1` must be set in **.env.ftmo.demo1 ONLY**. The other two send-only.

### 4. Verify each MT5 instance running

- 3 separate MT5 windows, each logged into a different FTMO account
- Each MT5 must show "Connected" status

### 5. Pre-flight check per account

```bash
(set -a; . .env.ftmo.demo1; set +a; python tools/preflight_check.py)
(set -a; . .env.ftmo.titanium; set +a; python tools/preflight_check.py)
(set -a; . .env.ftmo.amber; set +a; python tools/preflight_check.py)
```

All 3 must return `GO`. Fix any `NO-GO` before proceeding.

### 6. Launch via start-3-strategy.sh

```bash
bash tools/start-3-strategy.sh
```

Script:

- Verifies all 3 env files exist + filled
- Verifies exactly 1 master Telegram listener
- Runs preflight per account
- Starts 3 PM2 processes (`ftmo-r28-v6`, `ftmo-titanium`, `ftmo-amber`)
- Each gets its own state-dir + Telegram tag

### 7. Monitor

- 3 separate drift dashboards (different `ftmo_tf` query)
- Telegram alerts prefixed `[acct:demo1]`, `[acct:titanium]`, `[acct:amber]`
- `pm2 logs --lines 50` to see all 3 streams

## Promotion rule (Demo → Funded)

After **1 week of stable Demo running** with no crashes, no Telegram-401/404, no expected-login mismatches:

1. Stop the matching Demo via `pm2 stop ftmo-r28-v6`
2. Edit the matching `.env.ftmo.<id>` with new MT5 login (Funded)
3. `pm2 start ecosystem.config.js --name ftmo-r28-v6 -- --env-from-file .env.ftmo.demo1`

Promote one account at a time, leave the other 2 on Demo as observability backstop.

## Risk per account

Per FTMO 2-Step rules:

- Daily loss: 5% (Step 1) / 5% (Step 2)
- Total loss: 10% (Step 1) / 10% (Step 2)
- Profit target: 8% (Step 1) / 5% (Step 2)
- Min trading days: 4

R28_V6 + TITANIUM + AMBER all default-configured to these limits. Engine has `liveCaps {maxStopPct: 0.05, maxRiskFrac: 0.4}` to enforce.

## Known caveats

- **3 MT5 instances on 1 VPS:** ~2GB RAM each, plus Node executor. Use a 4GB+ VPS minimum.
- **Telegram master listener:** if `ftmo-r28-v6` crashes, manual `/start` commands won't reach the bot. Restart immediately via `pm2 restart ftmo-r28-v6`.
- **Live drift expectation:** -3pp to -5pp per account vs backtest pass-rate (slippage, MT5 latency). Real-world 93% min-1-pass might land at ~88-90%.
- **Cost discipline:** if all 3 fail Step 1 simultaneously, that's 3× registration fee burned. Use Demo for confidence-building before Funded.
