# Session Handoff - 2026-05-23

## What was done

Branch `feature/r28-deploy`. Focus: **maximum monthly profit hunt with 4-account user-constraint**, 58 research agents + 8 sweep batches.

1. **Walk-forward +8% Funded-Target** — STABIL bestätigt (IS/OOS split, OOS sogar +3.41pp stärker, +12.7% rel. profit/mo). `f9529ac`
2. **BIDIR + MR + RUBIN_PASSLOCK live wiring** — TF_DISPATCH + CFG_REGISTRY für 3 PASSLOCK Sister-Configs registriert, sonst Boot-Crash. `1b99975`
3. **Orthogonal 3-Stack gemessen** AMBER+BIDIR+MR = **51.96% combined-funded** (TRUE-SEQUENTIAL n=997). `4c9368b`
4. **PM2 ecosystem.orthogonal3stack.config.js + env-5 (BIDIR)** — deploy-bundle für 3-Stack. `609c6c6`
5. **BNB 18/50 Cross-Asset Patch** — V231 live engine wired für `crossAssetFiltersExtra` (vorher gab's nur BTC short-only hardcoded), Filter eingebacken in 4 PASSLOCK Sister-CFGs. `79f13cd` + `698444c`
6. **Stack-4 mit RUBIN_PASSLOCK** = 57.17% (+5.21pp über Stack-3). `c4bd8c3`
7. **Methodologie-Sanity-Check** (W3-25 agent finding): off-by-one in j=i+D korrigiert auf j=i+D+1 → ehrliche Stack-4 = **55.52%** vs vorher 57.17% (-1.65pp). `b177905`
8. **🎯 TITANIUM-Swap: Stack-4 = 59.10% honest** (+3.58pp über RUBIN-Variante, +10.12pp über Stack-3). TITANIUM ist near-orthogonal zu allen 3 anderen (corr_AMBER=-0.014, corr_BIDIR=+0.028, corr_MR=-0.078). `4ef4a1e`
9. **IDLT Intra-Window Kill-Switch DEBUNKED** — alle 5 Thresholds ±0.4pp Rauschen. `05c63e9`
10. **MR-tuning Architectural Finding** — `--mr-*` CLI flags wirken NUR auf `--signals meanrev` path, NICHT auf `--signals regime` (welcher unser Stack verwendet). 7 cells ALLE identisch 498/1023. `839dca7`
11. **Stack-4 Real-Profit-Analysis** — pro 30d-cycle Mean $7,589 (1.90%) auf $400k, Median $0 (40% cycles bank nichts). `98f0137`

## Current state

- **All test suites green:** Rust workspace ✓, TS unit 1257 ✓, typecheck 0.
- **Branch:** `feature/r28-deploy` (NOT pushed yet; PR #71 still references older state — needs new push).
- **Deploy-Ready Champion Stack-4** (max 4 accounts user-constraint):
  - Account 1: V5_AMBER_MAX_PASSLOCK + BNB 18/50 → 32.90% combined-funded
  - Account 3: V5_TITANIUM_PASSLOCK + BNB 18/50 → 21.20% combined-funded
  - Account 4: V5_AMBER_MAX_MR_PASSLOCK + BNB 18/50 → 16.15% combined-funded
  - Account 5: V5_AMBER_MAX_PASSLOCK_BIDIR + BNB 18/50 → 29.79% combined-funded
  - **Stack-4 OR honest: 59.10% combined-funded** (offset=1 strict math)
  - **Profit-Target: +8% (median peak 27.43%/mo Funded-only)**

## Realistic Live Profit-Erwartung auf $400k aggregate

| Modell                                      | $/Monat trader-net | %/Monat      |
| ------------------------------------------- | ------------------ | ------------ |
| Cold-start jeder Monat (konservativ)        | ~$7,500            | 1.9%         |
| Steady-state (continuous operations)        | ~$15-25k           | 3.75-6.25%   |
| Best-case (lucky cluster cycles, p75)       | ~$30-50k           | 7.5-12.5%    |
| Live-realistic 90-Tage-Average (-5pp drift) | **~$10-18k**       | **2.5-4.5%** |

## Next Steps (priority-ordered)

1. **Live-Deploy bei aktuellem Stand** — alles bereit:
   ```bash
   cp .env.ftmo.account-{1,3,4,5}.example .env.ftmo.account-{1,3,4,5}
   # Fill MT5 logins + Telegram tokens
   pm2 start tools/ecosystem.orthogonal4stack.config.js
   pm2 save
   ```
2. **OR: Engine-Work für weiteren Profit-Boost** (User-Entscheidung):
   - **(A) BIDIR-shorts-only Template** (~30min Rust) — Wave-3 W3-21 prognostiziert corr ≤0 mit AMBER → potentieller +3-5pp Stack-4
   - **(B) Forex-MR Template** (~1-1.5d Rust) — Cross-asset-class, Detektor+Daten existieren, nur Template fehlt. Projected Stack-4 → 65-70% combined-funded
3. **Withdraw-cycle Re-Aggregation** (Pure Python, 30min) — HOLD-N cycles vs withdraw-each-bank, untested axis
4. **PR #71 Merge-Entscheidung** auf main (user's call) — Branch hat 13 zusätzliche commits diese Session
5. **Push** zur Origin (current branch ist behind origin/feature/r28-deploy)

## Open Issues / Blockers

- **Keine blocker.** Stack-4 ist deploy-ready.
- **MR ist schwächster Stack-Link bei 16.15%** — strukturell nicht weiter tunbar via CLI (regime-path), nur via engine-work (signals=meanrev path swap oder neue Mean-Rev Source).
- **27.43%/mo Funded-only-median ≠ aggregate %/mo**. 60% der 30d-Cycles produzieren $0 (40% kein Account funded + 60% mit teilweise Funded). Live-realistisch: ~3-4.5%/mo aggregate.
- Pre-existing WIP unangetastet (`.env.ftmo.demo*.example`, `state/*`, `scripts/macro_regime_audit.py`, supervisor scripts).

## Key Findings dieses Session (28 DEBUNKED-Hypothesen)

Alle folgenden Hebel wurden via 58 Agents + Sweeps geprüft und ausgeschlossen:

- Kelly fraction lift (clamped by liveCaps 0.4 cap)
- Pyramid sizing (feature ENTFERNT aus Engine 2026-05-20)
- PTP scaleout +2/+5 (-10.68pp historical)
- DD-Shield / Daily-Equity-Guardian (-10-14pp roadmap-DEFERRED)
- TOD-Filter (-1 bis -8pp prior tests)
- P1/P2 asymmetric tuning (P2 ist REACH-bottleneck, tighter hurt -1.44pp)
- Funding-rate sizing (-5pp prior Phase 11)
- HTF-MACD voter (+0pp overlap mit cross-asset)
- Drop-weakest-assets basket trim (-1 bis -8pp)
- ATR-stop period × mult grid (CLI flag fehlt, prior 35-grid neutral)
- Regime-aware sizing (already implementiert via BTC 9/21 cross-asset)
- Top-trader-LSR voter (engine wiring incomplete)
- vol_confirm voter (Codex-lookahead-fix entlarvte als bug-magic)
- kalman_trend voter (K01 -4.51pp)
- stop_hunt voter (no-op, voter never reaches majority)
- smc_fvg voter (-3.31pp K05; removing fvg gave +0.50pp)
- aroon voter (≥6× getestet, K02 -5.13pp)
- double_top voter (no-op pattern + un-fixed pivot bug)
- squeeze voter (-0.18pp Phase 25 N01)
- breakout signal source (gate blocks AMBER_MAX, no-op)
- multi-cross-asset BTC+BNB (substitutive +0.2pp, not additive)
- Per-asset dynamic hold-bars (flat 12→96 prior sweep)
- maxRiskFrac lift (FTMO-compliance blocker + R28_V7 4 Varianten identisch)
- Stack-5 expansion (max 4 accounts user-constraint)
- News-blackout extension (cache hat keine 2026 FOMC events)
- Trade-rate cap (engine flag fehlt + Cool-Off prior -6pp)
- Stop-pct grid (monotonic harm -8 bis -15pp prior Phase 6)
- Vol-targeting (TS engine 5+ tests neutral/negative)
- Funded-specific config (Kelly axis null + edge front-loaded)
- AMBER per-asset TP override (Phase 15 Hunt 41 alle hurt)
- TITANIUM_5m timeframe (6× noise inflation risk)
- Quartz engine stack as 4th (-8pp prior Wave 5)
- V12_TURBO Rust port (0% pass-rate under liveCaps)
- IDLT intra-window kill-switch (±0.4pp Rauschen)
- MR-tuning grid (CLI no-op auf regime-path)
- Max-days × TP grid (max-days neutral, pt>0.10 collapse)

**Tight local optimum bestätigt: AMBER_MAX_PASSLOCK + V02 5-Voter + BNB 18/50 + +8% TP + Kelly 0.5/60/20 + Stack-4 mit TITANIUM ist der ehrliche Engine-Current-Ceiling.**

## Resume

- Full detail in this commit chain: `f9529ac` → `98f0137` (13 commits this session).
- Branch: `feature/r28-deploy`. PR #71 (needs push for new commits).
- Hunt data: `scripts/cache_bakeoff/wave3_4thmember/`, `scripts/cache_bakeoff/stack3_bidir_mr/`, `scripts/cache_bakeoff/stack4_rubin/`, `scripts/cache_bakeoff/mr_tuning_2026_05_23/`, `scripts/cache_bakeoff/funded_target_grid/`, `scripts/cache_bakeoff/wave1_runs_2026_05_23/` (all gitignored).
- Live-Deploy: `tools/ecosystem.orthogonal4stack.config.js`. Pre-deploy checklist in header.
