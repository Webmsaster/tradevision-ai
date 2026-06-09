# Session Handoff — 2026-06-09 PART 3 (Denkfehler-Audit + FTMO-Commodity-Carry: Beweiskette komplett bis auf Total-Return)

Florians /goal: "mach mich mit ftmo profitabel, irgendwo muss ein denkfehler sein, es muss edge geben" — beides bestätigt:

## Denkfehler GEFUNDEN + getestet (commit 4fa86fb)

Edge-Detector bewies nur netto<0, nicht brutto≈0 (Kosten-Artefakt + 1/k²-Zensierung).
Korrektur-Test = Brutto/Netto-Zerlegung via `ftmo-sweep --trades-out` (rawPnl/effPnl),
Stops disabled, 35 disjunkte 30d-Fenster: trend t=-0.14, mr t=-11.5 (NEGATIV),
bidir t=-5.7, mixed-v2 nominal +0.2%/Trade aber Long-Beta-Confound (long t=+4.2/
short t=-0.2, alles 2024). → Alte Zeitreihen-Signale endgültig tot, jetzt brutto-bewiesen.
xsec-Signal auf FTMOs 31 Coins: lebt (S 1.54) aber FTMO-Kosten töten (-9.8/-23.4%/yr).
FX-Carry: Markup frisst Zinsdifferenz (beste Seite +1%/yr). Brutto-Zerlegung = neuer Pflicht-Erstcheck.

## Edge GEFUNDEN: Commodity-Carry via FTMOs eigene Cash-CFD-Swaps (commits ff70e45, efecb96, ce97c9c)

FTMO reicht die Futures-Term-Structure durch die Swaps durch — JEDER Baustein gemessen:

1. Durchreichung: 12/13 Kurven stimmen (USOIL +15.1% vs echte WTI-Kurve +20.2%).
2. Geometrie: `commodity_carry_mc.py` (Block-Bootstrap echter 15y-Renditen, demeaned,
   exakte FTMO-Regeln, no time limit): Prämie 0% → 33% funded (!), 3% → 42%,
   5% → 48%, 8% → 56% — vs 7-12% alte Lotterie. LEVERAGE SCHADET STRIKT (lev 1 optimal).
3. Persistenz: FTMO-API ist in der WAYBACK MACHINE archiviert (3 Snapshots) →
   `ftmo_swap_persistence.py`: Buch-Einkommen +6.0/+5.4/+8.7/+7.7 %/yr über 3,3 Monate,
   7/13 Seiten stabil, Flips ökonomisch (NatGas-Saison). Backfill in swap-history.jsonl.
4. Tooling: `commodity_carry_pilot.py` → fertiger MT5-Order-Plan (heute: 11 Positionen,
   long USOIL/HEATOIL/UKOIL/COFFEE, short NATGAS/COTTON/CORN/COCOA/SUGAR/WHEAT/SOYBEAN,
   7.67%/yr erwartetes Swap-Einkommen; XCU exkludiert bis MT5-Quote verifiziert).

## ➡️ NÄCHSTER SCHRITT (nur Florian kann: persönliche Daten)

1. FTMO **Free Trial** registrieren (gratis, 14d, bucht ECHTE Swaps ins Demo-Statement).
2. `python3 scripts/commodity_carry_pilot.py --capital <Kontogröße>` → 11 Orders abtippen, Hebel-Effekt = keiner nötig (lev 1).
3. Nach 1-2 Wochen: Swap-Gutschriften im Statement vs erwartete ~7%/yr × t prüfen (mache ich).
4. Bestätigt → erste bezahlte Challenge = +EV-Kauf (~42-56% funded, konservativ 3-5% Netto-Prämie nach Spot-Konvergenz, Literatur: Hälfte+ des Carry bleibt). Funded-Account verdient danach WEITER (anders als die alte Lotterie).

## Daueraufgaben (Crons, außerhalb Repo)

03:00 xsec_live.py | 03:15 xsec_executor.py (paper $1k) | 03:30 ftmo_swap_logger.py

Branch gepusht bis ce97c9c. Memory: `project-2026-06-09-ftmo-denkfehler-audit.md`.

---

# Session Handoff — 2026-06-09 PART 2 ("mach mich profitabel": survivorship fix + vehicle decision DONE)

Florian approved the 3-step plan. Steps 1+2 completed this session:

## 1. Survivorship fix ✅ (commit a40212b)

