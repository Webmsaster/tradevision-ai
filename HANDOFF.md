# Session Handoff — 2026-05-25 (Wave5 Engine-Refactor + Honest Ceiling)

**Next session: READ THIS FIRST + `docs/PHASE_ADAPTIVE_STACK4_DEPLOY_PLAN.md` before any work.**

## TL;DR

- **Stack-4 ceiling = 44.01% OOS HONEST** (post-MTM-DL bug fix, 92-template GA, 10 seeds)
- **65+ commits this session** on `feature/r28-deploy`, NOT pushed
- **Live-deploy infrastructure READY** (supervisor + PM2 + .env.ftmo.A/B/C/D.example + audit-hardened)
- **Decision-Gate ungestellt:** Florian off, frustrated. Don't push.
- **Empirisch validiert:** Stack-4 architectural ceiling ≈ 43-44% OOS. >50% braucht paid data oder Prop-Firm switch.

## Florian's emotional State (wichtig)

Quote: "der bot ist scheiße omg, so viel arbeit und dann nichts" → "alles comittet?" → "ich gehe off für heute".

Erwartung war $20k/mo, ehrlich ist $5-7k/mo Y2 Steady-State. Frustration ist real und valid. Wenn er zurückkommt:

- **Nicht pushen.** Keine "wir können noch +5pp" Versprechungen — Pattern: agent projections delivered 1/5 of claimed lift consistently.
- **Empathisch + ehrlich.** Bot ist objektiv 6× besser als FTMO retail-average (7%). Nicht "Lifestyle-replace" aber realer Edge.
- **Optionen offen lassen.** Deploy / Pause / Prop-firm switch — alle drei sind valid.

## Was diese Session geliefert hat

### Code (65+ commits, alle committed außer state-files)

- 26 KRIT bugs aus 30+-agent Wave5 audit gefixt
- **MTM-DL bug** in `harness.rs` — equity-DL musste MIN(equity, mtm_equity) checken (FTMO server enforces every tick). War realised-only → -26 bis -29pp inflation auf alle prior pass-rate claims.
- 2 new voters: `signals_funding_accel.rs` (235 LOC + 7 tests) + `signals_btcd_proxy.rs` (193 LOC + 6 tests) — beide lookahead-safe
- 15+ templates: 7 forex-MR variants, 5 intraday hour variants, 3 5m bar templates, AMBER parameter-overrides, basket-subsets, obsidian-override
- Phase-Switch Supervisor + PM2 ecosystem (.env.ftmo.A/B/C/D.example templates)
- TS-mirrors für SHORTS_AGG, RISK05, RISK06
- 581 Rust tests + 245 Python tests grün

### Research / Validation (alles empirisch geprüft, kein Hypothese)

- 12 Edge-Class Research Agents — alle Tier-3/4
- 92+ Templates im W5 GA pool — Stack-4 ceiling 44% bestätigt
- **Forex-MR (7 variants):** 0-2% P1 — DEAD
- **Intraday hour restrictions (5 variants):** 0pp Stack-lift
- **5m bars (Path B):** 18-21% P1, 27-30% P2 — 5-8pp WORSE als 30m
- **9 truly-untested templates** (amber_plus_shorts, bidir_safe, mptp, diamond, aggressive-24h): 6 dead, 3 baseline
- **News/Wyckoff/VWAP/spread/funding-spike:** alle low-ROI or impossible
- **MT5 latency** (100-500ms) macht HFT-edges strukturell unmöglich auf FTMO

### Brutally honest findings (gegen prior overstatements)

- 97.28% Stack-4 claim WAS BUG-INFLATED (MTM-DL + andere)
- Real ceiling = **44.01% OOS** mit current crypto-trend architecture
- Über 50% nur mit paid data (Coinglass OI $50/mo, Hyblock $200/mo)
- Industry FTMO average = 7%, our bot = 6× besser — aber nicht $20k/mo

## Honest Live-Realistic Math

| Metric                      | Wert       |
| --------------------------- | ---------- |
| Backtest Stack-4 OOS        | 44.01%     |
| Live-realistic (-5pp drift) | ~38-40%    |
| E[funded per cycle]         | ~0.5       |
| Cycle cost (4× $300)        | $1,200     |
| E[Y1 NET]                   | +$24k      |
| Y2+ Steady State            | $5.5-6k/mo |
| P(Y1 profitable)            | 86%        |
| Worst-case loss             | -$4,800    |

## Wave5 GA Best Stack-4 Config (latest seed run, 44.01% OOS)

| Account | P1 Template                                 | P2 Template                                  |
| ------- | ------------------------------------------- | -------------------------------------------- |
| A       | `agg-kr-tight-stop`                         | `agg-kr-low-tp`                              |
| B       | `mixed-v4-cvd-only`                         | `mixed-v2`                                   |
| C       | `basket-AAVEUSDT_ADAUSDT_ARB` (8 alt-coins) | `mixed-v4-cvd-only`                          |
| D       | `mixed-v2`                                  | `obsidian-passlock-or2-tp05_s005` (override) |

**GA variance ±0.5pp zwischen seed runs.** Multiple "best" configs gefunden in 43-44%. Bei Deploy: fresh GA-run.

Honest cross-check (5 seeds independently converged):
| Account | P1 | P2 |
|---|---|---|
| A | `mixed-v4-cvd-only` | `mixed-v2` |
| B | `mixed-v2` | `obsidian` |
| C | `agg-kr-combo` | `agg-kr-low-tp` |
| D | `obsidian` | `mixed-v4-cvd-only` |

## Was Florian noch entscheiden muss

### Option A: Live-Deploy via FTMO Free Trial (recommended cost: $0)

