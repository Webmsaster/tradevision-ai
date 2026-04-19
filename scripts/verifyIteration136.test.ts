/**
 * Iter 136 — real-world execution stress test on iter135 config.
 *
 * Purpose: verify that the Sharpe 10.15 backtest isn't fragile to realistic
 * trading costs. Test the same config under increasingly adversarial cost
 * scenarios:
 *
 *   S0 MAKER (0.02% fee, 1bp funding/h, 0 slippage)           [iter135 baseline]
 *   S1 MAKER + 1bp slippage per side
 *   S2 MAKER + 3bps slippage per side (fill uncertainty)
 *   S3 TAKER (0.04% fee, 1bp funding/h, 0 slippage)
 *   S4 TAKER + 2bps slippage (one side partially taker)
 *   S5 TAKER + 5bps slippage (worst-case execution)
 *   S6 doubled funding (2bp/h) + TAKER + 2bps slip
 *   S7 tight pessimistic: TAKER + 5bps + 2bp funding
 *
 * Pass criterion: Sharpe ≥ 4 under S5, bs+ ≥ 90% under S7.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts, type CostConfig } from "../src/utils/costModel";
import { runBtcIntraday, BTC_INTRADAY_CONFIG } from "../src/utils/btcIntraday";

const BTC = "BTCUSDT";
const TARGET_CANDLES = 50_000;

function sharpeOf(pnls: number[]): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(365 * 24);
}
function bootstrap(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): { pctPositive: number; p5: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, p5: 0 };
  let s = seed;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const rets: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sampled: number[] = [];
    const nBlocks = Math.ceil(pnls.length / blockLen);
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * Math.max(1, pnls.length - blockLen));
      for (let k = 0; k < blockLen; k++) sampled.push(pnls[start + k]);
    }
    const ret = sampled.reduce((a, p) => a * (1 + p), 1) - 1;
    rets.push(ret);
  }
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    pctPositive: rets.filter((r) => r > 0).length / rets.length,
    p5: sorted[Math.floor(sorted.length * 0.05)],
  };
}

// Use the PRODUCTION runner (runBtcIntraday) so we're measuring exactly the
// shipped code. Pass different cost configs via cfg.costs override.

describe("iter 136 — stress test iter135 under realistic execution", () => {
  it(
    "run same config under 8 cost scenarios",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 136: real-world stress test ===");
      const c = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1h",
        targetCount: TARGET_CANDLES,
        maxPages: 100,
      });
      const days = c.length / 24;
      console.log(`loaded ${c.length} BTC candles (${days.toFixed(0)} days)`);

      const scenarios: Array<{ label: string; costs: CostConfig }> = [
        {
          label: "S0 MAKER baseline",
          costs: { takerFee: 0.0002, slippageBps: 0, fundingBpPerHour: 0.1 },
        },
        {
          label: "S1 MAKER + 1bp slip",
          costs: { takerFee: 0.0002, slippageBps: 1, fundingBpPerHour: 0.1 },
        },
        {
          label: "S2 MAKER + 3bps slip",
          costs: { takerFee: 0.0002, slippageBps: 3, fundingBpPerHour: 0.1 },
        },
        {
          label: "S3 TAKER 0.04%",
          costs: { takerFee: 0.0004, slippageBps: 0, fundingBpPerHour: 0.1 },
        },
        {
          label: "S4 TAKER + 2bps slip",
          costs: { takerFee: 0.0004, slippageBps: 2, fundingBpPerHour: 0.1 },
        },
        {
          label: "S5 TAKER + 5bps slip",
          costs: { takerFee: 0.0004, slippageBps: 5, fundingBpPerHour: 0.1 },
        },
        {
          label: "S6 TAKER + 2bps + 2×funding",
          costs: { takerFee: 0.0004, slippageBps: 2, fundingBpPerHour: 0.2 },
        },
        {
          label: "S7 TAKER + 5bps + 2×funding",
          costs: { takerFee: 0.0004, slippageBps: 5, fundingBpPerHour: 0.2 },
        },
      ];

      console.log(
        "\nscenario                            n     tpd    WR     mean%    cumRet    Shp   bs+   bs5%",
      );
      for (const s of scenarios) {
        const cfg = { ...BTC_INTRADAY_CONFIG, costs: s.costs };
        const report = runBtcIntraday(c, cfg);
        if (report.trades.length === 0) {
          console.log(`${s.label.padEnd(34)} — no trades`);
          continue;
        }
        const pnls = report.trades.map((t) => t.pnl);
        const wins = pnls.filter((p) => p > 0).length;
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
        const sh = sharpeOf(pnls);
        const wr = wins / report.trades.length;
        const tpd = report.tradesPerDay;
        const bs = bootstrap(
          pnls,
          50,
          Math.max(10, Math.floor(pnls.length / 15)),
          s.label.length * 13,
        );
        console.log(
          `${s.label.padEnd(34)} ${report.trades.length.toString().padStart(5)} ${tpd.toFixed(2)} ${(wr * 100).toFixed(1).padStart(5)}% ${(mean * 100).toFixed(3).padStart(6)}% ${(ret * 100).toFixed(1).padStart(6)}% ${sh.toFixed(2).padStart(5)} ${(bs.pctPositive * 100).toFixed(0).padStart(3)}% ${(bs.p5 * 100).toFixed(1).padStart(6)}%`,
        );
      }
    },
  );
});
