# Pre-Live Setup Guide — R28_V6 FTMO Bot

Komplettes Step-by-Step für ersten Live-Deploy. ~30 Minuten Aufwand.

---

## ✅ Pre-Flight Checklist (alles vor Start besorgen)

- [ ] Windows VPS (oder lokaler 24/7 Windows-PC) mit RDP-Zugang
- [ ] FTMO Demo-Account ($100k Step 1, ~155€)
- [ ] MT5 Terminal auf VPS installiert + FTMO-Login funktioniert
- [ ] Telegram Bot via @BotFather erstellt
- [ ] Git + Node.js 18+ + Python 3.11+ auf VPS

---

## Schritt 1 — Windows VPS bestellen (5min)

**Empfohlen:** Vultr, Hetzner Cloud, Contabo

**Wichtig: Standort = London / Frankfurt / Amsterdam**

- ~30ms Latenz zu FTMO MT5 server
- USA/Asien = 100-200ms extra → bei MARKET-Order vermeidbarer Slippage

**Spec:**

- 4 GB RAM, 2 vCPU minimum
- Windows Server 2022 (oder Win 11 Pro)
- 50 GB SSD
- ~12-15€/Monat

**Setup nach Bestellung:**

1. RDP via Microsoft Remote Desktop / RDP-Client
2. Windows-Updates installieren (~30min)
3. Chrome / Firefox + Notepad++

---

## Schritt 2 — FTMO Demo Account bestellen (10min)

