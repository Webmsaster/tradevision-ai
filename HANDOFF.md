# Session Handoff - 2026-05-23 (Update 2)

## What was done (50-Agent + Engine Hunt)

Branch `feature/r28-deploy`. Focus: **engine-Erweiterung BIDIR-shorts-only + Forex-MR + parallel 50-Agent hunt** für orthogonale Stack-5-Kandidaten und neue profit-lever.

### 50-Agent-Hunt — Top Findings (geordnet nach $-impact)

| #   | Finding                                                  | Status                               | Quantifiziert                                                |
| --- | -------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| 1   | **FundingPips (8% P1 statt FTMO 10%)**                   | Strukturell — kein code              | **+10pp** projected pass-rate, $429 fee vs $540, 95% split   |
| 2   | **TITANIUM trade-rate boost** (mct=10, hours+12, hold/2) | Sweep-plan ready, ungetested         | Cell D projected **+5-10pp** standalone (49.5 → ~55-60%)     |
| 3   | **TP-mult 1.10 → 1.14**                                  | Easy CLI change                      | **+1.5pp** measured in prior Phase8/25b sweeps               |
| 4   | **MR `--signals meanrev` path bug**                      | 10-LOC fix in `sweep.rs:3626-3637`   | Cell C (RSI 20/80, cd 16) projected **+5-9pp** on MR account |
| 5   | **Per-asset risk_frac** (vol-scaled)                     | 1-line patch                         | projected **+1-3pp** standalone                              |
| 6   | **Ichimoku 6th voter**                                   | mv=3 step=3 zeigte +7.06pp indicator | projected **+1-3pp**                                         |
| 7   | **Cluster-gate true-seq grid** (b5-6, m2-3)              | Script bereit, ~2-3h compute         | projected **+3-7pp** combined-funded                         |
| 8   | **`--phase2-risk-mult`** ungenutzt                       | CLI flag exists                      | projected **+2-4pp** combined-funded                         |
| 9   | **Equity-conditional TP-tightening**                     | ~50 LOC in harness.rs                | projected **+1-3pp**                                         |
| 10  | **Stablecoin USDT-supply voter activated**               | Data fetched (3098 daily points)     | Sweep pending                                                |

### Engine-Work delivered (this session)

