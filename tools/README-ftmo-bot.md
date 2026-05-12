# FTMO Voll-Auto Bot — Setup Guide

> **🏆 CURRENT CHAMPION (Round 60, 2026-05-04): `R28_V6_PASSLOCK`**
> (`FTMO_TF=2h-trend-v5-r28-v6-passlock`). 63.24% V4-Engine pass-rate on
> 9-crypto basket / 5.55y / 136 windows. For live deploy use:
>
> - `tools/PASSLOCK_DEPLOY_RUNBOOK.md` (focused step-by-step)
> - `tools/PRE_LIVE_SETUP.md` (full 11-step guide)
> - `tools/CHEAT_SHEET.md` (1-page reference)
> - `tools/MULTI_STRATEGY_SETUP.md` (3-Strategy ~94% min-1-pass)
>
> The text below is the **historical iter231 setup** (4h ETH/BTC/SOL Mean-Reversion).
> Architecture & operational sections (PM2, Telegram, Drift Dashboard, Mock-Mode,
> Auto-Reconnect) still apply. Strategy/asset/timeframe specifics are superseded.

---

Strategie: iter231 (62.6% pass rate / 6d median unter realistischen FTMO-Kosten).
Assets: ETH + BTC + SOL auf 4h-Timeframe, Mean-Reversion-Shorts mit Pyramid + Kelly.

## Architektur

```
Binance API ──► Node Signal Service ──► state/pending-signals.json
                        ▲                         │
                        │                         ▼
            state/account.json        Python MT5 Executor
                        ▲                         │
                        └─ liest echte Equity ───┘
                                                  │
                                                  ▼
                                              FTMO MT5
```

## Voraussetzungen

### Hardware

- **Windows PC oder Windows-VPS**, 24/7 verfügbar
- Empfehlung: Contabo / Vultr / Hetzner Windows VPS (~€7-15/Monat)
- Mindestens 4GB RAM, stabile Internet-Verbindung

### Software

