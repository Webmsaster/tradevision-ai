# Session Handoff — 2026-05-28/29 (Forensik-Audit + Re-Baseline + DailyEquityGuardian + EoD-DailyLoss BREAKTHROUGH)

**Next session: READ THIS + memory `project_2026_05_29_negative_expectancy_root_cause.md` first.**

## 🎯🎯🎯 2026-05-29 — ROOT CAUSE FOUND: no genuine edge, pass-rate is a variance lottery (the answer to "steady strategy?")

Florian wanted a "savere strategy die nie busted und stetig steigt". Building the test that decides if that's possible produced THE structural explanation for all 9 debunks + the stuck pass-rate.

- **Edge-detector** (`scripts/steady_risk_grid.py`, commit db35fdf): shrink position size (`--risk-frac-mult`) with `--max-days 240` (FTMO has no time-limit). **Pass-rate RISING as risk drops = real positive edge; FALLING = variance lottery.** Rigorous because risk_frac_mult scales expectancy AND cost linearly → net-drift SIGN is sizing-invariant; proportional bps costs (no fixed-cost artifact); a zero-drift walk would give ~50% pass at low risk.
- **Result: EVERY signal class FALLS.** trend 9.8%→0%, meanrev 6.2%→0% (then treads water ≈zero drift), breakout 17.9%→3.6%, regime 16.1%→3.6% (mult 1.0→0.125). Universal across diamond/amber-max/obsidian/rubin AND both targets (P1 +10%, easy P2 +5%). Low risk bleeds to -10% TotalLoss in ~47d ≈ 0.33%/day ≈ the round-trip cost.
- **Zero-funding control:** zeroing all funding rates = IDENTICAL bleed → funding is NOT the killer. The signal's gross edge is ~zero; fees/slippage make it net-negative.
- **Meaning:** the bot has no predictive edge. Pass-rate = P(random spike clears +target before a dip clears a loss-floor). → Max pass-rate = MAX variance (full risk is already optimal). De-risking for "steadiness" is counterproductive. A steadily-rising/never-bust curve is a POSITIVE-expectancy object → **mathematically impossible on this signal set.** ~25% stack is the lottery ceiling, reached.
- **Only path to "steady" = find genuine positive expectancy** (must pass the edge-detector FIRST, before any tuning). meanrev is least-bad (treads water, not bleeding) = best edge-hunt start. Forex-trend is a candidate BUT lower-vol≠edge (zero-funding proved the problem is the signal) and needs a forex-trend config built (only debunked v5-forex-mr-passlock exists). Honest odds low — retail markets are efficient.
- **NOT a bug** — engine is forensically clean (05-28 audit). This is the genuine absence of edge.

---

## ⚠️ 2026-05-29 — BrightFunded-Daily-Loss bringt KEINEN Vorteil (EoD-„+21pp" war Modellfehler) + ehrliche Baseline ~17-19 %

Florians Idee: BrightFundeds Daily-Loss modellieren. **Wichtigste Lehre: erst ein falsches Modell (+21pp), dann durch Regel-Verifikation korrigiert auf „kein Vorteil".** Florians Insistenz auf echte Regeln hat ein Debunk #10 verhindert.

- **Falsches erstes Modell:** `daily_loss_eod` = Daily-Floor NUR am Tagesschluss prüfen → 48,67 % Stack-4 step=1 (+21pp, step-stabil). Sah toll aus.
- **Regel-Verifikation (Research-Agent, BrightFunded Help-Center verbatim):** Modell FALSCH. BrightFunded-Daily-Floor = `max(EoD-Balance, EoD-Equity) − Limit`, bei Rollover gesetzt, tagsüber eingefroren — aber **Breach wird INTRADAY/real-time geprüft** ("if balance or equity hits this level at any point during the day"). Unterschied zu FTMO = nur der Floor-Anker (prev-EoD-HWM vs day-start), NICHT das Timing. DD 10 % static (= FTMO). 2-Step Classic 10 %/5 % (= FTMO). Crypto 1:5, weekend-hold, min-days 5, keine Consistency, MT5.
- **Korrekt re-modelliert:** `cfg.daily_loss_eod_hwm` (state.eod_hwm_floor, intraday geprüft) + **intra-bar-TL-Fix** `cfg.intrabar_dd_check` (`compute_stress_mtm_equity` in pnl.rs, behebt MTM-close-only-Bug Befund 3). 474 Core-Tests grün. Runner: `scripts/brightfunded_eod_ab.sh`.
- **Ehrliche Messung (Stack-4, step=1):**
  - FTMO intraday (close-based): **27,65 %**
  - BrightFunded HWM (korrekt, close-based): **25,54 %** (−2,1pp — leicht SCHLECHTER, HWM-Anker minimal strenger)
  - BrightFunded HWM + intra-bar: **17,60 %** · FTMO + intra-bar: **18,98 %**