1. FTMO Free Trial deploy (gratis, 2-4 Wochen)
2. Live-drift messen vs 44% backtest
3. If Live ≥35% → Stack-4 commit ($1200)
4. If Live <30% → switch to Option B oder C

### Option B: Prop-Firm Switch (zero code, biggest upside)

- The5%ers (6%/4% rules), E8 Funding, FundedNext — alle softer als FTMO
- Same bot bei besseren Regeln = potentially 2-3× pass-rate
- **Research-aufgabe:** pricing + crypto-CFD spreads bei diesen Firms

### Option C: Pause / Quit

- 60+ commits = wertvolles Wissen bleibt
- Bot bleibt deploy-ready für später

### Option D: Paid Data (uncertain ROI)

- Coinglass API $50-100/mo → historical OI backtest
- Hyblock $200/mo → liquidation heatmap
- Only path to >50% ceiling, but uncertain

## Was NICHT mehr versuchen (alle empirisch debunked)

- ❌ Forex-MR template variants (alle 0-2%)
- ❌ 5m bars (worse than 30m)
- ❌ Intraday hour restrictions (0pp lift)
- ❌ Multi-TF confluence
- ❌ Wyckoff template
- ❌ Funding-spike trading
- ❌ Any "+5-10pp easy lift" claim
- ❌ Order-book HFT edges (FTMO MT5 latency inkompatibel)

## Memory Files für Recall

Schlüssel-Memories für next-session warm-start:

- `project_session_2026_05_25_phase_adaptive_stack4.md` (bug-inflated 97% claims, archived)
- `project_session_2026_05_25_wave5_engine_refactor_final.md` (this session, NEW)
- `project_session_2026_05_25_wave5_honest_baseline.md` (Wave5 MTM-DL bug-fix round)
- `feedback_agent_projections_overdeliver_5x.md` (agent projection-lift pattern)

## Branch State

```
Branch: feature/r28-deploy
Commits ahead of main: 60+ (this session) + ~31 from prior
NOT pushed to origin (pending Florian decision)
Build: clean
Tests: 581 Rust + 245 Python green
```

## Pending Background Tasks

Keine. Alle sweeps + GAs complete.

## Untracked / Modified Files (runtime artifacts, NICHT committen)

```
state/timing-gate.json        # runtime monitoring state
state/timing-history.jsonl    # runtime timing log
```

Diese sind runtime artifacts — sollten in `.gitignore` aber sind's nicht.
**Don't commit them** — change every run.

Plus pre-existing uncommitted vor session-start (unrelated zu Wave5):

```
.env.ftmo.demo1.example, .env.ftmo.step2.example
scripts/cache_bakeoff/step1_holdbars/{hb48.jsonl, results.tsv}
scripts/calendar_combined_test.py, scripts/ftmo_timing_supervisor.py
scripts/macro_regime_audit.py, scripts/real_funded_prob.py
scripts/timing_supervisor_robustness_test.py, scripts/timing_supervisor_setup.md
tools/README-ftmo-bot.md, tools/ecosystem.config.js
tools/promote_to_step2.sh, tools/signal_tracker_mode.py
plus 9× scripts/_*.sh hunt scripts (untracked)
plus state-backups/ (untracked)
plus tools/ftmo-state-2h-trend-v5-amber-max-passlock/ (untracked, runtime)
```

## Deploy-Steps (wenn Florian "go" sagt)

1. **Fill .env files** mit echten MT5 logins:

   ```bash
   cp .env.ftmo.account-A.example .env.ftmo.account-A
   # repeat B, C, D — edit jeden mit FTMO_LOGIN, FTMO_PASSWORD, FTMO_SERVER, TELEGRAM_BOT_TOKEN_X
   ```

2. **Optional aber empfohlen:** Free Trial first

   ```bash
   # FTMO_FREE_TRIAL=1 in env (no real money)
   pm2 start tools/ecosystem.phase_adaptive4stack.config.js
   pm2 logs phase-A  # monitor
   ```

3. **Real deploy:**

   ```bash
   pm2 start tools/ecosystem.phase_adaptive4stack.config.js
   pm2 save && pm2 startup
   ```

4. **Monitoring:** Check `ftmo-state-supervisor-X/supervisor.jsonl` täglich.

## ⚠️ Bekannte TS↔Rust Drifts (live-deploy known issues)

- **`reentryAfterStop` engine-only in Rust.** TS V4 (`src/utils/ftmoLiveEngineV4.ts`) implementiert es NICHT.
  - Impact: ~3-8pp pass-rate drift auf SHORTS_AGG live vs Rust backtest
  - Fix-Pfad (deferred): `ftmoLiveEngineV4.ts` reentry-after-stop handler + parity test
- `agg-kr-hold120`, `agg-kr-chandelier` möglicherweise engine-only — verify executor bei deploy

## Don't do without Florian's go

- Push to origin
- Modify .env files (real secrets)
- Start sweeps that cost money (paid APIs)
- Auto-retry destructive operations
- Build more "+5pp lift" experiments — diminishing returns confirmed

## Was WÄRE useful (if Florian comes back motivated)

1. **Prop-Firm comparison research** (The5%ers / E8 / FundedNext) — pricing, rules, crypto-CFD support — 2-4h
2. **Cycle-Adaptive Stack-4 cron** — auto-refresh config monthly — ~1d
3. **Coinglass OI integration** — only path to >50% ceiling — needs $50/mo decision first
4. **Live-drift dashboard** — visualize backtest-vs-live realtime
5. **TS↔Rust reentryAfterStop parity** — closes ~3-8pp drift on SHORTS_AGG

Sonst: respect the pause. Don't push.