All 145 delisted Binance USDT perps fetched (fapi still serves them; LUNA's -94%
days verified), 78 qualified by objective volume floor, universe 27→105, winsor
±95%. **FUNDING signal survives: net@10bp S 1.02 t 2.33; exchange variant
(price+carry) S 1.41 t 3.23 = 37.6%/yr, only 2022 negative (-9.2%).** Real tails
now visible: worst month 2022-05 -29% (the predicted LUNA hit), maxDD -42%.
XSMOM degrades to diversifier-only (test30 S 0.33). Death-spiral guard (ONE
pre-registered value, no sweep): marginal (S 1.10) — deliberately NOT iterating
guards. 2025/26 strength (+80/+99%) comes from shorting overheated NEW meme
perps (AI16Z/VINE class). Tooling: `scripts/fetch_delisted_perps.py`.

## 2. Vehicle decision ✅ (primary-source research, memory `reference-prop-firm-crypto-holding-costs.md`)

- **FTMO: DEAD** for this signal — swapLong=swapShort=**-30%/yr** on all 31
  crypto CFDs (own symbol API) = ~30%/yr drag on a held 1.0x book; also no meme
  listings, no carry income. (Retro-explains funded-account bleed of the old bot.)
- Breakout Prop: ~12%/yr swap + no API → dead/marginal.
- **HyroTrader: only viable prop** (real Bybit perps via API, no firm swap, real
  funding, 700+ pairs, no position limits) — but 4%-daily/6%-total DD corset
  forces ~1/5-1/7 risk scaling; option for LATER leverage after live validation.
- **Binance/Bybit own capital: the natural first vehicle** (~1-2%/yr costs).

## 3. Next steps (pending Florian: it's his money/account)

1. Build a simple daily-rebalance executor (ccxt, ~150 lines: funding ranking →
   target weights → orders; NOT the MT5 bot) → paper/micro-live €500-1k on
   Binance or Bybit for 4-8 weeks → measure slippage drift (esp. meme perps).
2. If live Sharpe holds: scale own capital, THEN evaluate HyroTrader $100k
   ($579, refundable) as leverage — first confirm via support that their
   challenge env simulates Bybit funding.
3. Expectations (honest): historical 37.6%/yr on 1.0x gross with -28% tail
   months and a flat-to-negative 2022-style regime possible. At €5k → ~€150/mo
   average. First genuinely +EV deployable thing in the project; NOT a lottery.

Branch NOT pushed (113+ ahead). Memory: `project-2026-06-09-xsec-edge-candidate.md`.

---

# Session Handoff — 2026-06-09 (CROSS-SECTIONAL probe: FIRST candidate to survive the debunk checklist)

## What was done

Florian: "ich bin mit keiner ki mehr weiter gekommen, vl schaffst du was." The answer
to WHY nobody got further: the time-series question was conclusively answered (no
edge). The one evidence-backed angle the 06-07 handoff named but nobody ever tested
is CROSS-SECTIONAL (peer-relative) — structurally different information. Tested it.

- **`scripts/xsec_edge_probe.py`** (commit 5400739): engine-free, 27 crypto majors
  daily-resampled from the 30m cache (2020-09→2026-06), dollar-neutral quintile
  long/short, signal at close t → PnL t→t+1, J-T overlapping portfolios, explicit
  bp costs, FULL/train70/test30. Three signals: XS momentum, XS reversal,
  **funding-rate-as-signal** (short crowded longs — funding was only ever modelled
  as a COST here, never as a predictor).
- **`scripts/xsec_robustness.py`**: per-year, 3-fold, cost stress 10/20/30bp,
  long/short leg split, BTC-beta regression, combo.

## Results (net @10bp one-way)

- **XSMOM L14/H7:** Sharpe 0.99 (t 2.26), 3/3 folds positive, test30 S 1.18, beta
  -0.03. Weak spot: **2026 YTD -17%** (decay risk).
- **FUNDING L7/H7 (price-only = CFD-tradeable part):** Sharpe 0.95 (t 2.17),
  **all 6 calendar years positive incl. 2022**, test30 STRONGER (S 1.41),
  consistent across L=3/7/14. Exchange variant with carry income: S 1.35/1.71.
- **COMBO 50/50 (corr -0.10): Sharpe 1.43, t=3.26, maxDD -15.1%, no losing year.**
  Half-risk: +11.3%/yr at -7.8% maxDD — the steadily-rising curve the 05-29 root
  cause proved impossible on the time-series set. Reversal control: clearly negative.

