# FTMO Manual Trading Rules — iter212/213

**Asset**: ETHUSDT (nur dieser, single-asset)
**Timeframe**: 4h chart (Binance/FTMO/TradingView)
**Leverage**: 1:2 (FTMO-Normal-Plan Crypto-Limit)
**Hold max**: 12h (3 × 4h-Kerzen)

Vor jedem Trading-Tag: check welches Regime aktuell ist.

---

## Schritt 1: Regime bestimmen (einmal pro Tag, 00:00 UTC)

Öffne **BTCUSDT 4h-Chart**, check:

| Bedingung                         | Wert jetzt? |
| --------------------------------- | ----------- |
| BTC-Close > EMA10?                | \_\_\_      |
| EMA10 > EMA15?                    | \_\_\_      |
| BTC 24h (6 Kerzen zurück) Return? | \_\_\_%     |

**Regime-Regel:**

- BTC-Close > EMA10 > EMA15 **UND** 24h-Return > +2% → **BULL** (iter213, Longs)
- Sonst → **BEAR/CHOP** (iter212, Shorts)

---

## Schritt 2: Signal-Check (alle 4h zu Kerzen-Close, 00/04/08/12/16/20 UTC)

**Wichtig: KEIN Trade bei 08:00 UTC-Kerzen-Close** (drop-8 session filter).
Nur: 00, 04, 12, 16, 20 UTC.

### iter212 BEAR/CHOP — Short-Signale

**Setup:**

1. Aktuelle ETH-Kerze **grün** (close > open)?
2. Vorige ETH-Kerze **grün** (close > open)?
3. Wenn BEIDE grün → **potentielles Short-Signal**

**Zusätzliche BTC-Filter:**

- BTC NICHT in Uptrend (close ≤ EMA10 ODER EMA10 ≤ EMA15)?
- BTC 24h-Return ≤ +2%?

→ Wenn Signal + Filter OK: **SHORT ETH** beim Close der 2. grünen Kerze

**Stop/TP:**

- Entry-Preis = ETH-Close der Signal-Kerze
- Stop: Entry × 1,012 (+1,2% drüber)
- TP: Entry × 0,96 (−4% drunter)
- Exit spätestens nach 3 × 4h (= 12h) egal was

**Position-Size (wichtig für Pyramid):**

- Phase 1 (Account bei $10.000): **Base-Trade: 100% risk allocation**
- Bei 1,2% Stop × 2 Leverage × 100% = −2,4% Account-Loss max pro Trade

### iter213 BULL — Long-Signale

**Setup (genau umgekehrt!):**

1. Aktuelle ETH-Kerze **grün**?
2. Vorige ETH-Kerze **grün**?
3. Wenn BEIDE grün → **potentielles Long-Signal** (momentum continuation)

**Zusätzliche BTC-Filter:**

- BTC NICHT in Downtrend?
- BTC 24h-Return ≥ −2%?

→ **LONG ETH** beim Close der 2. grünen Kerze

**Stop/TP:**

- Stop: Entry × 0,985 (−1,5%)
- TP: Entry × 1,06 (+6%)
- Max hold: 12h

---

## Schritt 3: Pyramid (nur wenn du schon +1,5% Account-Gain hast)

Sobald dein Account-Equity > +1,5% ist:

- Bei JEDEM weiteren Signal → **zusätzlich Pyramid-Trade mit 4× Size**
- Base + Pyramid laufen parallel
- Pyramid nutzt gleiche Stop/TP-Regeln

**Pyramid-Risiko:** Ein Pyramid-Stop kann 7,2% Equity kosten (1,2% × 2 × 4). **Nach 2 Pyramid-Stops → Pyramid pausieren bis wieder bei +1,5% Equity.**

---

## Schritt 4: News-Filter (FTMO-Regel!)

**Pflicht:** Checke ForexFactory **täglich morgens** für High-Impact-News (USD/EUR/GBP).

**Regel:** KEINE Orders öffnen **2 Min vor bis 2 Min nach** einer High-Impact-News.

Live-Quelle: https://www.forexfactory.com/calendar (filter: High-impact, USD/EUR/GBP)

Typische kritische Zeiten:

- 12:30 UTC (US CPI, NFP, Retail)
- 18:00 UTC (FOMC)
- 08:30 UTC (GBP Inflation)

Da unsere Entries bei vollen Stunden (0, 4, 12, 16, 20 UTC) und News meist bei :30 sind, selten Konflikt. **Aber prüfen!**

---

## Schritt 5: Daily / Total Drawdown Limits

FTMO-Regeln:

- **Max 5% tägliche Drawdown** — wenn du heute schon bei −5% von Tages-Start bist: STOP trading für heute
- **Max 10% Total-Drawdown** — wenn Account bei −10%: Challenge failed
- **Profit-Target +10%** in max 30 Tagen
- **Min 4 Trading-Tage** (mindestens 4 Tage mit ≥1 Trade)

---

## Quick-Decision-Flowchart

```
1. BTC-Regime? → BULL oder BEAR/CHOP → wähle iter213 oder iter212

2. Current 4h-Bar-Close (nicht 08:00 UTC!)?
   → Nein: warten bis nächste 4h-Kerze
   → Ja: weiter zu Schritt 3

3. 2 gleiche Farb-Kerzen (beide grün)?
   → Nein: kein Trade, warten
   → Ja: weiter zu Schritt 4

4. BTC-Filter OK?
   → Nein: Signal skippen
   → Ja: weiter zu Schritt 5

5. News in nächsten 2 Min?
   → Ja: warten
   → Nein: weiter

6. Position öffnen:
   - iter212: SHORT, Stop +1.2%, TP −4%
   - iter213: LONG, Stop −1.5%, TP +6%
   - Max Hold: 12h

7. Equity > +1,5%? → JA: bei nächstem Signal zusätzlich Pyramid (4× size)

8. Equity >= +10% + 4 Trading-Tage? → Challenge PASSED! 🎉

9. Täglich um 23:59 UTC: check Total-Drawdown < 10% und Daily-Drawdown < 5%
```

---

## Erwartung

- **Historisch**: 50-60% der Challenges passen in ~10 Tagen (median)
- **Realistisch**: $297 budget für 3 Versuche → 88% Chance dass ≥1 passt
- **Worst-case**: alle 3 failen = $297 verloren. Das kann passieren.

---

## Psychologie-Regeln (wichtiger als Technik)

1. **Nie die Regeln brechen**, auch wenn "das sieht so sicher aus"
2. **Nach 2 Stops → Bildschirm 4 Stunden zu**
3. **Keine Trades aus Langeweile** — nur bei klarem Setup
4. **Pyramid NICHT auf Verlust-Streak** — warten bis Base-Bot wieder +1,5% hat
5. **Vor Trade immer checken**: passt alles (Kerze, Filter, News)?

---

## Ressourcen

- **Regime täglich checken**: `ftmoRegimeMonitor.test.ts` laufen lassen (siehe README)
- **Paper-Trade-Log**: `ftmoPaperTrade.test.ts` alle 4h laufen lassen für Live-Pulse
- **Backtest-Dokumentation**: `src/utils/ftmoDaytrade24h.ts` (alle Iterationen dokumentiert)