1. https://ftmo.com/de/?affiliates=… (mit Affiliate-Code falls vorhanden)
2. **Challenge:** $100,000 Account Size, **Normal** type (8% target / 5% DL / 10% TL)
3. **Platform: MT5** (NICHT cTrader)
4. Bezahlung ~155€
5. Email mit MT5 credentials erhalten:
   - Login (Zahl, ~7-stellig)
   - Password
   - Investor Password (für nur-lese Zugang, Bot braucht's nicht)
   - Server name (z.B. `FTMO-Demo` oder `FTMO-Demo3`)

**Auf VPS:**

1. FTMO MT5 Terminal von ftmo.com herunterladen + installieren
2. Login mit obiger credentials
3. Verifiziere: Account-Balance zeigt $100,000

---

## Schritt 3 — Telegram Bot (5min)

1. Telegram öffnen → @BotFather suchen
2. `/newbot` → Bot Name + @username (z.B. `MyFtmoBot`)
3. Bot-Token kopieren (Format: `1234567890:ABCD...`)
4. **Chat-ID herausfinden:**
   - Bot in Telegram öffnen, schreibe `/start`
   - Im Browser: `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - In der JSON: `"chat":{"id":123456789}` → das ist deine Chat-ID

---

## Schritt 4 — Repository auf VPS klonen (5min)

In PowerShell auf VPS:

```powershell
cd C:\
git clone https://github.com/Webmsaster/tradevision-ai.git
cd tradevision-ai
```

Optional (falls main neuer als deine Memory): `git pull origin main`.

---

## Schritt 5 — Python + Dependencies (5min)

```powershell
# Python 3.11+ check
python --version

# Install dependencies
cd tools
pip install -r requirements.txt
```

Dependencies: `MetaTrader5` (Windows-only), `pytest`.

**Test that mock works:**

```powershell
$env:FTMO_MOCK="1"
python -m pytest tools/ -q
# should show 111 passed
```

---

## Schritt 6 — `.env.ftmo` konfigurieren

Erstelle `C:\tradevision-ai\.env.ftmo`:

```bash
# === Strategy Selection ===
FTMO_TF=2h-trend-v5-quartz-lite-r28-v6-v4engine
FTMO_ACCOUNT_ID=demo1
FTMO_START_BALANCE=100000

# === MT5 Login Validation (R57) ===
FTMO_EXPECTED_LOGIN=<DEINE-MT5-LOGIN-ZAHL>

# === Risk Filters ===
REGIME_GATE_ENABLED=true
REGIME_GATE_BLOCK=trend-down
SLIPPAGE_ENTRY_SPREADS=1.5
SLIPPAGE_STOP_SPREADS=3.0

# === Conservative Demo 1 (optional, weglassen für aggressives Setup) ===
# RISK_FRAC_HARD_CAP=0.3
# REGIME_GATE_BLOCK=trend-down,high-vol  # safer but more wait time

# === Telegram ===
TELEGRAM_BOT_TOKEN=<DEIN-BOT-TOKEN>
TELEGRAM_CHAT_ID=<DEINE-CHAT-ID>
TELEGRAM_BOT_TOKEN_demo1=<DEIN-BOT-TOKEN>  # multi-account convention (R57)
TELEGRAM_CHAT_ID_demo1=<DEINE-CHAT-ID>

# === Drift Dashboard ===
FTMO_MONITOR_ENABLED=1

# === Optional: Live News-Updates (skip für Demo 1) ===
# NEWS_BLACKOUT_ENABLED=true
# NEWS_API_KEY=<finnhub-token>
```

**Sicherheit:** `.env.ftmo` ist in `.gitignore`. NICHT committen.

---

## Schritt 7 — Bot starten

```powershell
# Install PM2 falls noch nicht da
npm install -g pm2

# Im Projekt-Root
cd C:\tradevision-ai
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Auto-Start beim Reboot
```

**Logs prüfen:**

```powershell
pm2 logs ftmo-executor
pm2 logs ftmo-signal-service
```

Erwartet:

- `[boot] STATE_DIR=C:\tradevision-ai\ftmo-state-2h-trend-v5-quartz-lite-r28-v6-v4engine-demo1\`
- `[boot] FTMO_TF=2h-trend-v5-quartz-lite-r28-v6-v4engine`
- `[boot] CFG=V5_QUARTZ_LITE_R28_V6 (engine v4)`
- `[mt5] connected, login=<deine login>, balance=100000`
- Telegram: "🤖 Bot started — demo1"

---

## Schritt 8 — Drift Dashboard öffnen

Auf VPS — **WICHTIG**: build MIT `FTMO_MONITOR_ENABLED=1` ausführen, sonst wird `/dashboard/drift` als statisches 404 gecacht:

```powershell
cd C:\tradevision-ai

# CRITICAL: build with monitor flag set
$env:FTMO_MONITOR_ENABLED="1"
npm run build

# Start production server
PORT=3000 NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co `
  NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder `
  FTMO_MONITOR_ENABLED=1 FTMO_MONITOR_AUTH_BYPASS=1 `
  npm start
```

Browser: `http://<vps-ip>:3000/dashboard/drift?ftmo_tf=2h-trend-v5-quartz-lite-r28-v6-v4engine-demo1`

Du siehst:

- Header mit Day-Counter + Status Chip
- Equity Card (current vs day-start vs peak)
- Equity Chart mit Backtest-Band (p10/p50/p90)
- Drift Indicator (live vs erwartete Trajektorie)
- Aktive Positionen Tabelle
- Recent Events Log
- Health Checks (Bot heartbeat, MT5 connection, Telegram)

**Tipp:** Browser-Tab auf 2. Monitor offen lassen, refresh alle 30s automatisch.

---

## Schritt 9 — Telegram Bot Commands testen

In Telegram, schreibe an deinen Bot:

- `/status` → kurze account+positions Zusammenfassung
- `/pause` → bot stoppt neue Trades (manual)
- `/resume` → wieder aktiv
- `/kill` → Notbremse: alle Positionen schließen + Bot stoppen

**Verifiziere `/status` antwortet innerhalb 2 Sekunden.** Wenn silent, Telegram-Bot nicht subscribed → Setup-Bug.

---

## Schritt 10 — 24h Beobachtung

**Tag 1 Erwartung:**

- 0-3 Trades (R28_V6 ist selektiv)
- Telegram: alerts bei jedem Order, Daily-Reset 00:00 Prague

**Was du beobachten solltest:**

- ✅ Bot heartbeat alle paar Sekunden im Drift-Dashboard
- ✅ Telegram-Alerts kommen real-time
- ✅ MT5 zeigt Trades synchron mit Bot-Log
- ✅ Slippage realistisch (~0.05-0.2% bei MARKET-Orders)
- ❌ Wenn Bot nach 4h ohne Signal → check Regime-Gate (vielleicht trend-down geblockt)
- ❌ Wenn Telegram silent → Token/Chat-ID falsch

---

## Schritt 11 — Tag 4 Pause-Phase

**Wenn Equity ≥ 8% erreicht:**

- Telegram: "🎯 TARGET HIT — pausing"
- Bot macht "ping trades" (~0.01 lot, magic=232) für minTradingDays=4
- ~76% aller Pässe enden genau am Tag 4

**Wenn Tag 4 erreicht UND ≥ 8% Equity:**

- Bot stoppt
- Telegram: "✅ CHALLENGE PASSED"
- Manuell: bei FTMO Verification beantragen (Step 2)

---

## Troubleshooting

### Bot crashed

```powershell
pm2 logs ftmo-executor --err --lines 50
```

Häufige Ursachen:

- MT5 disconnected (re-login auf VPS)
- Binance-Outage (Bot retried automatisch)
- Stale `pending-signals.json` (delete it, restart)

### Keine Trades nach 24h

- Check Drift-Dashboard: zeigt es Bot-Heartbeat? Wenn nein, Bot tot
- Check `executor-log.jsonl`: gibt es `regime_gate_block` Events? Markt war in trend-down
- Check `signal-alerts.log`: gibt es überhaupt Signale? Wenn nein, Setup-Bug
- Conservative Regime-Gate kann viele Trades blocken — siehe `.env.ftmo` Anleitung

### Telegram silent

- @BotFather → /mybots → Bot inspect → Privacy Disabled?
- Bot muss in Group oder Direct-Chat sein, nicht Channel
- Token nochmal prüfen, Chat-ID `>0` (positive Zahl, nicht negative)

### MT5 wrong account

- R57 Fix: Bot exits 2 mit Telegram alert wenn `mt5.account_info().login != FTMO_EXPECTED_LOGIN`
- Fix: setze `FTMO_EXPECTED_LOGIN` korrekt, oder lösche das env var (nur warnen)

---

## Multi-Account aufrüsten (nach Demo 1 Validation)

Nach 1 Woche stabilem Betrieb:

1. 2. FTMO Demo bestellen (155€)
2. 2. MT5 Terminal auf VPS installieren (ja, parallel auf demselben VPS, eigenes Profile)
3. `.env.ftmo.demo2` erstellen mit:
   - `FTMO_ACCOUNT_ID=demo2`
   - `FTMO_EXPECTED_LOGIN=<demo2-login>`
   - `TELEGRAM_BOT_TOKEN_demo2=<vielleicht eigener bot>` (oder selber wie demo1)
4. PM2: 2. Process starten:
   ```powershell
   pm2 start ecosystem.config.js --name ftmo-executor-demo2 --env-from-file .env.ftmo.demo2
   ```

**Wichtig: Master Telegram Listener:**

- Nur EINE Instanz darf `getUpdates` long-poll machen
- Setze `FTMO_TELEGRAM_BOT_MASTER=1` auf demo1
- demo2 schickt Alerts aber listened nicht auf Commands

---

## Kosten-Übersicht

| Item                       |      Cost |      Monatlich |
| -------------------------- | --------: | -------------: |
| Windows VPS (London 4GB)   |    12-15€ |      recurring |
| FTMO Demo 1 ($100k Step 1) |      155€ |       one-time |
| FTMO Demo 2 (für 2× Multi) |      155€ |       one-time |
| Total Initial              | **~325€** | + 12-15€/Monat |

**EV-Kalkulation 2× Multi:**

- 84% min-1-pass × 250€ FTMO-Auszahlung pro Account = ~210€ Erwartung
- ROI nach 1-2 erfolgreichen Cycles

---

## Was NICHT machen (häufige Fehler)

- ❌ NICHT mit Live-Real-Money Account starten — immer Demo erst
- ❌ NICHT mehrere Bots auf gleichem MT5-Login
- ❌ NICHT `.env.ftmo` committen (Tokens leak!)
- ❌ NICHT `pm2 stop` während offene Position — `/kill` via Telegram nutzen
- ❌ NICHT VPS-Firewall offen lassen — nur MT5/SSH-Port forwarden
- ❌ NICHT "ein bisschen tighter Stop" experimentell ändern — du hast 5 Audit-Runden Tests, der Bot ist getuned

---

## Erfolgs-Checkliste — was bedeutet "deployed"?

- [ ] Bot läuft 24h ohne Crash
- [ ] ≥ 1 Trade fertig (open + close + Telegram fertig)
- [ ] Drift-Dashboard zeigt Live-Equity-Curve
- [ ] Daily-Reset um 00:00 Prague läuft sauber
- [ ] Telegram-Commands `/status` antworten

Wenn alle 5 ✓ → System ist battle-tested. Du kannst Multi-Account aufrüsten.

---

## Support

Bei Problemen:

- Issue auf GitHub: github.com/Webmsaster/tradevision-ai/issues
- Logs: `tools/executor-log.jsonl`, PM2 logs, MT5 Experts-Tab
- Drift-Dashboard immer als first-look check

---

**Code ist ready. Markt wartet. 🚀**
