# Session Handoff — 2026-05-28/29 (Forensik-Audit + ehrliche Re-Baseline + DL-Tuning + DailyEquityGuardian)

**Next session: READ THIS + memory `project_audit_2026_05_28_reentry_overfit_engine_clean.md` first.**

## 🔄 2026-05-29 Resume (nach PC-Crash 16:00) — DailyEquityGuardian abgeschlossen

Florians PC war mitten in der DailyEquityGuardian-Implementierung gecrasht. Resume:

- **Code war fertig, nur ungetestet:** `guardian_halted`-Latch (state.rs), force-close+park-for-day (harness.rs), `--daily-equity-guardian <trig>` CLI (sweep.rs). → gebaut, 469+2 Rust-Tests grün, Release-Binary neu.
- **A/B gemessen** (`scripts/guardian_ab_screen.sh`, sauberer Stack-4, step=1 vs 27,65 % Baseline exakt reproduziert): bestes Setting trig 0.015 = **27,08 % (−0,57pp)**, alle anderen Triggers −2 bis −6pp. **KEIN Setting > Baseline.**
- **Mechanismus:** Guardian verschiebt DailyLoss-Fails → TotalLoss-Fails (smoke: 100→32 DL / 3→71 TL), killt Recovery-Tage, schafft keinen Edge. = **3. unabhängige Bestätigung** dass FTMO-DL strukturell nicht weg-tunebar ist.
- **Verdict:** Letzter DL-Hebel abgehakt → ändert nichts an der 2026-05-28-Conclusion. Code bleibt OFF by default, **uncommitted (commit-ready)**. BrightFunded-Switch bleibt der einzige echte Hebel.

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
