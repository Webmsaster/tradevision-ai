import { describe, it } from "vitest";
import { fetchFundingHistory } from "../src/utils/fundingRate";

describe("debug funding", () => {
  it("distribution", { timeout: 60_000 }, async () => {
    for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
      const events = await fetchFundingHistory(sym, 3000);
      const rates = events.map((e) => e.fundingRate);
      rates.sort((a, b) => a - b);
      const mean = rates.reduce((s, v) => s + v, 0) / rates.length;
      const pct = (p: number) => rates[Math.floor(rates.length * p)];
      const counts = (th: number) =>
        [
          rates.filter((r) => r > th).length,
          rates.filter((r) => r < -th).length,
        ] as const;
      console.log(
        `${sym}: n=${events.length} from ${new Date(events[0]?.fundingTime ?? 0).toISOString().slice(0, 10)} to ${new Date(events[events.length - 1]?.fundingTime ?? 0).toISOString().slice(0, 10)}`,
      );
      console.log(
        `  mean=${(mean * 100).toFixed(4)}% median=${(pct(0.5) * 100).toFixed(4)}% p95=${(pct(0.95) * 100).toFixed(4)}% p99=${(pct(0.99) * 100).toFixed(4)}% max=${(rates[rates.length - 1] * 100).toFixed(4)}%`,
      );
      for (const th of [0.0001, 0.0002, 0.0003, 0.0005]) {
        const [p, n] = counts(th);
        console.log(`  |rate|>${(th * 100).toFixed(2)}%: +${p}  -${n}`);
      }
    }
  });
});
