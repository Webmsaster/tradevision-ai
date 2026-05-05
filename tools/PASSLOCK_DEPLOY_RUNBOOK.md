# R28_V6_PASSLOCK — Live Deploy Runbook

Pre-condition: Round 60 Sweep abgeschlossen, PASSLOCK als Champion bestätigt (63.24% full-sweep / 64.77% preliminary 86-window backtest, +6.62 to +8.15pp vs R28_V6 56.62% baseline).

## 🎯 Ziel

Single-account oder 3-strategy Multi-Account Live-Bot mit R28_V6_PASSLOCK Engine-Flag. Erwartete Live-Pass:

- **1× PASSLOCK** → ~60% (drift -3 to -5pp)
- **3-Strategy** (PASSLOCK + TITANIUM + AMBER) → **~94% min-1-pass** ⭐

## ✅ Pre-Deploy Checks (VPS-side)

### 1. Code synced

```bash
cd C:\tradevision-ai
git pull
git log --oneline -5  # Letzter Commit muss Round 60 patches enthalten
```

### 2. Engine-Flag aktiv?

```powershell
node -e "const c = require('./src/utils/ftmoDaytrade24h').FTMO_DAYTRADE_24H_R28_V6_PASSLOCK; console.log('passlock:', c.closeAllOnTargetReached, 'pause:', c.pauseAtTargetReached);"
```

**Erwartet:** `passlock: true pause: true`

### 3. Tests grün?

```powershell
node ./node_modules/vitest/vitest.mjs run src/__tests__/ftmoLiveEngineV4Round60.test.ts
node ./node_modules/vitest/vitest.mjs run src/__tests__/driftDataRoute.test.ts
```

**Erwartet:** alle pass

### 4. Build grün?

```powershell
$env:FTMO_MONITOR_ENABLED="1"
$env:NEXT_PUBLIC_SUPABASE_URL="placeholder"
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY="placeholder"
npm run build
```

## 🚀 Single-Account Deploy

### Step 1: Env-File erstellen

```powershell
copy .env.ftmo.demo1.example .env.ftmo
notepad .env.ftmo
```

**Wichtig — diese Zeile ändern:**

```diff
- FTMO_TF=2h-trend-v5-quartz-lite-r28-v6-v4engine
+ FTMO_TF=2h-trend-v5-r28-v6-passlock
```

Ausfüllen:

- `FTMO_EXPECTED_LOGIN=<MT5-Login-Zahl>`
- `TELEGRAM_BOT_TOKEN_demo1=<Token>`
- `TELEGRAM_CHAT_ID_demo1=<Chat-ID>`

### Step 2: Pre-Flight

```powershell
python tools/preflight_check.py
```

**Erwartet:** `🟢 GO`

### Step 3: Bot starten

```powershell
pm2 start ecosystem.config.js
pm2 save
pm2 list
```

### Step 4: Verifizieren

```powershell
# Logs
pm2 logs --lines 30

# Telegram /status testen
# Drift Dashboard öffnen:
# http://<vps-ip>:3000/dashboard/drift?ftmo_tf=2h-trend-v5-r28-v6-passlock-demo1
```

**Erste 24h:** Bot wartet auf gültige Signale (0-3 Trades). KEINE Pause heißt es funktioniert.

## 🎯 3-Strategy Multi-Account Deploy (94% min-1-pass)

### Voraussetzungen

- **3 separate FTMO Demo Accounts** (oder 1 Demo + 2 alternative Prop-Firmen)
- **3 MT5 Terminals** auf VPS, jeder mit anderem Login
- **VPS mit ≥4GB RAM** (3× MT5 + Node + Python)

### Step 1: Alle 3 Env-Files

```powershell
copy .env.ftmo.demo1.example     .env.ftmo.demo1
copy .env.ftmo.titanium.example  .env.ftmo.titanium
copy .env.ftmo.amber.example     .env.ftmo.amber

# Demo1 → R28_V6_PASSLOCK (master Telegram)
notepad .env.ftmo.demo1
# FTMO_TF=2h-trend-v5-r28-v6-passlock
# FTMO_TELEGRAM_BOT_MASTER=1

# Titanium → V5_TITANIUM (send-only)
notepad .env.ftmo.titanium
# FTMO_TF=2h-trend-v5-titanium
# (FTMO_TELEGRAM_BOT_MASTER NOT SET)

# Amber → V5_AMBER (send-only)
notepad .env.ftmo.amber
# FTMO_TF=2h-trend-v5-amber
# (FTMO_TELEGRAM_BOT_MASTER NOT SET)
```

### Step 2: Launch

```bash
bash tools/start-3-strategy.sh
```

Skript macht automatisch:

- Verifiziert alle 3 Env-Files vorhanden
- Verifiziert exakt 1 Telegram-Master
- Pre-Flight pro Account
- PM2 mit 3 Prozessen: `ftmo-r28-v6`, `ftmo-titanium`, `ftmo-amber`

### Step 3: Monitor

```bash
pm2 list
pm2 logs --lines 30
```

3 Drift-Dashboards:

- `/dashboard/drift?ftmo_tf=2h-trend-v5-r28-v6-passlock-demo1`
- `/dashboard/drift?ftmo_tf=2h-trend-v5-titanium-titanium`
- `/dashboard/drift?ftmo_tf=2h-trend-v5-amber-amber`

## 📊 Expected Behaviour (R28_V6_PASSLOCK)

### Tag 1-3

- 0-5 Trades pro Tag
- Equity baut sich langsam auf
- Daily-Loss-Stop nicht aktiviert

### Tag 4 (KEY EVENT)

- **~50% Chance Target +8% getroffen**
- Bei Target-Hit: **ALLE OFFENEN POSITIONEN SOFORT GESCHLOSSEN** (Pass-Lock!)
- Bot pausiert + macht ping-Trades
- Telegram: `🎯 TARGET HIT — Pass-Lock activated, all positions closed`

### Tag 5-30 (nach Target-Hit)

- Bot wartet auf minTradingDays=4 (kann schon erfüllt sein)
- Tägliche ping-Trades (0.01 lot, ~$0 PnL)
- Telegram: `⏸️ paused at target, waiting for minTradingDays`

### Pass declared

- Telegram: `✅ CHALLENGE PASSED in <X> days`
- realised equity ≥ 1.08
- mtm equity ≥ 1.08
- tradingDays ≥ 4

### Falls Daily-Loss / Total-Loss vorher

- Telegram: `❌ FAILED — daily_loss / total_loss / give_back`
- Bot stoppt automatisch
- Manueller Reset: state-dir löschen + restart

## 🛡️ Safety Features (Round 60 ready)

- ✅ **Pass-Lock**: bei Target-Hit alle Positionen schließen → eliminiert Day-30-Force-Close-Risk
- ✅ **MT5-Login-Validation** (R57): Bot exits bei wrong account
- ✅ **Multi-Account-Isolation** (R57): per-account state-dirs + Telegram-tags
- ✅ **Slippage-Modeling**: SLIPPAGE_ENTRY_SPREADS=1.5
- ✅ **Regime-Gate**: REGIME_GATE_BLOCK=trend-down (skip BTC-bear-trend)
- ✅ **Live-Caps**: maxStopPct 5%, maxRiskFrac 40%

## 🆘 Notbremsen

```powershell
# A) Telegram /kill — schließt Positionen + stoppt Bot (recommended)
# B) PM2:
pm2 stop all

# C) Manuell in MT5:
# Alle Positionen → rechts-click → "Close All"

# D) python tools/ftmo_kill.py
```

## 📈 ROI Reality-Check

| Setup                                | Cost | Live Pass% (-3 to -5pp drift) | EV pro Demo |
| ------------------------------------ | ---: | ----------------------------: | ----------: |
| 1× PASSLOCK Demo                     | 155€ |                          ~60% |        +25€ |
| 2× PASSLOCK                          | 310€ |                          ~84% |       +225€ |
| 3-Strategy (PASSLOCK+TITANIUM+AMBER) | 465€ |                          ~94% |    +410€ ⭐ |

Pass-Reward (FTMO Funded): **$1500-2500 pro Bestand**.

## 🐛 Bekannte Issues / Erste Hilfe

| Symptom                     | Check                                                                          | Fix                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| "FTMO_TF nicht erkannt"     | `grep "passlock" src/utils/ftmoLiveSignalV231.ts`                              | Code-pull machen                                                           |
| Bot triggert KEIN Pass-Lock | `ls ftmo-state-*/executor-log.jsonl` → `targetHit: true` aber Positionen offen | Engine-Patch nicht aktiv → check `closeAllOnTargetReached: true` in config |
| Drift Dashboard 404         | `npm run build` mit `FTMO_MONITOR_ENABLED=1` neu bauen                         | rebuild                                                                    |
| Telegram silent             | `python tools/preflight_check.py`                                              | Token + Chat-ID prüfen                                                     |

## 📋 Final Pre-Deploy Checklist

1. ☐ Round 60 Sweep komplett (final aggregate gerunnt)
2. ☐ PASSLOCK als Champion in `MEMORY.md` bestätigt
3. ☐ `npm run build` clean
4. ☐ `node ./node_modules/vitest/vitest.mjs run` 911+ tests pass
5. ☐ MT5-Login + Telegram-Token konfiguriert
6. ☐ Drift-Dashboard erreichbar
7. ☐ `pm2 start ecosystem.config.js` Output: `online`

**Wenn alle 7 ✓ → R28_V6_PASSLOCK live.**
