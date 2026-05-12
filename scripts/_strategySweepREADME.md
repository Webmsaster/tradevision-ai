# Strategie-Innovation Sweep Suite

5 sweep scripts that probe different angles of pass-rate improvement
beyond the R28_V6_PASSLOCK baseline. All are designed to run on the
existing `scripts/cache_bakeoff/*.json` 30m candle cache.

| Script                                          | Hypothesis                                                       | Expected outcome                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `_assetExpansionSweep.ts`                       | More uncorrelated assets → higher pass-rate                      | +1-3pp per added asset until saturation, then no lift                                                  |
| `_regimeGateSweep.ts`                           | Pass-rate differs by BTC regime; gate-out worst                  | If bear-regime pass-rate > 5pp lower → gate it for +1-2pp                                              |
| `_multiStrategyComboShard.ts`                   | 3 strategies in parallel beat 1 strategy                         | If observed any-pass > theoretical-independent → strategies anti-correlated, multi-account is worth it |
| `_step2JointOptShard.ts`                        | Joint Step-1 → Step-2 pass rate; tp_mult tuning                  | Joint = Step-1 × Step-2-conditional ≈ 50-65% × 75-80% = 38-52%                                         |
| `_mlOverlayFeatures.ts` + `ml_overlay_train.py` | Engine signals have hidden quality variance an XGBoost can score | If AUC > 0.55 → ML overlay can lift pass-rate +2-5pp                                                   |

## Running a single sweep

All scripts follow the standard 8-shard pattern from `_r28V6Shard.ts`:

```bash
# Single shard (slow, full sweep on one machine)
npx tsx scripts/_assetExpansionSweep.ts 0 1

# 8 parallel shards (faster, 8 CPU cores)
for i in $(seq 0 7); do
  npx tsx scripts/_assetExpansionSweep.ts $i 8 &
done
wait
```

Output goes into `scripts/cache_bakeoff/<sweep_name>_shard_*.jsonl`.

## Running all 5 sweeps

```bash
# In separate terminals or background:
npx tsx scripts/_assetExpansionSweep.ts 0 1 > /tmp/expansion.log &
npx tsx scripts/_regimeGateSweep.ts 0 1 > /tmp/regime.log &
npx tsx scripts/_multiStrategyComboShard.ts 0 1 > /tmp/combo.log &
npx tsx scripts/_step2JointOptShard.ts 0 1 > /tmp/step2.log &
npx tsx scripts/_mlOverlayFeatures.ts > /tmp/ml_features.log &
wait
```

Each takes 5-30 minutes single-threaded depending on the sweep (asset
expansion is the longest because it does N×candidates×windows simulations).

## Interpreting results

### Asset Expansion

Look at the `marker: "greedy_pick"` lines. Each pick logs which asset
was added and the resulting pass-rate. Stop adding when delta < 0.5pp.

### Regime Gate

The `marker: "summary"` line at the end gives `bull_pass_rate`,
`bear_pass_rate`, `range_pass_rate`. If one is markedly worse (≥5pp
below the others), add a `regime_gate` block to your live config that
skips entries during that regime.

### Multi-Strategy Combo

The summary reports `any_pass_rate` (observed) vs `theoretical_any_indep`
(if strategies were independent). Three cases:

- **observed >> indep**: strategies are anti-correlated. **Run all three
  multi-account** for the highest min-1-pass.
- **observed ≈ indep**: strategies are roughly independent. Multi-account
  still helps but follow the math.
- **observed << indep**: strategies are correlated. **Same windows fail
  in all three** — multi-account doesn't help much.

### Step-2 Joint Opt

The 3-row summary (one per `tp_mult`) shows joint Step-1 → Step-2
pass-rate. Pick the `tp_mult` with the highest joint rate. **Live
deployment trigger**: only after 2-week Step-1 stability per Memory
`project_future_rounds_roadmap.md`.

### ML Overlay

The Python trainer prints an AUC. Decision rule:

- **AUC > 0.60**: clear signal, integrate the model as an entry-gate
- **AUC 0.55-0.60**: marginal — needs walk-forward CV before trusting
- **AUC < 0.55**: engine signals are already efficient; drop the overlay

## Limits

- All sweeps replay against the SAME historical cache. **Backtest realism**
  applies — see Memory `feedback_backtest_vs_v4sim_gap.md`. Live drift
  -3-5pp expected on top of any backtest result.
- Each sweep treats other features as fixed. If two features interact
  (e.g. asset expansion + regime gate), you'd need a joint sweep. Keep
  it simple first.
- Sweep results are NOT a green-light for live deployment. They are
  PRIORITISATION data for which experiments are worth doing in live shadow
  mode next.