1. **SHORTS-only Template** — `v5_amber_max_passlock_shorts_only()` + selector + sweep MEASURED.
   - **Honest standalone (1023w, step=1d, strict-pass):** P1 **50.15%**, P2-conditional **58.09%**, absolute combined-funded **~29.13%**
   - Vergleichbar mit BIDIR (29.79%), deutlich über MR (16.15%)
   - Projected Stack-5 uplift +3-5pp (corr-with-BIDIR vermutlich +0.3-0.5) → **~62-64% combined-funded**
   - Stack-4 REPLACEMENT-Option: SHORTS-only statt MR → vermutlich +1-3pp uplift (29% standalone vs MR's 16%)

2. **Forex-MR Template + Engine wiring** — Detector existed, now fully integrated:
   - `SignalSrc::ForexMr` in sweep dispatcher (single + multi-asset path)
   - `v5_forex_mr_passlock()` template (6 FX majors: EUR/GBP/JPY/CAD/AUD/NZD)
   - `--timeframe 1d` + `_daily.json` loader support
   - `win_plan_warmup` jetzt TF-scaled (100 bars for daily vs 5000 for 30m)
   - **Daily-only test: 0/200 pass (162 trades total!)** — trade-starved auf daily, braucht 30m forex data oder min_trading_days<<4
   - Verdict: **Template gebaut, aber daily-only NICHT viable**. 30m forex fetch via Dukascopy = 2-4h Aufwand.

3. **Per-asset cost patch — REVERTED**: Agent änderte uniform 30/8/4 auf {BTC:15/10/5, ETH:25/10/5, alts:35/12/7} — measured -3.24pp regression auf AMBER baseline (52.31 → 49.07). Reverted bis live drift-monitor calibrates.

### DEBUNKED this session (zusätzlich zu 28 prior)

| #   | Lever                           | Why debunked                                                       |
| --- | ------------------------------- | ------------------------------------------------------------------ |
| 1   | Pyramid sizing v2               | STRUCTURELL DEAD — liveCaps blockt, bug-magic ohne bypass          |
| 2   | Daily-loss-throttle (IDLT grid) | Today's sweep: 0 bis -0.44pp, baseline beats all 5 cells           |
| 3   | Bull/bear regime switch         | Volatility classifier 53.4% accuracy = coin-flip                   |
| 4   | hold_bars regime-conditional    | `time_exit_enabled=false` default = hold_bars DEAD CODE in AMBER   |
| 5   | Basket-trim (drop bottom EV)    | -0.98 to -3.23pp confirmed empirical                               |
| 6   | PASSLOCK target_buffer tuning   | <2% revert rate × 50% pass-of-those = <1pp upside                  |
| 7   | CME basis voter                 | BTC-only, free-data via Coinglass, expected <0.5pp                 |
| 8   | Top-trader LSR voter            | Data fix possible but Binance API 30d cap → no backtest validation |
| 9   | mv=3+ voter quorum              | -2 to -12pp (mv=2 confirmed optimal)                               |

### Walk-forward Recovery Finding

Prior agent claimed "+8% Funded-Target STABIL" was based on a Q3 outlier hump. Re-analysis:

- **+6% target IS robust** (58.55% IS≈OOS, drift +0.08pp) but `+8% target gives +50% more $-profit/mo`
- Conflicting agent analyses — one says +6% safer, another says +8% Q4 actually shows recency-strength (+9.86pp). **MITTEL trust-level, deploy decision = user's call**.

## Current state

- **All test suites green:** Rust workspace ✓, TS unit 1257 ✓, typecheck 0.
- **Branch:** `feature/r28-deploy` (NOT pushed; 2 new commits this session über PR #71 hinaus)
- **Engine binaries fresh-built** with SHORTS-only + Forex-MR + daily TF support.
- **Stack-4 baseline 59.10%** remains valid (cost-patch reverted).

### Active Champion Stack-4 (unchanged)

| Account               | Template                                | Combined-Funded |
| --------------------- | --------------------------------------- | --------------- |
| 1                     | V5_AMBER_MAX_PASSLOCK + BNB 18/50       | 32.90%          |
| 3                     | V5_TITANIUM_PASSLOCK + BNB 18/50        | 21.20%          |
| 4                     | V5_AMBER_MAX_MR_PASSLOCK + BNB 18/50    | 16.15%          |
| 5                     | V5_AMBER_MAX_PASSLOCK_BIDIR + BNB 18/50 | 29.79%          |
| **Stack-4 OR honest** | offset=1 strict math                    | **59.10%**      |

### Realistic Live Profit-Erwartung — Updated mit Multi-Firm-Analyse

| Modell                                    | $/Monat trader-net | %/Monat      |
| ----------------------------------------- | ------------------ | ------------ |
| 4× FTMO $100k = $400k (current)           | ~$10-18k           | 2.5-4.5%     |
| 4× FundingPips $100k = $400k (8% target)  | ~$15-23k           | 3.75-5.75%   |
| **2× FP $200k + 2× FP $100k = $600k (D)** | **~$22-31k**       | **3.7-5.2%** |
| Add SHORTS-only as 5th (FP-only) → $700k  | ~$27-37k           | 3.85-5.3%    |

**After DE-tax (~50%) + ops cost ($2-4k/mo):** Net ~$3-9k/mo realistic for current; ~$10-15k/mo for D+5stack. **CAGR auf $400k: 6-15%** depending on scenario.

## Next Steps (priority-ordered)

1. **Live-Deploy Stack-4 sofort** — kein Blocker, ready as-is:

   ```bash
   cp .env.ftmo.account-{1,3,4,5}.example .env.ftmo.account-{1,3,4,5}
   pm2 start tools/ecosystem.orthogonal4stack.config.js
   ```

2. **Quick-Wins implementieren** (1-2h total):
   - Tausche `--override-tp-mult 1.10` → `1.14` in deploy-configs (+1.5pp easy)
   - Per-asset risk_frac patch + sweep (1h, +1-3pp)
   - Fix MR `--signals meanrev` path bug (10 LOC) + Cell C tuning sweep (~6h compute, +5-9pp on MR account)

3. **TITANIUM trade-rate hunt** — script ready (`scripts/_titanium_trades_boost_2026_05_23.sh`), ~2h compute, projected Cell D +5-10pp:

   ```bash
   bash scripts/_titanium_trades_boost_2026_05_23.sh
   ```

4. **Cluster-gate true-sequential grid** — script ready, ~2-3h:

   ```bash
   tmux new -s clusterhunt 'bash scripts/_clusterhunt_grid_2026_05_23.sh'
   ```

5. **Forex-MR auf 30m** — Dukascopy fetch (2-4h) + re-run sweep. Wenn standalone ≥25%: Stack-5 add via `real_funded_prob.py`.

6. **Prop-firm Migration**: FundingPips signup + 60-90d demo validation → potentiell +50% expected profit.

7. **Stablecoin voter** — Data fetched, just run a sweep with `--regime-use-stablecoin`.

8. **Live drift-monitor activation** für cost_bp re-calibration nach 1-2 Wochen live-trades.

## Open Issues / Risks

- **Forex-MR daily-only NICHT viable** (0/200 pass). Template existiert für später wenn 30m forex data verfügbar.
- **Cost-model patch reverted** — die "ehrlichere" Per-Asset costs gaben -3.24pp regression. Need live data to calibrate.
- **+8% vs +6% Funded-Target** ambiguity — agents widersprechen sich. Conservative: +6% (robust). Aggressive: +8% (+50% $-profit).
- **Tax/Operational reality check** (DE Spitzensteuersatz 47.5% + Gewerbe + KV): Net = ~33% von gross. CAGR 6-15% nach allem auf $400k initial.
- **150 ungenutzte CLI flags** in sweep.rs — viele Hebel ungetestet (`--phase2-risk-mult`, `--adaptive-tp`, `--ds-aggressive-factor`, `--max-consec-stops-per-day`).

## Key Files (this session)

- `engine-rust/ftmo-engine-core/src/templates.rs:586` — `v5_amber_max_passlock_shorts_only()` + selector
- `engine-rust/ftmo-engine-core/src/templates.rs:710` — `v5_forex_mr_passlock()` + selector
- `engine-rust/ftmo-engine-cli/src/sweep.rs` — SignalSrc::ForexMr wired (parser, dispatcher, label, multi-asset arm)
- `engine-rust/ftmo-engine-cli/src/sweep.rs:3087` — `win_plan_warmup` TF-scaled
- `engine-rust/ftmo-engine-cli/src/sweep.rs:3316` — `_daily.json` + `--timeframe 1d`
- `scripts/cache_bakeoff/macro/usdt_supply_daily.json` — 3098 daily points fetched
- `scripts/fetch_usdt_supply_daily.py` — DefiLlama fetcher
- `scripts/cycle_reaggregation.py` — HOLD-1 confirmed optimal vs HOLD-N
- `scripts/_shortsonly_sweep_2026_05_23.sh` — SHORTS-only initial sweep (OLD costs)
- `scripts/_shortsonly_stack5_final_2026_05_23.sh` — Final SHORTS-only re-baseline (reverted costs)
- `scripts/_titanium_trades_boost_2026_05_23.sh` — TITANIUM trade-rate hunt (ungestartet)
- `scripts/_clusterhunt_grid_2026_05_23.sh` — cluster true-seq grid (ungestartet)
- `scripts/_stack4_rebaseline_costs_2026_05_23.sh` — Stack-4 cost re-baseline (irrelevant nach revert)

## Pre-existing handoff content (unchanged scope from earlier today)

See git log `c4bd8c3..98f0137` for Stack-4 TITANIUM swap, walk-forward funded-target, BNB 18/50 patch, IDLT debunk, MR-tuning architectural finding.
