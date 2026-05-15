/**
 * 2026-05-15 — RegimeConfluence orchestrator tests. Verifies the tally
 * gate logic (strict majority, requireR28v6, minVotes threshold) end-to-end.
 */
import { describe, it, expect } from "vitest";
import type { Candle } from "@/utils/indicators";
import {
  tallyRegimeConfluence,
  defaultRegimeConfluenceParams,
} from "@/utils/regimeVoters";

function flat(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      openTime: i * 1_800_000,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 100,
      closeTime: i * 1_800_000 + 1_800_000,
      isFinal: true,
    });
  }
  return out;
}

describe("tallyRegimeConfluence — orchestrator", () => {
  it("returns null when only BB-Z is enabled on flat market", () => {
    const r = tallyRegimeConfluence(flat(60), {
      ...defaultRegimeConfluenceParams(),
      voters: { useBbZMr: true },
    });
    // BB-Z on flat (std collapse) abstains. mv=2 not reachable.
    expect(r.consensus).toBeNull();
  });

  it("anchors-only — R28V6 long + Breakout long → long consensus at mv=2", () => {
    const r = tallyRegimeConfluence(
      flat(60),
      { minVotes: 2, requireR28v6: false, voters: {} },
      { r28v6Vote: "long", breakoutVote: "long" },
    );
    expect(r.consensus).toBe("long");
    expect(r.longVotes).toBe(2);
  });

  it("strict-majority: tied votes (long=1, short=1) → null", () => {
    const r = tallyRegimeConfluence(
      flat(60),
      { minVotes: 1, requireR28v6: false, voters: {} },
      { r28v6Vote: "long", breakoutVote: "short" },
    );
    expect(r.consensus).toBeNull();
  });

  it("minVotes=3 unreachable with 2 anchors → null even if both agree", () => {
    const r = tallyRegimeConfluence(
      flat(60),
      { minVotes: 3, requireR28v6: false, voters: {} },
      { r28v6Vote: "long", breakoutVote: "long" },
    );
    expect(r.consensus).toBeNull();
  });

  it("requireR28v6=true: breakout+meanRev agree without R28V6 → null", () => {
    const r = tallyRegimeConfluence(
      flat(60),
      { minVotes: 2, requireR28v6: true, voters: {} },
      { r28v6Vote: null, breakoutVote: "long", meanRevVote: "long" },
    );
    expect(r.consensus).toBeNull();
  });

  it("requireR28v6=true: R28V6 long + breakout long → long", () => {
    const r = tallyRegimeConfluence(
      flat(60),
      { minVotes: 2, requireR28v6: true, voters: {} },
      { r28v6Vote: "long", breakoutVote: "long" },
    );
    expect(r.consensus).toBe("long");
  });

  it("strict-majority: 2 long + 1 short = winning_count=2, min=2 → long", () => {
    const r = tallyRegimeConfluence(
      flat(60),
      { minVotes: 2, requireR28v6: false, voters: {} },
      { r28v6Vote: "long", breakoutVote: "long", meanRevVote: "short" },
    );
    expect(r.consensus).toBe("long");
    expect(r.longVotes).toBe(2);
    expect(r.shortVotes).toBe(1);
  });

  it("placeholder-entry-bar trick — voter consumes live-convention candles", () => {
    // Build series where signal bar (= last in live-convention slice) carries
    // a long-extreme cross-back. Voters should see it as the signal bar via
    // placeholder injection.
    const v: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const osc = i % 2 === 0 ? 100.5 : 99.5;
      v.push({
        openTime: i * 1_800_000,
        open: osc,
        high: osc + 0.2,
        low: osc - 0.2,
        close: osc,
        volume: 1,
        closeTime: i * 1_800_000 + 1_800_000,
        isFinal: true,
      });
    }
    v.push({
      openTime: 40 * 1_800_000,
      open: 100,
      high: 100,
      low: 90,
      close: 90,
      volume: 1,
      closeTime: 40 * 1_800_000 + 1_800_000,
      isFinal: true,
    });
    v.push({
      openTime: 41 * 1_800_000,
      open: 93,
      high: 98.5,
      low: 92.5,
      close: 98,
      volume: 1,
      closeTime: 41 * 1_800_000 + 1_800_000,
      isFinal: true,
    });
    // Use BB-Z + supertrend; with anchor-r28v6 long, expect long consensus.
    const r = tallyRegimeConfluence(
      v,
      {
        minVotes: 2,
        requireR28v6: false,
        voters: { useBbZMr: true },
      },
      { r28v6Vote: "long" },
    );
    expect(r.votesByName.bbZMr).toBe("long");
    expect(r.consensus).toBe("long");
  });
});