## NOT proof — open before believing/deploying (in order)

1. **Survivorship:** universe = today's survivors; dead coins (LUNA) would have hurt
   the funding LONG leg. Fetch delisted Binance perp data → rerun.
2. **Vehicle:** strategy holds positions permanently → FTMO CFD swap costs unmodelled
   and could eat it; own-capital exchange (earns carry too) may beat prop-firm here.
3. Only then: engine integration / steady_risk_grid / paper trade.

Memory: `project-2026-06-09-xsec-edge-candidate.md`. Branch still NOT pushed (111+ ahead).

---

# Session Handoff — 2026-06-07 (Option A: edge-hunt extended to FOREX + GOLD → still no edge)

## What was done

Florian chose decision-gate option (A) "hunt for genuine edge" ("bau das schnell
mit mehreren agents es muss was geben"). Extended the edge-detector beyond crypto
to forex majors + gold, with multi-agent support (data-quality audit + literature
research ran in parallel).

- **Built 4 measurement-instrument configs** in `engine-rust/ftmo-engine-core/src/templates.rs`
  (NEUTRAL: invert=false, bidirectional, forex/gold costs — NOT deploy configs):
  `v5-forex-neutral-2h`, `v5-forex-neutral-daily`, `v5-gold-neutral-daily`. Reason:
  the debunked `v5-forex-mr-passlock` baked per-asset invert flags that contaminate
  any non-MR `--signals` mode. Daily data needs its own config (`bar_minutes=1440`;
  `--timeframe` only selects the file, doesn't override bar_minutes).
- **Added `--timeframe` passthrough** to `scripts/steady_risk_grid.py` (needed so the
  window-planner uses the right bars/day for daily/2h non-30m data).
- **Built `scripts/tsmom_edge_probe.py`** — engine-free Time-Series-Momentum probe
  (no TP-cap confound). The decisive academic-standard edge test.
- **Fetched real gold data** (`scripts/fetch_gold_daily.py` → PAXG proxy,
  `cache_forex_indices/GOLD_daily.json`, 2110 bars 2020-2026; old GOLD_1h was 86
  broken bars). Gold was the literature's strongest remaining price-only candidate.
- **rustc ICE workaround:** normal `cargo build` ICEs (compiler bug in the diagnostic
  renderer triggered by pre-existing dead-code warnings `cost_bp_for`/`slippage_bp_for`/
  `swap_bp_per_day_for` in templates.rs). Build with `--message-format=short` to avoid it.

## Current state — option A is EMPIRICALLY DEAD (3 convergent lines)

1. **Engine edge-detector:** every forex + gold cell shows the LOTTERY signature
   (pass% max at full risk, →0 as risk drops). forex trend daily P1 19→0 / P2 39→0;
   breakout 10→0; meanrev 0 (treads water); 2h trend 0; gold trend P1 24→0 / P2 54→0.
2. **TSMOM probe (forex daily, drift-removed long+short):** Sharpe ~0.09-0.20 in-sample,
   INVERTS negative OOS, t-stat never significant. The tiny apparent edge is static
   USD drift, not trend.
3. **Literature (cited):** FX trend de-biased Sharpe ~0.05; real edge is cross-sectional
   (20-48 ccy)+carry, not a 6-major price engine; post-pub OOS +0.39→−0.32; asymmetric
   −5%/−10% rule makes pass/fail variance-dominated for any small edge.

**GOLD = least-dead but not a savior:** TSMOM headline 6mo-trend full-Sharpe 0.95 (t=2.22)
is a RECENCY ARTIFACT — train70 Sharpe 0.27 vs test30 2.29 = the 2024-26 parabolic blow-off
(1900→4300), the exact V5_ONYX/V12_30M_OPT_STOCK trap. Honest train-period gold trend Sharpe
~0.2-0.3 (real but too small vs drawdown rule). Edge-detector gate confirms gold falls like
the rest. A single gold-trend stack-leg is more defensible than another crypto config, but
eyes-open on the recency caveat + gold's high vol trips the −5% daily rule.

## Next steps / the honest reframe

- **The lever was never a bigger edge — the GAME is variance-dominated.** Confirms the
  2026-05-29 root cause. Real +EV path = operational/portfolio math (funded-account
  ~break-even-to-positive in operation, profit-banking, cheaper acquisition / fee-refund,
  multi-account stacking), NOT a magic config.
- If Florian still wants to push edge-hunting: the ONLY evidence-backed remaining angles
  are (a) a bigger commodity/index universe for cross-sectional momentum (needs real
  multi-asset data, not 6 majors), (b) carry — but wrong skew for the drawdown rule.
  Honest odds: low. Stop price-only single-/few-asset signal tuning.
- Data: forex audit clean (weekend gaps normal; ~3-6% daily bars have open/close marginally
  outside [low,high] — TSMOM winsorizes so no fake edge leaked).

## Git

- Branch `feature/r28-deploy`, still **NOT pushed** (110+ commits ahead). Session artifacts
  committed locally (configs + 2 probe scripts + gold data + edge-detector `--timeframe`).
  Do NOT push without Florian's go.
- Memory: `project_2026_06_07_forex_gold_no_edge.md`.

---

# Session Handoff — 2026-05-29 (Steady-Strategy Investigation → ROOT CAUSE: no edge)

## What was done

- **Built the edge-detector** (`scripts/steady_risk_grid.py`) and used it to find THE root cause of all 9 debunks + the stuck pass-rate: shrink position size (`--risk-frac-mult`) with no time-limit (`--max-days 240`); pass-rate rising as risk drops = real edge, falling = variance lottery.
- **Proved no signal class has positive expectancy** — trend/meanrev/breakout/regime × diamond/amber-max/obsidian/rubin × both FTMO targets ALL fall as risk drops. Zero-funding control = identical → it's the signal, not carry cost. → a steady never-bust strategy is mathematically impossible on this signal set.
- (Earlier this session, pre-this-finding) DailyEquityGuardian soft-stop (debunked, 0 DL lift); BrightFunded EoD daily-loss modeled → rule-verified → NO advantage over FTMO (caught a +21pp model error); CTI 1-Step modeled → corrected from ~40% to ~5-9% ≈ FTMO (caught a `cpts-trail`-only-blocks-entries error via real `trailing_max_loss` hard bust); first clean train/test OOS validation → baseline HOLDS (not selection- nor design-overfit); sweep parallelism 4→12 jobs (~3×); `fast_oos_search.py` (OOS-protected funnel); executor hardening (equity=None defer, /pause signal-loss).

## Current state

- **Honest deployable numbers (unchanged, now EXPLAINED):** single-account ~7%, Stack-4 ~25% true-seq, funded-EV with +3% banking ≈ break-even. **This ~25% is the variance-lottery ceiling — reached.** No tuning changes the sign of the expectancy.
- Engine forensically clean (05-28 audit); 474 Rust core tests + Python tests green. This is NOT a bug — it's the genuine absence of edge.
- Branch `feature/r28-deploy`: **110 commits ahead of origin, NOT pushed.** Working tree: only runtime state artifacts modified (intentional, do not commit).
- Live-deploy infra ready, but deploying = playing a break-even lottery (no illusion of "steady").

## Next steps

1. **Florian's decision-gate** (strategic + emotional — do NOT push): (A) hunt for genuine edge, (B) accept the lottery and deploy-or-not as break-even, (C) pause/stop.
2. If (A): forex-trend is the candidate but needs a forex-trend config BUILT (only debunked `v5-forex-mr-passlock` exists) + forex window-planning fixed for weekend gaps + run the edge-detector on it FIRST. `meanrev` is the least-bad crypto start (treads water ≈ zero drift, doesn't bleed). Honest odds: low — retail markets are efficient.
3. **Stop all crypto-config tuning** — proven no-edge, exhausted across 92+ templates and now 4 signal classes.

## Open issues / blockers

- The decision is Florian's; he was frustrated earlier — present empathetically, no "+Npp possible" promises.
- Forex window-planning: few windows survive at 2h (data only ~2yr); 10yr daily forex is the better OOS target but needs a daily-tuned config.
- 110 unpushed commits — push when direction is decided.

## Key files changed

- `scripts/steady_risk_grid.py` (NEW) — the edge-detector (risk × max_days grid, fail-reason breakdown).
- `scripts/fast_oos_search.py` (NEW) — OOS-protected funnel config search.
- `engine-rust/ftmo-engine-{core,cli}/src/*` — `trailing_max_loss` hard bust, `daily_loss_eod_hwm`, `intrabar_dd_check`, firm-rule override flags, jobs→12.
- `tools/ftmo_executor.py` + `test_ftmo_executor.py` — equity=None defer, /pause signal-loss fix.
- `HANDOFF.md` + memory `project_2026_05_29_negative_expectancy_root_cause.md` — root-cause documentation.

---

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
