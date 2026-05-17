# Frage an Codex — 2026-05-17

## Situation

User-Goal: **90% UNCONDITIONAL passrate** auf single-account, blind challenge buy,
keine starken trade-offs.

## Was wir bisher haben

**Champion-Config:**

```
2h-trend-v5-amber-max-passlock + V02 voters (poc-z, bb-z-mr, supertrend,
hmm, ad-line, min-votes 2) + BTC cross-asset filter 9/21 + tp_mult 1.14
+ Kelly w60/m20 + PTP @ 0.08:0.25
```

**Mess-Daten (P06 PTP champion, full 334w / 324 common):**

| Cohort                               | n           | P1 pass | P2 pass | AND        |
| ------------------------------------ | ----------- | ------- | ------- | ---------- |
| Both qualifying (b≥4 & maj≥3 in 24h) | 132 (40.7%) | 93.94%  | 96.97%  | **92.42%** |
| Mixed qualifying                     | 39 (12.0%)  | 30.77%  | 92.31%  | 30.77%     |
| NOT qualifying                       | 153 (47.2%) | 28.76%  | 33.33%  | 28.10%     |
| **ALL (no gate)**                    | 324         | 55.56%  | 66.36%  | **54.63%** |

Gap zu 90% unconditional = **+35.37pp** auf alle 324 Windows. ENORM.

## Was wir ausprobiert haben (alle bug-frei post-process sim'd)

### Gate-Filter (Codex Hebel #1) — ✅ WINNER aber NUR CONDITIONAL

- breadth≥4 & majors≥3 in 24h cluster → 92.42% AND auf qualifying subset
- Engine-Flag implementiert in `sweep.rs`: `--min-initial-signal-breadth`, `--min-initial-majors`
- ABER: nur 40% der windows qualifying. Unconditional bleibt 54.63%.

### Conditional Risk-Pause auf non-qualifying — ❌ DEBUNKED

- Nach 24h: wenn non-qualifying → reduce trade size 0.0-0.5x
- Resultat: marginal worse (51% vs baseline 54%). DL/TL passieren BEVOR der 24h check.

### Batch-Exposure-Cap, Initial Risk-Ramp, Damage-Pause — ❌ DEBUNKED (-3 bis -45pp)

- Codex's Hebel #3, #4, #5 alle negativ.

### HMM-4state Voter, 14 zusätzliche voters, 11 base-configs, PTP micro-grid, max-days — ❌ alle TIE oder HURT

### Pre-Window-Scanner BTC + Multi-Asset — ❌ DEBUNKED

- BTC 24h-Features (ret/atr/slope) vor window-start: NICHT prädiktiv
  (qualifying ret 0.39 vs non-qual 0.45 — diff 0.06pp)
- Multi-Asset 19-Symbol Aggregate (24h + 72h lookback): NICHT prädiktiv
  (qualifying avg_ret 0.375 vs non-qual 0.457 — diff 0.08pp)
- → Bot kann NICHT via Markt-Scan vor Challenge-Kauf prognostizieren

### Bidirectional Config (disable_short: false) — ❌ DEBUNKED -10.8pp

- v5_amber_max_passlock_bidir Template gebaut
- Engine bestätigt: shorts feuern (1798 trades, 72.6% winrate)
- ABER per-cohort: Qualifying 92.3→78.7% (-13.6pp), Non-qual 24.9→13.8% (-11.1pp)
- ALL: 54.6→43.8% — Shorts CANCEL longs in trending markets, lose in chaotic
- Long-only hardcoded IST der Design-Choice, kein bug

## Failure-Mode der non-qualifying Windows (deep-dive 2026-05-17 evening)

- **Fail-Reason Distribution:** 77 DailyLoss + 61 TotalLoss + 0 Time-fails
- **88% der Fails passieren binnen Day 3** (Day 1: 52, Day 2: 49, Day 3: 20)
- **79% der failing non-qual windows haben Day-1 PnL < -5%** (sofort DL-Breach)
- **CRITICAL: Bot ist hardcoded LONG-ONLY** (`templates.rs:105 disable_short: true`)
  - 0 Shorts in 4334 trades
  - In bearish/sideways setups verlieren ALLE longs simultan
  - Risk-Ramp hilft NICHT (verschiebt fail nur von Tag 1 auf Tag 3-5)
  - Strategie kann mathematisch nicht in bearish setups gewinnen

## Math-Realität

Für 90% unconditional braucht non-qual pass-rate = **88.7%**.
Long-only auf bearish 24h-Setups = strukturell unmöglich.

## Frage an Codex (UPDATED)

**Real-Frage:** Können wir die long-only Limitation umgehen, ohne das gesamte
Strategie-Framework zu pivotieren?

Spezifisch:

1. Ist eine `disable_short: false` Variante von AMBER_MAX_PASSLOCK gangbar
   (V02-voters können shorts wenn HMM/bb-z-mr/supertrend bearish konsensieren),
   oder bricht das die qualifying-Performance?
2. Multi-strategy: Engine läuft AMBER long-only PLUS ein meanrev/short-fähiges
   sub-detector parallel — addiert Pass-Rate ohne der trend-strategy zu schaden?
3. **Realistischer Ceiling**: Akzeptiere 65-75% unconditional + 92% conditional
   (smart-timing), oder strategy-pivot lohnt sich?

## Konkrete Frage an Codex

**Wie kommen wir auf 90% UNCONDITIONAL passrate ohne harten trade-off
(Bot kauft Challenge blind, spielt ihn, 90% pass)?**

Spezifisch:

1. **Gibt es einen Pre-Window-Indikator** (BTC 4h trend, ATR-Regime, funding-rate Level)
   der VOR Window-Start mit hoher Genauigkeit prognostiziert ob es ein "qualifying"
   Window wird? Wenn ja, hat der bot ja LIVE Zugriff darauf bevor er Challenge kauft.
2. **Welcher Engine-Modus reduziert DL/TL fails auf non-qualifying Setups**, ohne
   die qualifying-window gewinne zu killen? Risk-Ramp/Damage-Pause haben global
   gehurt — gibt es einen smarter conditional approach?
3. **Multi-strategy fallback**: Wenn breadth-gate signal nach 4-8h (nicht 24h)
   schon "wahrscheinlich non-qualifying" → switch auf andere Strategie-Klasse
   (z.B. mean-reversion mit anderen voters). Hast du Ideen welche?
4. **Können wir den P1-fail-Modus drastisch ändern** mit anderen Voter-Kombinationen
   speziell für die non-qualifying conditions? V02-voters sind für trend-bias
   getuned. Bei sideways/chaotic markets fehlt was?
5. **Realistisch erreichbar**: Ist 90% unconditional pass-rate auf single-account
   mathematisch machbar oder muss man pragmatisch auf ~70-75% setzen?

## Tools die wir haben

- Trade-Dump P1+P2 mit qualifying flag (`scripts/cache_bakeoff/hunt_2026_05_17/`)
- Engine-Flag `--min-initial-signal-breadth/majors` einsatzbereit
- Post-process tools: `breadth_quality_analysis.py`, `conditional_pause_sim.py`,
  `real_funded_prob.py`
