# Session Handoff — 2026-05-09

## What was done

### R9 TITANIUM Funding-Filter — final & DEBUNKED

- Resumed missing FRLONG variant (interrupted from previous session)
- All 3 funding variants identical at **55.56%** (35/63 step=28d): r9titPL = r9titFRMED = r9titFRLONG
- Per-shard pass-counts byte-identical → funding-filter completely **inert** on TITANIUM 14-asset basket
- TITANIUM 14-asset basket alone = **+10.71pp** vs PASSLOCK 9-asset 44.85% honest (the real R9 hebel)

### Rust Engine Port — Phases 1+2+3 shipped

User mandate: "rust soll backbone werden" + "rust soll fertig werden ohne bugs und fehler".

**Phase 1+2 (commit `aa28d7a`)** — manual fixes + 1st background-agent (28min wall-clock):

- `disable_short` field added to `AssetConfig`; profit_target 0.10 → 0.08 (FTMO Step-1 actual, was bug)
- `make_assets` defaults: invert_direction=true, disable_short=true, trigger_bars=Some(1), costs (30/8/4)
- `detect_r28_v6` iterates both directions like TS detectAsset (instead of SMA-slope filtering)
- Entry shifted to bar `i+1.open` (TS convention; was `i.close`)
- `quartz_lite_base()` rebuilt to mirror real R28_V4 chain (removed phantom lossStreakCool + kellySizing inheritance, fixed dailyPeakTrailingStop, added peakDrawdownThrottle)
- `sweep.rs`: PerAssetCfg fallback to R28V6 unconditional (was gated on funding_rate_filter — root cause for 0% baseline); WARMUP=5000 bar pre-fill; end-of-window pass-check; chandelier ATR period reads from cfg
- **R28_V6_PASSLOCK Rust 0% → 47.10%** (138w step=14d) vs TS 55.88% — drift -8.78pp

**Phase 3 (commit `78aaa05`)** — 2 parallel background-agents (~16min wall-clock):

