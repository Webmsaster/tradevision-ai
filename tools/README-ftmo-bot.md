# FTMO Voll-Auto Bot — Setup Guide

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
