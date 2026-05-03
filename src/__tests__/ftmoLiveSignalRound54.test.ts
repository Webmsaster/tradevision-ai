/**
 * Round 54 — V231 / Live-Service regression tests.
 *
 * Covers:
 *   - Fix #5: peakDrawdownThrottle silent disable when challengePeak missing
 *     → V231 must REJECT signal generation entirely (return [], with note).
 *   - Fix #4: clamp fromPeak ≥ 0 (defensive against torn reads).
 *   - Fix #3: throw at module load when FTMO_TF set but no registry hit.
 *
 * Strategy: re-import detector for each FTMO_TF via vi.resetModules() (mirrors
 * the pattern used in ftmoLiveSafety.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Candle } from "@/utils/indicators";

function makeCandles(n: number, basePrice = 1000, vol = 5): Candle[] {
  // Deterministic mulberry32 — same pattern as the other live tests.
  let s = 42 >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = s;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let price = basePrice;
  let t = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open + (rng() - 0.5) * vol;
    const high = Math.max(open, close) + rng() * vol;
    const low = Math.min(open, close) - rng() * vol;
    out.push({
      openTime: t,
      open,
      high,
      low,
      close,
      volume: 1000,
      closeTime: t + 30 * 60_000 - 1,
      isFinal: true,
    });
    price = close;
    t += 30 * 60_000;
  }
  return out;
}

describe("Round 54 — V231 fixes", () => {
  beforeEach(async () => {
    delete process.env.FTMO_TF;
    delete process.env.FTMO_TF_ALLOW_FALLBACK;
    vi.resetModules();
  });

  describe("Fix #5: peakDrawdownThrottle without challengePeak rejects signals", () => {
    it("returns [] + note when CFG.peakDrawdownThrottle is set and challengePeak is undefined", async () => {
      process.env.FTMO_TF = "2h-trend-v5-quartz-lite-r28-v2";
      /* using vi.resetModules() from outer scope */
      vi.resetModules();
      const v231 = await import("@/utils/ftmoLiveSignalV231");
      const candles = makeCandles(200);
      const result = v231.detectLiveSignalsV231(
        candles,
        candles,
        candles,
        // No challengePeak field — this is the cold-start case
        { equity: 1.05, day: 5, recentPnls: [], equityAtDayStart: 1.04 },
        [],
      );
      expect(result.signals).toEqual([]);
      expect(result.activeBotConfig).toContain("BLOCKED");
      const noteText = result.notes.join(" ");
      expect(noteText).toMatch(/peakDrawdownThrottle/);
      expect(noteText).toMatch(/challengePeak/);
    });

    it("returns [] when challengePeak is 0 (treated as missing)", async () => {
      process.env.FTMO_TF = "2h-trend-v5-quartz-lite-r28-v2";
      /* using vi.resetModules() from outer scope */
      vi.resetModules();
      const v231 = await import("@/utils/ftmoLiveSignalV231");
      const candles = makeCandles(200);
      const result = v231.detectLiveSignalsV231(
        candles,
        candles,
        candles,
        {
          equity: 1.05,
          day: 5,
          recentPnls: [],
          equityAtDayStart: 1.04,
          challengePeak: 0,
        },
        [],
      );
      expect(result.signals).toEqual([]);
      expect(result.activeBotConfig).toContain("BLOCKED");
    });

    it("does NOT block when CFG has no peakDrawdownThrottle (e.g. V261_2H)", async () => {
      process.env.FTMO_TF = "2h";
      /* using vi.resetModules() from outer scope */
      vi.resetModules();
      const v231 = await import("@/utils/ftmoLiveSignalV231");
      const candles = makeCandles(200);
      const result = v231.detectLiveSignalsV231(
        candles,
        candles,
        candles,
        // Missing challengePeak — should NOT block (no throttle configured)
        { equity: 1.05, day: 5, recentPnls: [], equityAtDayStart: 1.04 },
        [],
      );
      expect(result.activeBotConfig).not.toContain("BLOCKED");
    });
  });

  describe("Fix #3: FTMO_TF env without registry hit throws at module load", () => {
    it("throws when FTMO_TF set but unknown", async () => {
      process.env.FTMO_TF = "totally-bogus-config-name";
      /* using vi.resetModules() from outer scope */
      vi.resetModules();
      await expect(import("@/utils/ftmoLiveSignalV231")).rejects.toThrow(
        /did not match any known config/,
      );
    });

    it("falls back when FTMO_TF_ALLOW_FALLBACK=1 (test escape hatch)", async () => {
      process.env.FTMO_TF = "totally-bogus-config-name";
      process.env.FTMO_TF_ALLOW_FALLBACK = "1";
      /* using vi.resetModules() from outer scope */
      vi.resetModules();
      const v231 = await import("@/utils/ftmoLiveSignalV231");
      // Should successfully import + return default V261 label
      expect(v231.getActiveCfgInfo().label).toBe("V261");
    });

    it("does NOT throw when FTMO_TF unset (test harness default)", async () => {
      delete process.env.FTMO_TF;
      /* using vi.resetModules() from outer scope */
      vi.resetModules();
      const v231 = await import("@/utils/ftmoLiveSignalV231");
      expect(v231.getActiveCfgInfo().label).toBe("V261");
    });
  });

  describe("Fix #4: fromPeak clamp ≥ 0 (defensive)", () => {
    it("does not blow up on equity > peak (torn read scenario)", async () => {
      process.env.FTMO_TF = "2h-trend-v5-quartz-lite-r28-v2";
      /* using vi.resetModules() from outer scope */
      vi.resetModules();
      const v231 = await import("@/utils/ftmoLiveSignalV231");
      const candles = makeCandles(200);
      // equity ABOVE peak — pre-fix this produced negative fromPeak →
      // downstream NaN path. Post-fix it should clamp to 0 → no throttle,
      // detector runs cleanly.
      const result = v231.detectLiveSignalsV231(
        candles,
        candles,
        candles,
        {
          equity: 1.1,
          day: 5,
          recentPnls: [],
          equityAtDayStart: 1.08,
          challengePeak: 1.05, // peak < equity (torn read)
        },
        [],
      );
      // Sanity: detector returns SOMETHING (not crash, not NaN-fromPeak)
      expect(result.signals).toBeDefined();
      // The fromPeak printout in the throttle note must NOT show negative
      // values. Pre-fix: equity > peak gave fromPeak < 0, e.g. "-4.76%".
      // Post-fix: clamped to 0, must show "0.00%". (Other NaN sources unrelated
      // to fromPeak — e.g. session-hour — are out of scope for this fix.)
      const throttleNote =
        result.notes.find((n) => n.includes("peakDrawdownThrottle")) ?? "";
      expect(throttleNote).not.toMatch(/-\d+\.\d+%/); // no negative pct
      expect(throttleNote).toMatch(/0\.00%/); // clamped exactly to zero
    });
  });
});