- **🔑 BrightFunded-Daily-Loss = NULL Vorteil** (sogar minimal schlechter, HWM-Anker strenger). Die 48,67 % waren komplett EoD-Modellfehler.

## 🔧 2026-05-29 SPÄT — KORREKTUR: die intra-bar-17-19%-Zahlen waren ÜBER-PESSIMISTISCH (Florian: „richtig getestet?")

- **Mein Fehler:** `compute_stress_mtm_equity` summiert alle Basket-Positionen GLEICHZEITIG auf ihrem intra-bar-Tief → nimmt an, alle Assets crashen im selben Tick. Exakt für 1 Asset, harte Obergrenze für einen Basket.
- **Single-Asset-Test (Check ist da EXAKT):** intra-bar-Penalty BTC 0 % / ETH 6 % / SOL 3 % / AVAX 3 % = **~3 % relativ**. 4er-Basket: 20,1 %→16,4 % = **19 %**. → der echte Effekt ist ~3 %, die restlichen ~16pp sind reines Simultan-Worst-Artefakt (~6× Over-Count).
- **Korrigierte ehrliche Zahlen:** Single-Account ~**7-7,5 %** (nicht 5,3 %), Stack-4 ~**25 %** (nicht 17,6 %), funded-EV +3 %-Banking **≈ break-even (−€7..−€30)** (nicht −€120). Die close-basierte 27,65 % war die ganze Zeit ~richtig.
- **Verdict revidiert: NICHT „firmly −EV" → marginal/break-even.** Funded-Account ist +EV im Betrieb (~+7 %/Leben; +3 %-Banking senkt Monats-Todesrate 100 %→36 %). Engpass = Akquise-Kosten, nicht Trading. Kipphebel break-even→+: Banking-Disziplin, FTMO-Fee-Refund, billigere Akquise (Instant-Funding?), bessere Config. Live-Drift −3-5pp kann mild ins Minus kippen.
- pnl.rs intra-bar-Check als single-asset/worst-case-only dokumentiert. Entscheidung: **bei FTMO bleiben**, Energie in Profit-Banking + Akquise-Kosten statt Strategie-Tweaks.
- **Bottom line:** Firm-Wechsel ist kein Hebel; aber „lohnt sich ein Account?" = ~break-even (marginal), NICHT klarer Verlust. Code commit-ready.

## ✅ 2026-05-29 — ERSTE saubere Out-of-Sample-Validierung: Baseline HÄLT (Florian: „hatten wir VOR heute Test-Fehler?")

Florian fragte, ob die Projekt-Grundlage (nicht heute) Test-Fehler hat. Größter nie-gefixter Verdacht: **In-Sample-Selektion** (Champions immer auf voller Historie gewählt, kein train/test-split — je).

- **Test** (`scripts/oos_validation.py`, neu): 6 clean configs × 3 baskets, base-knobs, FTMO close-based step=2. Greedy-Stack-4 auf TRAIN (frühe 70%, 2020-2024) wählen → auf TEST (späte 30%, 2024-2026, nie für Selektion genutzt) messen.
- **Ergebnis: TRAIN 23,9% → TEST 25,2% (Gap −1,3%, Test leicht HÖHER). Single 8,6%→9,3%. Avg/18 configs 5,2%→6,1%.**
- **→ Baseline ist NICHT selektions-overfit. Die ~25% Stack / ~6-9% Single sind ECHT, halten OOS.** Erste saubere OOS des Projekts. Die 9 Debunks holten 97%→25%; dieser Boden hält jetzt OOS = echter Floor, nicht nächste Illusion. Cache auch verifiziert (frisch, 40 assets, 2020-09→2026-05).
- **Limits:** validiert SELEKTION, nicht config-DESIGN (templates/TP per GA auf voller Historie → volle OOS bräuchte GA-Rerun nur-train); Test-Periode 2024-2026 war günstiges Trend-Regime; close-based + live-drift −3-5pp gelten weiter.

