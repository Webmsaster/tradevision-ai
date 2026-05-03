# R28_V6 FTMO Bot — 1-Page Cheat Sheet

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
FTMO_TF=2h-trend-v5-quartz-lite-r28-v6-v4engine
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
Drift Dashboard:  http://<vps-ip>:3000/dashboard/drift?ftmo_tf=2h-trend-v5-quartz-lite-r28-v6-v4engine-demo1
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

## 🎯 Erwartete Pass-Rate (honest)

- Single-Account Live: **~50-55%** (Backtest 56.62%, drift -3-7pp)
- 2× Multi-Account: **~80% min-1-pass**
- 3× Multi-Account: **~92%**
- Median Pass-Day: **4 Tage** (FTMO floor)

## 🔄 Multi-Account Setup

```powershell
# Demo 2 dazu (NACH 1 Woche Demo 1 stable):
copy .env.ftmo.demo2.example .env.ftmo.demo2
# .env.ftmo.demo2 anpassen (anderer FTMO_EXPECTED_LOGIN, KEIN MASTER flag)
pm2 start ecosystem.config.js --name ftmo-executor-demo2 --env-from-file .env.ftmo.demo2
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
│   └── ecosystem.config.js                ← PM2 config
├── ftmo-state-2h-trend-v5-quartz-lite-r28-v6-v4engine-demo1\
│   ├── account.json                       ← live equity
│   ├── executor-log.jsonl                 ← all events
│   └── ...
```

## 💸 ROI Quick Math (post-R58 honest)

| Demos  |     Cost |   Pass% |  EV/Demo |
| ------ | -------: | ------: | -------: |
| 1×     |     155€ |     55% |     -28€ |
| **2×** | **310€** | **80%** | **+96€** |
| 3×     |     465€ |     92% |    +205€ |

**Sweet spot: 2× Multi-Account** — first profitable konfiguration.

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