1. **MT5 Terminal** (von FTMO heruntergeladen)
2. **Python 3.10+** (https://python.org)
3. **Node.js 20+** (https://nodejs.org)
4. **Git** für Repo-Clone

### FTMO Account

1. FTMO Account mit aktivem Challenge-Zugang
2. **Wichtig**: MT5-Terminal muss mit FTMO-Challenge-Credentials eingeloggt sein
3. MT5-Terminal darf nicht zugemacht werden während der Bot läuft

## Installation

### 1. Repo clonen auf Windows

```powershell
cd C:\
git clone <dein-repo-url> tradevision-ai
cd tradevision-ai
npm install
```

### 2. Python-Dependencies

```powershell
pip install MetaTrader5
```

### 3. State-Verzeichnis erstellen

```powershell
mkdir C:\tradevision-ai\ftmo-state
```

### 4. FTMO MT5 Symbol-Namen prüfen

1. MT5 öffnen → Market Watch → Rechtsklick → "Symbols"
2. Suche nach "ETH", "BTC", "SOL" — notiere genaue Namen
3. FTMO Beispiele: `ETHUSD`, `BTCUSD`, `SOLUSD` (können variieren)

### 5. Environment setzen (`.env.ftmo`)

```
# FTMO Symbol-Namen (prüfen in MT5 Market Watch!)
FTMO_ETH_SYMBOL=ETHUSD
FTMO_BTC_SYMBOL=BTCUSD
FTMO_SOL_SYMBOL=SOLUSD

# Challenge-Konfiguration
FTMO_START_BALANCE=100000
FTMO_START_DATE=2026-04-23

# State-Verzeichnis (absolut!)
FTMO_STATE_DIR=C:\tradevision-ai\ftmo-state
```

## Starten

**Zwei Terminals öffnen — beide müssen 24/7 laufen:**

### Terminal A — Signal Service (Node)

```powershell
cd C:\tradevision-ai
$env:FTMO_STATE_DIR="C:\tradevision-ai\ftmo-state"
$env:FTMO_MONITOR_ENABLED="1"  # enable /ftmo-monitor dashboard locally
node ./node_modules/tsx/dist/cli.mjs scripts/ftmoLiveService.ts
```

**SECURITY NOTE:** `/ftmo-monitor` and `/api/ftmo-state` return **404** unless
`FTMO_MONITOR_ENABLED=1` is set. This prevents your personal trading data
(equity, positions, P&L) from leaking if the Next.js app is deployed publicly
(Vercel etc.). Only set the env var on your local/VPS box where the bot runs.

Läuft endlos, checkt alle 4h um 00:00:30, 04:00:30 usw. UTC.

### Terminal B — MT5 Executor (Python)

```powershell
cd C:\tradevision-ai
$env:FTMO_STATE_DIR="C:\tradevision-ai\ftmo-state"
$env:FTMO_ETH_SYMBOL="ETHUSD"
$env:FTMO_BTC_SYMBOL="BTCUSD"
$env:FTMO_SOL_SYMBOL="SOLUSD"
$env:FTMO_START_BALANCE="100000"
$env:FTMO_START_DATE="2026-04-23"
python tools\ftmo_executor.py
```

Pollt alle 30 Sekunden pending-signals.json, platziert Orders, schreibt account.json zurück.

## Monitoring

Alle Logs in `C:\tradevision-ai\ftmo-state\`:

| Datei                   | Zweck                                |
| ----------------------- | ------------------------------------ |
| `pending-signals.json`  | Neue Signale warten auf Execution    |
| `executed-signals.json` | History aller Executions + Fehler    |
| `account.json`          | Aktuelle Equity, Day, Recent-PnLs    |
| `open-positions.json`   | Live offene Positionen               |
| `signal-log.jsonl`      | Node Service Event-Log               |
| `executor-log.jsonl`    | Python Executor Event-Log            |
| `service-status.json`   | Node Service Heartbeat (jede Minute) |
| `last-check.json`       | Letzter Signal-Check Summary         |

**Live-Monitor:**

```powershell
# PowerShell live-tail
Get-Content ftmo-state\executor-log.jsonl -Wait -Tail 20
```

## Drift Dashboard (`/dashboard/drift`)

Real-time visualisation of **live equity vs the R28_V5 backtest expectation**.
Surfaces drift early so you can see whether the live bot is tracking,
overperforming or underperforming the simulated trajectory.

### Start

The dashboard is part of the Next.js app and is gated behind the same
`FTMO_MONITOR_ENABLED` flag as the legacy `/ftmo-monitor` page:

```powershell
# from the project root, with bot writing to ./ftmo-state*/
$env:FTMO_MONITOR_ENABLED="1"
$env:FTMO_START_BALANCE="100000"   # optional, default 100k
npm run dev
# → open http://localhost:3000/dashboard/drift
```

### Multi-account

If the bot writes to a TF-specific directory like
`ftmo-state-2h-trend-v5-quartz-lite-r28-v5-v4engine/`, point the dashboard
at it via the `?ftmo_tf=` query param:

```
http://localhost:3000/dashboard/drift?ftmo_tf=2h-trend-v5-quartz-lite-r28-v5-v4engine
```

The TF picker in the header auto-discovers all `ftmo-state-*/` directories
under the project root and lets you switch between them without editing the URL.

#### Running 2-3 demo accounts in parallel (Round 57)

Each account runs as its own executor process with isolated state and a
unique `FTMO_ACCOUNT_ID`. Three deployment-blockers were closed in Round 57:

**1. Per-account state isolation** (already in place — Phase 73 / Round 44):
`FTMO_ACCOUNT_ID=<id>` causes `STATE_DIR` to become
`ftmo-state-<TF>-<id>/` so two bots on the same TF never share files.

**2. Per-account Telegram routing** (Round 57): set `FTMO_ACCOUNT_ID` and
optionally provide independent bot/chat per account:

```powershell
# Account A (its own bot or shared bot, dedicated chat)
$env:FTMO_ACCOUNT_ID            = "demo_A"
$env:TELEGRAM_BOT_TOKEN_demo_A  = "1234:AAA..."     # optional
$env:TELEGRAM_CHAT_ID_demo_A    = "111111111"
$env:FTMO_TELEGRAM_BOT_MASTER   = "1"               # this account owns /pause /kill etc.

# Account B (shared bot, dedicated chat)
$env:FTMO_ACCOUNT_ID            = "demo_B"
$env:TELEGRAM_BOT_TOKEN         = "1234:AAA..."     # falls back to shared
$env:TELEGRAM_CHAT_ID_demo_B    = "222222222"
# DO NOT set FTMO_TELEGRAM_BOT_MASTER on B — only one account can own
# the long-poll loop or commands race between processes.
```

Resolution order for `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`:

1. `TELEGRAM_BOT_TOKEN_<FTMO_ACCOUNT_ID>` (sanitised — non-`[A-Za-z0-9_]` chars become `_`)
2. `TELEGRAM_BOT_TOKEN`

Outgoing alerts are auto-prefixed with `[acct:<id>] ` so a shared chat with
2-3 demos in it stays unambiguous.

**3. MT5 account verification** (Round 57): set `FTMO_EXPECTED_LOGIN=<int>`
on each process so the executor refuses to trade if it attaches to the wrong
MT5 terminal. Required when running multiple MT5 installs side-by-side:

```powershell
# Account A
$env:MT5_PATH               = "C:\FTMO_A\terminal64.exe"
$env:FTMO_EXPECTED_LOGIN    = "12345678"
# Account B
$env:MT5_PATH               = "C:\FTMO_B\terminal64.exe"
$env:FTMO_EXPECTED_LOGIN    = "23456789"
```

If `account_info().login` doesn't match `FTMO_EXPECTED_LOGIN`, the process
logs `mt5_wrong_account`, sends a Telegram alert, and `sys.exit(2)` — PM2
will keep restarting until the operator fixes the path. Skipping this is
allowed for single-account setups (a one-line warning is logged so you
notice on multi-account installs).

**4. Drift dashboard auth** (Round 57): `/api/drift-data` now requires a
Supabase session (or `FTMO_MONITOR_AUTH_BYPASS=1` for headless single-VPS
setups) — without it any visitor that knows your slug could read live
equity. The dashboard page already logs in, so legitimate use is unaffected.

### What it shows

| Section          | Source                                                            |
| ---------------- | ----------------------------------------------------------------- |
| Header chip      | `account.json` + R28_V5 reference                                 |
| Equity card      | `account.json` + `peak-state.json` + `daily-reset.json`           |
| Drift indicator  | live `equity` ÷ R28_V5 median curve                               |
| Equity chart     | `executor-log.jsonl` daily anchors + backtest p10/p50/p90 band    |
| Daily P&L bars   | day-anchor diffs from `executor-log.jsonl`                        |
| Active positions | `open-positions.json`                                             |
| Recent events    | last 20 `executor-log.jsonl` entries                              |
| Health checks    | heartbeat ≤ 5min · MT5 errors · Telegram fails · signal feed ≤ 6h |

### Endpoints

- `GET /dashboard/drift[?ftmo_tf=<slug>]` — page (auto-refresh every 30s)
- `GET /api/drift-data[?ftmo_tf=<slug>]` — JSON payload feeding the page

### Security

- **Read-only.** The dashboard never writes to state files.
- **Path-injection guard.** `ftmo_tf` slug is validated against
  `^[a-z0-9][a-z0-9-]{0,63}$` and the resolved path must stay under `cwd`.
- **No absolute paths in responses.** Only the relative state-dir name is
  returned (information-disclosure mitigation).
- **404 in production.** `FTMO_MONITOR_ENABLED` must be explicitly set to
  expose either the page or the API. Leave the flag unset on Vercel etc.

### Backtest reference (hardcoded)

The expected band is a heuristic envelope derived from the R28_V5 V4-Engine
champion (memory: `project_round52_r28v5_winrate_boost.md`):

- 58.82% pass-rate · median pass day **4** · p90 pass day **7**
- median curve: linear from 0% on day 0 to **+10% on day 4**, then plateau
- p90 band: hits +10% by ~day 2.5, then plateau
- p10 band: drifts toward -2..-4% by day 7

If you re-bake the champion to a new config, edit `BACKTEST_REF` in
`src/app/api/drift-data/route.ts`.

## Kill-Switch (Notfall)

Wenn Bot spinnt oder du sofort alles schließen willst:

```powershell
python tools\ftmo_kill.py
```

Schließt ALLE Positionen mit `magic=231` sofort. Manuelle Positionen (ohne Bot) bleiben unangetastet.

## Telegram-Alerts (empfohlen)

Du willst per Telegram informiert werden? Nur 2 Minuten Setup:

1. **Bot erstellen**: Telegram öffnen → `@BotFather` chatten → `/newbot` → Name geben → **TOKEN kopieren**
2. **Chat-ID holen**: Schreib deinem neuen Bot eine beliebige Nachricht → dann öffne im Browser:
   `https://api.telegram.org/bot<DEIN_TOKEN>/getUpdates`
   → suche `"chat":{"id": 123456789}` → das ist deine Chat-ID
3. **ENV setzen** in beiden Terminals:
   ```powershell
   $env:TELEGRAM_BOT_TOKEN="1234:AAA..."
   $env:TELEGRAM_CHAT_ID="123456789"
   ```

Du bekommst automatisch:

- 🤖 Service-Start
- 🚨 Jedes neue Signal
- ✅ Order-Placement mit Fill-Details
- 📉 Position-Close (SL/TP/Hold-Expiry)
- 🛑 FTMO Rule-Block
- ⚠️ MT5-Disconnect + ✅ Reconnect
- 📅 Daily Reset mit Yesterday-P&L Zusammenfassung
- ❌ Order-Failures
- 🛑 Executor Stopped

## Mock-Mode (ohne MT5 testen!)

Du bist gerade nicht an Windows/MT5? Kein Problem:

```bash
# Linux/Mac/WSL — uses Binance prices to simulate
FTMO_MOCK=1 FTMO_STATE_DIR=./ftmo-state python3 tools/ftmo_executor.py
```

Der Mock-MT5 (`tools/mock_mt5.py`):

- Simuliert $100k FTMO Demo-Account
- Holt echte Binance-Preise (ETHUSD/BTCUSD/SOLUSD via Binance ticker)
- Füllt Orders mit ±2.5bp half-spread
- Trigger SL/TP automatisch wenn Preis sie touched
- Identisches Interface wie echte MetaTrader5-Lib
- Du kannst die ganze Pipeline auf Linux/Mac testen bevor du Windows anwirfst

**Sobald bereit für echt**: einfach `FTMO_MOCK=1` weglassen.

## Daily Reset Automation (automatisch)

Der Executor erkennt UTC-Tageswechsel und speichert bei jedem 00:00 UTC automatisch:

- Aktuelles Equity als `equityAtDayStart`
- Gestern's P&L als Telegram-Summary
- Persistent in `ftmo-state/daily-reset.json`

Daily-Loss-Gate (5%) funktioniert damit ohne manuellen Eingriff.

## Parallel-Deployment: 4h + 2h auf demselben VPS

Auf einem Contabo VPS kannst du beide Strategien gleichzeitig laufen lassen
(z.B. 4h V261 + 2h V261_2H_OPT v5 zum Vergleich).

### Was du brauchst

- 2 FTMO Accounts (z.B. 1 Funded + 1 Demo zum Testen, oder 2 Demos)
- 2 separate MT5-Installationen (eine pro Account)
- ~1.2 GB RAM total — passt auf jeden Contabo VPS

### MT5 doppelt installieren

Beim 2. MT5-Installer den Zielordner ändern, z.B.:

```
C:\Program Files\MetaTrader 5\          ← Account 1 (4h)
C:\Program Files\MetaTrader 5 Account2\ ← Account 2 (2h)
```

In jedem Terminal den jeweiligen FTMO-Login einloggen.

### 4 Terminals (jeweils Daueraktiv)

**Terminal A1 — 4h Signal Service**

```powershell
cd C:\tradevision-ai
$env:FTMO_TF = "4h"
$env:FTMO_START_BALANCE = "100000"
npx tsx scripts/ftmoLiveService.ts
```

→ State: `C:\tradevision-ai\ftmo-state-4h\`

**Terminal A2 — 4h MT5 Executor**

```powershell
cd C:\tradevision-ai
$env:FTMO_STATE_DIR = "C:\tradevision-ai\ftmo-state-4h"
$env:MT5_PATH = "C:\Program Files\MetaTrader 5\terminal64.exe"
python tools/ftmo_executor.py
```

**Terminal B1 — 2h Signal Service**

```powershell
cd C:\tradevision-ai
$env:FTMO_TF = "2h"
$env:FTMO_START_BALANCE = "100000"
npx tsx scripts/ftmoLiveService.ts
```

→ State: `C:\tradevision-ai\ftmo-state-2h\`

**Terminal B2 — 2h MT5 Executor**

```powershell
cd C:\tradevision-ai
$env:FTMO_STATE_DIR = "C:\tradevision-ai\ftmo-state-2h"
$env:MT5_PATH = "C:\Program Files\MetaTrader 5 Account2\terminal64.exe"
python tools/ftmo_executor.py
```

### Telegram-Unterscheidung

Beide Services nutzen denselben Bot. Du erkennst sie an der ONLINE-Message:

```
🤖 FTMO Signal Service ONLINE (4h)   ← Account 1
🤖 FTMO Signal Service ONLINE (2h)   ← Account 2
```

### Performance-Erwartung

| Variante              | Pass-Rate  | Median FTMO-real | Risiko           |
| --------------------- | ---------- | ---------------- | ---------------- |
| 4h V261               | 94.31%     | 5d               | DL 0 / TL 38     |
| **2h V261_2H_OPT v5** | **94.60%** | **4d**           | **DL 0 / TL 37** |

V5 (2h) ist der strikte Champion — schneller UND höhere Pass-Rate.
4h läuft parallel als Kontroll-Track-Record.

### FTMO-Hinweis

Auf 2 Funded Accounts ist **kein Hedging** zwischen den Konten erlaubt.
Beide Bots sind short-only Mean-Reversion (gleiche Richtung), also
keine Hedging-Verletzung — aber bei Account-Verifikation immer prüfen,
welche Regeln dein konkreter Plan hat.

## PM2 Auto-Restart (empfohlen für Production)

PM2 hält beide Services (Node Signal + Python Executor) am Leben durch:

- Auto-restart bei Crash (max 50 retries, 5-10s delay)
- Restart-on-boot (Windows Service via `pm2-windows-startup`)
- Memory-Limit-Restart (500M / 300M)
- Persistente Logs in `ftmo-state-{tf}/pm2-*.log`

### Setup auf Windows VPS

```powershell
# 1. PM2 + Windows-Startup Helper installieren (einmalig, global)
npm install -g pm2 pm2-windows-startup

# 2. Bot-Verzeichnis
cd C:\tradevision-ai

# 3. ENV-Variablen für Telegram in Session setzen (NICHT mehr ins Repo committen!)
$env:TELEGRAM_BOT_TOKEN = "<YOUR_BOT_TOKEN>"
$env:TELEGRAM_CHAT_ID = "<YOUR_CHAT_ID>"

# 4. Beide Services starten (default: 1h Variante = V7_1H_OPT)
pm2 start tools/ecosystem.config.js

# 5. Konfiguration speichern
pm2 save

# 6. Auto-Start beim VPS-Boot aktivieren
pm2-startup install

# 7. Verify
pm2 list
```

### Timeframe ändern (1h ↔ 2h ↔ 4h)

```powershell
# Edit ecosystem.config.js → ändere TF = "1h" auf "2h" oder "4h"
# Dann:
pm2 reload tools/ecosystem.config.js
pm2 save
```

### Daily Operations

```powershell
pm2 list                  # Status check
pm2 logs ftmo-signal      # Live Signal-Service Logs
pm2 logs ftmo-executor    # Live Executor Logs
pm2 monit                 # Interactive monitor (CPU/RAM)
pm2 restart all           # Force restart beider Services
pm2 stop all              # Stop ohne Auto-Restart
pm2 delete all            # Komplett aus PM2 entfernen
```

### Troubleshooting

- **Service startet nicht / "errored":** `pm2 logs ftmo-signal --err` zeigt Fehler. Bei MT5-Connection-Issues prüfe ob MT5-Terminal offen ist.
- **Reboot test:** `Restart-Computer` → nach 2 min `pm2 list` sollte beide Services zeigen
- **Logs zu groß:** PM2 rotiert nicht automatisch. Bei Bedarf: `pm2 install pm2-logrotate`

Das macht `tools/ftmo_executor.py`'s eigenes MT5-Reconnect (alle 10s) noch
robuster — falls der ganze Python-Prozess crasht, holt PM2 ihn zurück.

## MT5 Auto-Reconnect (automatisch)

Wenn MT5-Verbindung abbricht:

- Executor erkennt disconnect via `account_info() = None`
- Versucht automatisch reconnect alle 10 Sekunden
- Telegram-Alert bei Disconnect + Reconnect
- Eskaliert bei Attempts 3, 10, und dann alle 30

Du brauchst KEIN Pm2/NSSM mehr — Executor läuft selbst-heilend 24/7.

## Demo-First Workflow (DRINGEND EMPFOHLEN)

**Schritt 1 — FTMO Demo Account**

1. Bei FTMO kostenlosen Demo beantragen
2. MT5 mit Demo-Credentials einloggen
3. Beide Services starten (siehe oben)
4. **1-2 Wochen laufen lassen** und beobachten
5. Prüfen:
   - Werden Signale korrekt erkannt?
   - Werden Orders korrekt platziert (Lot-Size, SL/TP)?
   - Matched die Lot-Size dem Risk-Budget?
   - Execution Slippage: passt Entry-Price zum Binance-Close?
   - Nightly Swap: passt swapBpPerDay=5 zu FTMO's Rate?

**Schritt 2 — Live Challenge (NACH Demo-Validation)**

1. FTMO Challenge kaufen (€99 für $100k Normal)
2. Neue MT5-Credentials einloggen
3. Bot starten
4. **STÄNDIG Monitoring in ersten 3 Tagen** — bei Fehler sofort Kill-Switch

## FTMO-Regeln die der Bot einhält

✅ Max Daily Loss 5% — geprüft vor jeder Order  
✅ Max Total Loss 10% — geprüft vor jeder Order  
✅ Max Hold Time — Trade wird geschlossen nach `maxHoldHours` (default 24h)  
✅ News Blackout — Signale während ±2min um High-Impact News werden blockiert  
⚠️ Consistency Rule (kein Trade > 45% Gesamt-Profit) — **nicht automatisch** — manuell prüfen wenn ein Winner extrem groß wird  
⚠️ Weekend Hold — positions über Fr 21:00 UTC offen brauchen hohen Swap — Bot trägt das mit, aber beobachten

## Bekannte Limits

1. **MT5-Python Library läuft NUR auf Windows.** Linux/Mac nicht möglich.
2. **Bar-Close-Detection**: Node Service pollt Binance 30s nach Bar-Close. Wenn Binance lahmt, Signal verzögert.
3. **Symbol-Name-Mapping**: Du musst MANUELL in MT5 die exakten Symbol-Namen checken und in `.env.ftmo` setzen. Falsch gemapped = keine Orders.
4. **Lot-Size-Berechnung**: vereinfacht, könnte bei ungewöhnlichen Instruments off sein. Bei Demo validieren.
5. **Tick-Value-Annahme**: `trade_tick_value` aus MT5 symbol_info wird verwendet. Bei Crypto-CFDs manchmal 0 → lot=0. Dann lot-calculation manuell patchen.
6. **Daily Reset**: Bot trackt `equityAtDayStart` nicht automatisch. Du musst in `account.json` bei UTC 00:00 equity speichern (Node-Service kann das cron-en).
7. **Reconnects**: bei MT5-Verbindungsabbruch stoppt der Executor. Pm2/NSSM für Auto-Restart empfohlen.

## Pm2 / NSSM für Auto-Restart (empfohlen)

```powershell
# Node Service als Windows-Service
npm install -g pm2
pm2 start "node ./node_modules/tsx/dist/cli.mjs scripts/ftmoLiveService.ts" --name ftmo-signal
pm2 save
pm2-startup install  # Windows auto-start
```

Für Python ähnlich mit NSSM (Non-Sucking Service Manager):
https://nssm.cc/

## Troubleshooting

| Problem                    | Fix                                                   |
| -------------------------- | ----------------------------------------------------- |
| MT5 init failed            | MT5-Terminal gestartet? Einge­loggt?                  |
| `symbol_select` failed     | FTMO\_\*\_SYMBOL env wrong? Prüfe in MT5 Market Watch |
| Orders werden nicht placed | Terminal B Log prüfen (`executor-log.jsonl`)          |
| `lot = 0`                  | `tick_value` ist 0 für dein Broker → contact FTMO     |
| Signals erscheinen nicht   | Terminal A prüfen — Binance erreichbar?               |
| Python import error        | `pip install MetaTrader5` ausführen                   |

## Workflow bei LIVE-Deployment

1. Demo komplett durchlaufen lassen (min 1 Challenge-Zyklus = 30 Tage simuliert)
2. Ergebnisse mit Backtest-Erwartung vergleichen (62% pass? Median 6d?)
3. Wenn Demo match → Live Challenge kaufen
4. **Erste 24h: ständig Monitoring**
5. Nach 3 Tagen ohne Fehler → weniger intensiv
6. Kill-Switch Script auf Desktop als Shortcut
7. Telegram-Bot anbinden (optional) für Push-Nachrichten bei jedem Trade

## Nächste Schritte

Nach erfolgreicher Demo-Phase, melde zurück:

- Wie viele Signale kamen?
- Wie viele Orders korrekt platziert?
- Matched Execution-Price dem Backtest?
- Echte Commission / Slippage / Swap-Zahlen?

Mit den realen Zahlen kann ich iter231 präzise neu-kalibrieren.
