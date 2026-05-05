# R28_V6_PASSLOCK FTMO Bot — 1-Page Cheat Sheet

## 🏆 Round 60 Champion (2026-05-04)

**R28_V6_PASSLOCK = 63.24% V4-Engine pass-rate full-sweep** (preliminary 64.77% on 86/136 windows, +6.62 to +8.15pp vs R28_V6 baseline 56.62%)

- Mechanism: `closeAllOnTargetReached` lockt mtm-equity bei first target-hit
- Eliminiert Day-30-force-close Drag-Down (give_back 0%, total_loss unchanged)
- Live erwartet: ~60% single-account, ~94% min-1-pass mit 3-Strategy
- Live-Selector: `FTMO_TF=2h-trend-v5-r28-v6-passlock`

## 🚀 Deploy in 5 Befehlen

```powershell
# Auf VPS:
git clone https://github.com/Webmsaster/tradevision-ai.git C:\tradevision-ai
cd C:\tradevision-ai && npm install && pip install -r tools/requirements.txt
copy .env.ftmo.demo1.example .env.ftmo
notepad .env.ftmo                                          # ← Login + Tokens
python tools/preflight_check.py && pm2 start ecosystem.config.js
```

## 🔑 .env.ftmo Essentials

```bash
FTMO_TF=2h-trend-v5-r28-v6-passlock                  # ← R60 Champion (was: r28-v6-v4engine)
FTMO_ACCOUNT_ID=demo1
FTMO_EXPECTED_LOGIN=<MT5-Login-Zahl>
FTMO_START_BALANCE=100000
TELEGRAM_BOT_TOKEN_demo1=<Bot-Token>
TELEGRAM_CHAT_ID_demo1=<Chat-ID>
FTMO_TELEGRAM_BOT_MASTER=1
REGIME_GATE_ENABLED=true
REGIME_GATE_BLOCK=trend-down
SLIPPAGE_ENTRY_SPREADS=1.5
SLIPPAGE_STOP_SPREADS=3.0
FTMO_MONITOR_ENABLED=1
```

## 📱 Telegram Commands

| Command   | Effect                                                |
| --------- | ----------------------------------------------------- |
| `/status` | Account + offene Positionen                           |
| `/pause`  | Stoppt neue Trades                                    |
| `/resume` | Bot aktiv                                             |
| `/kill`   | 🚨 NOTBREMSE: alle Positionen schließen + Bot stoppen |

## 📊 Monitoring URLs

```
Drift Dashboard:  http://<vps-ip>:3000/dashboard/drift?ftmo_tf=2h-trend-v5-r28-v6-passlock-demo1
PM2 Logs:         pm2 logs ftmo-executor
Health Check:     python tools/preflight_check.py
```

## 🩺 Quick Diagnostics

| Symptom          | Check                             | Fix                               |
| ---------------- | --------------------------------- | --------------------------------- |
| Bot crashes      | `pm2 logs --err`                  | Restart `pm2 restart all`         |
| Keine Trades 24h | `executor-log.jsonl` regime_gate? | Markt in trend-down → warten      |
| Telegram silent  | Token + Chat-ID                   | `python tools/preflight_check.py` |
| MT5 disconnect   | MT5 Terminal                      | Re-login auf VPS                  |
| Stale signals    | `pending-signals.json`            | Delete + restart                  |

## 🎯 Erwartete Pass-Rate (R28_V6_PASSLOCK)

- Single-Account Live: **~60%** (Backtest 63.24% honest / 64.77% preliminary, drift -3-5pp)
- 2× PASSLOCK: **~84% min-1-pass**
- 3× PASSLOCK: **~93%**
- **3-Strategy (PASSLOCK + TITANIUM + AMBER): ~94% min-1-pass** ⭐ (uncorrelated)
- Median Pass-Day: **4 Tage** (FTMO floor)

## 🔄 Multi-Account Setup (3-Strategy ~94%)

```powershell
# 3 verschiedene Strategien für maximale Decorrelation:
copy .env.ftmo.demo1.example     .env.ftmo.demo1       # R28_V6_PASSLOCK
copy .env.ftmo.titanium.example  .env.ftmo.titanium    # V5_TITANIUM
copy .env.ftmo.amber.example     .env.ftmo.amber       # V5_AMBER

# Anpassen + Launch:
bash tools/start-3-strategy.sh

# Setup-Anleitung: tools/MULTI_STRATEGY_SETUP.md
```

## 🆘 Notbremse

```powershell
# Telegram: /kill                    (recommended — schließt offene Positionen)
# Oder lokal:
pm2 stop all
# Manuell offene Positionen in MT5 schließen
```

## 📦 Was wo ist

```
C:\tradevision-ai\
├── .env.ftmo                              ← deine credentials (gitignored)
├── tools\
│   ├── PRE_LIVE_SETUP.md                  ← komplettes 11-step Guide
│   ├── preflight_check.py                 ← GO/NO-GO check
│   ├── health_monitor.py                  ← cron watchdog (alle 15min)
│   ├── ftmo_executor.py                   ← Python MT5 executor
│   ├── ecosystem.config.js                ← PM2 single-account config
│   ├── ecosystem-multi.config.js          ← PM2 3-strategy multi-account
│   ├── start-3-strategy.sh                ← Multi-Account launcher
│   ├── MULTI_STRATEGY_SETUP.md            ← Multi-Account anleitung
│   └── PASSLOCK_DEPLOY_RUNBOOK.md         ← Live-Deploy step-by-step
├── ftmo-state-2h-trend-v5-r28-v6-passlock-demo1\
│   ├── account.json                       ← live equity
│   ├── executor-log.jsonl                 ← all events
│   └── ...
```

## 💸 ROI Quick Math (R28_V6_PASSLOCK post-R60)

| Setup                   |     Cost |    Pass% |           EV |
| ----------------------- | -------: | -------: | -----------: |
| 1× PASSLOCK             |     155€ |      60% |         +25€ |
| **2× PASSLOCK**         | **310€** |  **84%** |    **+225€** |
| 3× PASSLOCK             |     465€ |      93% |        +395€ |
| **3-Strategy (uncorr)** | **465€** | **~94%** | **+410€** ⭐ |

**Sweet spot: 3-Strategy** — gleiches Geld, +1pp aber dramatisch dekorreliert (1 Crypto-Crash killt nicht alle 3 Accounts).

## ⏱️ Tag-für-Tag Erwartung

| Tag  | Was passiert                                             |
| ---- | -------------------------------------------------------- |
| 1-3  | 0-3 Trades pro Tag, langsam Equity-Aufbau                |
| 4    | ~50% chance Target hit (≥8%), Bot pausiert + ping-trades |
| 5-30 | Bot wartet, ping-trades um minTradingDays=4 zu erfüllen  |
| Pass | Telegram "✅ CHALLENGE PASSED"                           |

## ✅ Vor Live: 5 Checks

1. ☐ `python tools/preflight_check.py` → GO
2. ☐ Drift Dashboard erreichbar (http://<ip>:3000/dashboard/drift?ftmo_tf=...)
3. ☐ Telegram `/status` antwortet
4. ☐ MT5 Terminal connected, $100k Balance
5. ☐ State-dir leer / kein alter Bot-Stand

**Wenn alle 5 ✓ → `pm2 start ecosystem.config.js` → Markt-Iteration läuft.**
