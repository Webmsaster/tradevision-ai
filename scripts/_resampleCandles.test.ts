/**
 * Round 57 Forex Fix 1 — resampleCandles partial-bucket regression tests.
 *
 * The previous implementation only dropped the leading under-filled
 * bucket (`i === 0`). Mid-series under-filled buckets — caused by
 * forex weekend reopen (Sun 22:00 UTC) and exchange holidays — were
 * emitted as "valid" 2h/4h bars containing only 1h of real data.
 * That distorted ATR and percentile calculations downstream.
 *
 * The fix drops ANY bucket whose source-bar count is below the
 * expected count. These tests synthesize gappy series and assert
 * the partial buckets are skipped.
 */
import { describe, it, expect } from "vitest";
import { resampleCandles } from "./_loadYahooHistory";
import type { Candle } from "../src/utils/indicators";

const HOUR = 3600_000;

function mkH1(t: number, base: number): Candle {
  return {
    openTime: t,
    closeTime: t + HOUR - 1,
    open: base,
    high: base + 0.1,
    low: base - 0.1,
    close: base,
    volume: 100,
    isFinal: true,
  };
}

describe("resampleCandles — Round 57 Fix 1 (partial buckets)", () => {
  it("drops a mid-series under-filled bucket (forex weekend gap)", () => {
    // 1h source bars with a gap that leaves a 2h bucket containing only
    // 1 hourly bar. Three full 2h buckets surround it.
    //
    // 0h, 1h  → bucket [0h,2h) ✓ (2 bars)
    // 2h      → bucket [2h,4h) ✗ (1 bar — partial, must drop)
    //         (3h missing)
    // 4h, 5h  → bucket [4h,6h) ✓ (2 bars)
    // 6h, 7h  → bucket [6h,8h) ✓ (2 bars)
    const src: Candle[] = [
      mkH1(0, 100),
      mkH1(1 * HOUR, 101),
      mkH1(2 * HOUR, 102),
      // 3 * HOUR missing
      mkH1(4 * HOUR, 104),
      mkH1(5 * HOUR, 105),
      mkH1(6 * HOUR, 106),
      mkH1(7 * HOUR, 107),
    ];
    const out = resampleCandles(src, 2 * HOUR);
    // Three full 2h buckets, NOT four — the [2h,4h) bucket must be
    // dropped because it contains only 1 of the expected 2 source bars.
    expect(out.length).toBe(3);
    expect(out.map((c) => c.openTime)).toEqual([0, 4 * HOUR, 6 * HOUR]);
    // None of the emitted buckets correspond to the gap window.
    expect(out.find((c) => c.openTime === 2 * HOUR)).toBeUndefined();
  });

  it("drops a trailing under-filled bucket (last 4h bucket has only 1h of data)", () => {
    // Six 1h bars: full [0,4h) bucket (4 bars) + partial [4h,8h) bucket
    // with only bars at 4h and 5h (2 of 4 expected). Must drop trailing.
    const src: Candle[] = [];
    for (let i = 0; i < 4; i++) src.push(mkH1(i * HOUR, 100 + i));
    src.push(mkH1(4 * HOUR, 104));
    src.push(mkH1(5 * HOUR, 105));
    const out = resampleCandles(src, 4 * HOUR);
    expect(out.length).toBe(1);
    expect(out[0]!.openTime).toBe(0);
  });

  it("preserves all full buckets and skips the partial leading bucket", () => {
    // Backward-compat sanity: a missing leading bar should still cause
    // the leading bucket to drop (legacy behaviour now generalised).
    const src: Candle[] = [
      // bar at 0h missing
      mkH1(1 * HOUR, 101),
      mkH1(2 * HOUR, 102),
      mkH1(3 * HOUR, 103),
      mkH1(4 * HOUR, 104),
      mkH1(5 * HOUR, 105),
    ];
    const out = resampleCandles(src, 2 * HOUR);
    // [0,2h) bucket has 1 bar (partial) → drop.
    // [2h,4h) bucket has 2 bars → keep.
    // [4h,6h) bucket has 2 bars → keep.
    expect(out.length).toBe(2);
    expect(out.map((c) => c.openTime)).toEqual([2 * HOUR, 4 * HOUR]);
  });
});