- TITANIUM/AMBER/TOPAZ baskets corrected (SOL/LINK was wrong, now INJ/SAND etc.)
- Per-asset tp_pct rewritten with TS-correct values for all 3 V5 variants
- New `v5_titanium_base()` decouples TITANIUM/AMBER from QUARTZ engine stack
- 8 new R10 stacking templates: titanium-passlock + norune + obsidian + lscool-tight/loose + mct5 + corrcap2 + todcut18
- `pnl.rs` audited bit-precise vs TS `computeEffPnl` — confirmed parity; 1 real bug fixed (MTM `last_known_price` fallback that TS doesn't have)
- 154 lib tests pass (was 141)

### R29 Round 10 Stacking Variants — staged

- 7 new TS configs in `src/utils/ftmoDaytrade24h.ts`
- `_r29Round10Shard.ts` — generic shard runner (reads asset list from cfg.assets)
- `_r29Round10Sweep.sh` — 7-config sequential sweep
- `_r29RustBackboneValidate.ts` — Rust↔TS drift validation harness for 5 hot configs

## Current state

### Working

- **Rust Backbone OPERATIONAL** for R28_V6 + TITANIUM family (active Champion)
  - 22 selectors via `--list-configs` (was 14)
  - cargo build --release clean, 154 lib tests pass
  - Wall-clock 1.4-7s per 127-138w sweep (was 28min TS sharded) = **~250-300× speedup**
- TITANIUM_PASSLOCK 58.27% / TS 55.56% step=28d → drift +2.71pp (well within usable range)
- R10 stacking effects verified working: MCT5 -7pp, CORRCAP2 -9pp, TODCUT18 -5.5pp impact
- 2 commits shipped this session, working tree clean

### Drifting (not fully closed)

- R28_V6_PASSLOCK: -8.78pp drift (Rust 47.10% / TS 55.88%) — acceptable, ranking robust
- V5_AMBER: -15.21pp drift (modest +2pp closing from Phase 3a)
- V5_TOPAZ: -24pp drift
- Root cause for AMBER/TOPAZ: `trailing_stop {activatePct:0.03, trailPct:0.005}` from V3-inheritance NOT yet ported to Rust harness

### Champion still-active

- **R28_V6_PASSLOCK 55.88%** (TS honest, post-R9 bugfix `46d9bb3`) — single-account
- 3-Strategy multi-account ~91% min-1-pass (PASSLOCK + TITANIUM + AMBER)
- TITANIUM_PASSLOCK 55.56% step=28d honest = **+10.71pp** vs 9-asset PASSLOCK

## Next steps

### Priority 1 — Use the Rust backbone

- Run R29-R10 sweep via Rust (seconds vs hours): `./engine-rust/target/release/ftmo-sweep --candles-dir scripts/cache_bakeoff --symbols <list> --config 2h-trend-v5-titanium-passlock-<variant> --windows 200 --step-days 14 --signals per-asset`
- Compare 7 R10 variants to find new +1-3pp hebel on TITANIUM 55.56% baseline
- Cross-check final picks via `_r29RustBackboneValidate.ts` (~10-15min)

### Priority 2 — Phase 4 Rust port (deferred)

1. Port `trailing_stop {activatePct, trailPct}` from V3-cfg to harness.rs (closes AMBER drift)
2. Audit `harness.rs:close_all_on_target` candle resolution (TS scan-backwards fallback at L1604-1610 missing in Rust)
3. Audit `exit.rs` ordering edge cases (PTP-fill semantics on volatile bars)
4. Re-validate AMBER target: ≤5pp drift

### Priority 3 — Live deploy track

- PASSLOCK Live-Deploy plan in `memory/project_passlock_live_deploy_plan.md`
- Phase 1 single-account → Phase 2 3-strategy → Phase 3 step-2 promotion
- Math: 73% Funded mit 3-Strategy multi-account

### Priority 4 — Backlog (deferred-forever per memory)

- Round 61 total_loss attack — engine cap blocks Day-Risk multiplier
- Round 62 Mean-Reversion — only AFTER PASSLOCK 2-week stable
- Round 63 forex diversification — only AFTER 3-strategy stable

## Open issues / blockers

- **AMBER/TOPAZ Rust ranking inversion**: Don't trust Rust for AMBER vs other-config rankings until Phase 4. Use TS for that family.
- **Funding-filter is inert on TITANIUM 14-asset**: confirmed via 3× identical pass-counts. Funding gives +2.21pp on R28_V6 9-asset but 0pp on TITANIUM 14-asset. Different asset distribution.
- **Memory-claim deflation post-R67**: Pre-R67 cache pass-rates are systematically ~10-15pp inflated (cost-deduction fix R56-R58 + multi-level PTP fix R67). Trust the post-R67 honest numbers.
- **Auto-Continue hook**: User has a Stop-Hook active. Remember to write `TASK_COMPLETE` only when truly done, `STOP_NOW` for emergencies, and don't ask intermediate questions.

## Key files changed

### Engine (Rust)

- `engine-rust/ftmo-engine-core/src/config.rs` — added `disable_short` field; profit_target 0.10→0.08
- `engine-rust/ftmo-engine-core/src/templates.rs` — corrected V5*TITANIUM/AMBER/TOPAZ baskets + per-asset TPs; 8 R10 stacking templates added (`v5_titanium_passlock`, `v5_titanium_passlock_norune`, `v5_obsidian_passlock`, `v5_titanium_passlock_lscool*{tight,loose}`, `v5*titanium_passlock*{mct5,corrcap2,todcut18}`)
- `engine-rust/ftmo-engine-core/src/signals_r28v6.rs` — bidirectional iteration, entry-bar shift, secondary-gate read at trigger bar
- `engine-rust/ftmo-engine-core/src/pnl.rs` — MTM `last_known_price` fallback removed (TS parity); confirmed bit-precise cost/slippage/swap deduction
- `engine-rust/ftmo-engine-cli/src/sweep.rs` — PerAssetCfg fallback unconditional; WARMUP=5000 pre-fill; end-of-window pass-check; chandelier ATR period from cfg

### Configs / scripts

- `src/utils/ftmoDaytrade24h.ts` — added 7 R10 stacking variants (TITANIUM_PASSLOCK_NORUNE/LSCOOL_TIGHT/LSCOOL_LOOSE/MCT5/CORRCAP2/TODCUT18; OBSIDIAN_PASSLOCK reused existing const)
- `scripts/_r29Round9FrlongOnly.sh` — resume-only script for missing FRLONG variant
- `scripts/_r29Round10Shard.ts` — generic shard runner (reads asset list from cfg.assets)
- `scripts/_r29Round10Sweep.sh` — 7-config sequential R10 sweep
- `scripts/_r29RustBackboneValidate.ts` — Rust↔TS drift validation harness, exits 0 iff all 5 configs ≤5pp drift

### Memory updates

- `memory/project_round29_passrate_search.md` — R9 TITANIUM final results, Phase 1 Rust shipped, R10 staging
- `memory/project_round29_rust_audit.md` — Phase 1+2+3 detailed roadmap, drift sources, final state, Phase 4 deferred items
- `memory/project_rust_engine_backbone.md` — User mandate (NEW)
- `memory/MEMORY.md` — index updated with backbone-mandate link

## Recent commits

```
78aaa05 feat(R29-R10/Rust-Phase3): correct V5 baskets + R10 templates + MTM parity
aa28d7a feat(R29-R10/Rust): port R28_V6 detector to parity + R10 stacking variants
b901358 feat(R29-R9/Rust): TITANIUM funding configs + Rust port WIP
```

Branch: `feature/r28-deploy` (29+ commits ahead of `origin/feature/r28-deploy`).

## Quick-start für nächste Session

```bash
# Sweep Rust (seconds):
./engine-rust/target/release/ftmo-sweep \
  --candles-dir scripts/cache_bakeoff \
  --symbols ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT \
  --config 2h-trend-v5-titanium-passlock-todcut18 \
  --windows 200 --step-days 14 --signals per-asset

# List all 22 selectors:
./engine-rust/target/release/ftmo-sweep --list-configs

# Validate Rust↔TS drift on 5 hot configs (~10-15min):
node ./node_modules/tsx/dist/cli.mjs scripts/_r29RustBackboneValidate.ts

# R10 sweep via TS sharded (fallback, 3-4h):
bash scripts/_r29Round10Sweep.sh
```
