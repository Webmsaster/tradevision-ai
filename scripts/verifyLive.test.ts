/**
 * Verifies the live-signal generator returns actionable output right now.
 */
import { describe, it } from "vitest";
import { computeLiveSignals } from "../src/utils/liveSignals";

describe("live signals", () => {
  it("computes current signal set", { timeout: 60_000 }, async () => {
    const r = await computeLiveSignals();
    console.log("\n=== LIVE SIGNALS @", r.generatedAt, "===\n");
    console.log("-- Champion (trend-filtered hour-of-day) --");
    for (const c of r.champion) {
      console.log(
        `${c.symbol} hour=${c.hourUtc}UTC  action=${c.action.toUpperCase()} conf=${c.confidence}`,
      );
      console.log(
        `  price=${c.currentPrice.toFixed(2)}  sma50=${c.sma50Price?.toFixed(2) ?? "-"}  ${c.aboveSma ? "ABOVE" : "BELOW"} SMA`,
      );
      console.log(
        `  longHours=[${c.longHours.join(",")}] shortHours=[${c.shortHours.join(",")}]`,
      );
      console.log(`  ${c.reason}`);
      if (c.action !== "flat") {
        console.log(
          `  → ENTRY ${c.entryPrice.toFixed(2)}  TARGET ${c.targetPrice?.toFixed(2)}  STOP ${c.stopPrice?.toFixed(2)}  HOLD until ${c.holdUntilUtc}`,
        );
      }
    }
    console.log("\n-- Monday Reversal --");
    for (const m of r.monday) {
      console.log(
        `${m.symbol}: fired=${m.fired}  weekendRet=${m.weekendReturnPct !== null ? (m.weekendReturnPct * 100).toFixed(2) + "%" : "-"}`,
      );
      console.log(`  ${m.reason}`);
    }
    console.log("\n-- Upcoming 24h windows --");
    for (const u of r.upcoming) {
      console.log(
        `  ${u.startTime}  ${u.symbol}  ${u.direction.toUpperCase()} (h${u.hourUtc})  cond: ${u.conditional}`,
      );
    }
  });
});