## ✅ 2026-05-29 — DESIGN-Overfit-Test (getunte Knobs): auch KEIN Overfit

Florians letzter Winkel: validiert die SELEKTION-OOS nur die config-Auswahl, oder auch das Parameter-DESIGN? Test (`scripts/oos_design_gen.sh` + `oos_design_analyze.py`): die getunten Knobs (tp_mult 0.95-1.15, votes1, kelly — auf voller Historie optimiert) in den Suchraum, Stack-4 auf Train wählen → auf Test messen.

- **step=2 (vergleichbar): TRAIN 29,7% → TEST 32,9%** (Gap −3,2%, Test höher, hält). vs base-knob-OOS 23,9/25,2 → die validen Knobs addieren **~+8pp und transferieren OOS** (kein Overfit). (step=3 gab 33,8→41,2 — absolut unzuverlässig, Debunk #7; nur die Train→Test-Beziehung zählt.)
- **→ WEDER Selektion NOCH Design overfit.** Beide Achsen test ≥ train. Der deploybare Knob-Stack ist OOS ~33% (nicht nur 25% base-knob).
- Einziger nicht-runtime-testbarer Rest: baked per-asset-TP in Templates — aber die Templates transferieren OOS (indirekte Evidenz ok).

**Session-Gesamtbild (29.05.) — FINAL:** Baseline ist auf ALLEN testbaren Achsen OOS-validiert: Selektion ✓, Design/Knobs ✓, Cache ✓, Kosten/Lookahead auditiert ✓. **Kein Fehler auffindbar, nicht zu pessimistisch, eher minimal optimistisch für live (drift −3-5pp).** Ehrliche Zahlen: Stack ~25% (base) bis ~33% (validierte Knobs), Single ~7-12%, funded-EV mit +3%-Banking ≈ break-even bis leicht positiv. FTMO ≈ BrightFunded (Firm kein Hebel). Florians 3 Beiträge (EoD-Skepsis, „richtig getestet?", „vor heute?"→OOS) haben 2 Modellfehler gefangen UND das Fundament validiert — der wertvollste Teil der Session.

## 🔄 2026-05-29 Resume (nach PC-Crash 16:00) — DailyEquityGuardian abgeschlossen (committed `bfd5b73`)

Florians PC war mitten in der DailyEquityGuardian-Implementierung gecrasht. Resume:

- **Code war fertig, nur ungetestet:** `guardian_halted`-Latch (state.rs), force-close+park-for-day (harness.rs), `--daily-equity-guardian <trig>` CLI (sweep.rs). → gebaut, Tests grün, committed `bfd5b73`.
- **A/B gemessen** (`scripts/guardian_ab_screen.sh`, sauberer Stack-4, step=1 vs 27,65 % Baseline): bestes Setting trig 0.015 = **27,08 % (−0,57pp)**, alle anderen −2 bis −6pp. **KEIN Setting > Baseline.** Guardian verschiebt nur DailyLoss→TotalLoss, kein Edge. = letzter FTMO-interner DL-Hebel abgehakt. (Kontrast: EoD oben rettet echt, weil es die FTMO-Regel selbst ersetzt.)

## TL;DR (die wichtigste Erkenntnis der Session)

Florian kam frustriert zurück ("komme schon lange nicht weiter wegen Logik/Fehlern/Bugs, irgendwas stimmt nicht"). Voller Audit gemacht. Ergebnis in einem Satz:

> **Die Engine ist forensisch SAUBER — kein versteckter Bug mehr. Die Strategie ist bei ~27,65 % Stack-4 (step=1, ehrlich) ausgereizt. Das Daily-Loss-Problem ist STRUKTURELL nicht weg-tunebar. Der einzige echte Hebel ist ein Firm-Wechsel zu BrightFunded (~0 Code).**

Florian hatte selbst recht: "es ist immer daily max loss... lass FTMO." Die Daten bestätigen es — tiefer als gedacht.

## What was done

1. **WSL2-Crash diagnostiziert** (Session-Start): Load 96 auf 16 Kernen, Swap-Thrash durch zu viele parallele Backtests. System erholt. Lehre: nie mehrere `ftmo-sweep --threads 14` gleichzeitig. Alle folgenden Läufe gedrosselt (`--jobs 6 --threads 1` bzw. max 4 parallel).
2. **5-Agent Forensik-Audit** (alle nur-lesen):
   - **Lookahead:** alle 39 signal\_\*.rs Module + Daten-Loader (funding/cb_premium/stablecoin/cme/nupl/top_ls) **sauber**. Kein Leak.
   - **Kosten/PnL/Exit:** realistisch–konservativ. PTP-double-charge, funding-latch, BE-loosens-trail **alle gefixt + getestet**.
   - **MTM-Daily-Loss:** 1 Rest-Bug — mtm_equity nutzt nur Bar-CLOSE, nicht intra-bar low/high → Backtest leicht zu optimistisch auf Multi-Position-Templates (HOCH, aber klein).
   - **🔴 KERN-BEFUND:** `reentry_after_stop` + `allow_pyramid` existieren NUR in Rust (0 Treffer in ftmoLiveEngineV4.ts + ftmo*executor.py). ~16 Templates erben die `aggressive_24h_kelly_reentry()`-Basis (alle agg_kr*\*, mixed_v2/v3/v4_cvd) → 7 von 8 Champion-Slots nutzen ein Live-Phantom-Feature.
   - **3 Voter dormant:** CME-Basis, NUPL, Top-Trader-L/S werden in sweep.rs nie gefüttert.
3. **BrightFunded-Recherche (Teil 3):** 2-Step-Classic-Variante matcht Bot-Hardcodes EXAKT (DL 5%/TL 10%/P1 10%/P2 5%). Server nicht hardcoded, Ticker über .env → **~0 Code, ~1-4h Switch**. Vorteile: WE-Halten erlaubt, 1:5 Hebel, EoD- statt intraday-DL.
4. **Ehrliche Re-Baseline (Teil 2):** Sauberer Stack-4 (NUR live-deploybare Templates: diamond/sharpe_tight) gemessen. Screening (step=7) **32,96 %** vs reentry-Champion 33,9 % → **Overfit kostete nur ~1pp**. Dann belastbarer step=1-Lauf: **27,65 % Stack-4 true-seq** (Screening übertrieb ~5pp).
5. **Daily-Loss-Tuning getestet** (Florians Idee): alle CLI-Hebel → **kein Gewinn**. `--override-mct 4` neutral (27,63 %), `--risk-frac-mult 0.7` −3,2pp (24,41 %), combo −1,4pp. **DL ist strukturell nicht tunebar** bei FTMO. ~97 % aller Fails = DailyLoss.

## Current state

| Metrik                                      | Wert                               |
| ------------------------------------------- | ---------------------------------- |
| Sauberer Stack-4 (step=1, belastbar)        | **27,65 % true-seq**               |
| → live-realistisch (−3..−5pp saubere Drift) | **~23-25 %**                       |
| Single-account (sauber, step=1)             | ~7-9 %                             |
| Dominanter Fail-Grund                       | **DailyLoss = ~97 %** aller Fails  |
| Engine-Zustand                              | forensisch sauber, deploy-ready    |
| Repo-Code-Änderungen diese Session          | **KEINE** (nur Recherche + Memory) |

Ehrliche Zahlen-Progression: 97,28 % (bug) → 44 % (MTM-Fix) → 33,9 % (reentry-Champion) → 32,96 % (clean screening) → **27,65 % (clean step=1 = ehrlichste je)**.

## Next steps (priorisiert)

1. **BrightFunded `.env` vorbereiten + Test** (empfohlen, ~1-4h): Demo-Login (`318747699`/`BrightFundedMT5!`/`BrightFunded-Server`) → exakte Ticker ablesen → `.env` befüllen → 2-Step-Classic-Account → Mikro-Lot Smoke-Test. Das greift den #1-Killer (DL) direkt an, ~0 Code.
2. ~~`DailyEquityGuardian`-Rebuild~~ **✅ ERLEDIGT 2026-05-29 → bringt NICHTS.** Halt-for-day-Latch gebaut + getestet (469+2 Tests grün, OFF by default). Stack-4 step=1 vs 27,65 % Baseline: bestes Setting (trig 0.015) = 27,08 % (−0,57pp), alle anderen −2 bis −6pp. **Kein Setting schlägt Baseline** — Guardian verschiebt nur DailyLoss→TotalLoss, kein Edge. 3. Bestätigung dass FTMO-DL strukturell nicht tunebar. Runner: `scripts/guardian_ab_screen.sh`. → Letzter DL-Hebel abgehakt, weiteres DL-Tuning sinnlos.
3. **Vor Live-Deploy:** Consistency-Rule auf BrightFunded-FUNDED-Account verifizieren (Help-Center) + exakte Crypto-Ticker am Demo.
4. **NICHT mehr:** an Strategie/Templates schrauben — Ceiling bei ~27 % erreicht, empirisch bestätigt.

## Open issues / blockers

- **Entscheidung pending bei Florian:** (a) BrightFunded-Switch angehen, oder (c) pausieren. ~~(b) DailyEquityGuardian~~ ist erledigt + debunked (2026-05-29) → fällt als Option weg. Die DL-Frage ist damit final geschlossen: bei FTMO nicht lösbar, nur via Firm-Wechsel.
- **MTM-intra-bar-Bug** (harness.rs, mtm_equity close-only): real aber klein; macht Backtest leicht optimistisch. Fix-Pfad: intra-bar low/high für DL/TL-Check. Niedrige Prio.
- **reentry/pyramid-Overfit:** Champion-Stack steht auf Live-Phantom. Bei Deploy NUR saubere Templates nutzen (diamond/sharpe_tight) ODER reentry in ftmoLiveEngineV4.ts nachrüsten.
- **/tmp-Audit-Artefakte sind flüchtig** (Reboot löscht sie). Repro-Befehle siehe unten.

## Key files changed

- **KEIN Repo-Code geändert.** Nur:
  - `state/timing-gate.json`, `state/timing-history.jsonl` — Runtime-Artefakte (nicht committen).
  - `scripts/fast_true_seq_screen.py` — war schon vor Session untracked (Florians, vom 2026-05-26).
- **Memory aktualisiert:** `project_audit_2026_05_28_reentry_overfit_engine_clean.md` (7 Befunde, vollständig) + MEMORY.md (Debunk #9 + Index).
- **Flüchtige Repro-Scripts** (in /tmp, überleben Reboot nicht): `rebaseline_step1_stack4.sh`, `dl_tuning_stack4.sh`.

## Repro (falls /tmp geleert)

```bash
# Saubere Stack-4 step=1 Baseline (die 4 fixierten Configs):
# diamond/l1_beta/tp115, sharpe_tight/alt5_beta/votes1, diamond/defi4/votes1, diamond/alt5_beta/tp115
# je P1 (--profit-target 0.10 --max-days 30) + P2 (0.05/60), step=1, --strict-pass --signals regime
# dann: python3 scripts/true_seq_stack_audit.py A=p1,p2 B=.. C=.. D=.. --step-days 1 --phase-gap-days 1
# clean config-pool (kein reentry/pyramid): amber,p2_grinder,p2_defender,bidir_safe,plus_shorts,
#   sharpe_tight,mptp_v04a,scheduled,obsidian,rubin,diamond,shorts_only
```

## Florians emotionaler Stand (wichtig für nächste Session)

Kam frustriert ("der bot ist scheiße"-Stimmung aus Vor-Session). Diese Session hat **Klarheit** geschaffen statt falscher Hoffnung — aber die ehrliche Zahl (27,65 %) ist niedriger als die alten Claims. Geht jetzt off für heute.

- **Nicht pushen, keine pp-Versprechen** ([[feedback-agent-projections-overdeliver-5x]]).
- **Empathisch + ehrlich:** Die Session war produktiv — Engine ist sauber, Problem ist verstanden, Lösung (Firm-Wechsel) ist konkret und billig. Das ist Fortschritt, kein Versagen.
- Wenn er zurückkommt: BrightFunded-Switch ist der naheliegende, motivierende nächste Schritt (echter Test statt noch ein Backtest).
