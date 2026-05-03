import { describe, it, expect } from "vitest";
import { normalizeDateToUTC } from "@/utils/dateNormalize";

describe("normalizeDateToUTC", () => {
  it("passes ISO with Z suffix through (UTC)", () => {
    const result = normalizeDateToUTC("2026-04-15T14:30:00Z");
    expect(result.iso).toBe("2026-04-15T14:30:00.000Z");
    expect(result.warning).toBeUndefined();
  });

  it("normalises ISO with explicit offset to UTC", () => {
    // 14:30 +02:00 = 12:30 UTC
    const result = normalizeDateToUTC("2026-04-15T14:30:00+02:00");
    expect(result.iso).toBe("2026-04-15T12:30:00.000Z");
    expect(result.warning).toBeUndefined();
  });

  it("coerces naive ISO datetime to UTC and warns", () => {
    const result = normalizeDateToUTC("2026-04-15T14:30:00");
    expect(result.iso).toBe("2026-04-15T14:30:00.000Z");
    expect(result.warning).toBe("naive-iso-assumed-utc");
  });

  it("coerces space-separated naive datetime to UTC and warns", () => {
    const result = normalizeDateToUTC("2026-04-15 14:30");
    expect(result.iso).toBe("2026-04-15T14:30:00.000Z");
    expect(result.warning).toBe("naive-iso-assumed-utc");
  });

  it("treats date-only input as UTC midnight and warns", () => {
    const result = normalizeDateToUTC("2026-04-15");
    expect(result.iso).toBe("2026-04-15T00:00:00.000Z");
    expect(result.warning).toBe("date-only-assumed-utc-midnight");
  });

  it("returns null for unparseable input", () => {
    expect(normalizeDateToUTC("garbage").iso).toBeNull();
    expect(normalizeDateToUTC("").iso).toBeNull();
    expect(normalizeDateToUTC(undefined).iso).toBeNull();
    expect(normalizeDateToUTC(null).iso).toBeNull();
    expect(normalizeDateToUTC(42).iso).toBeNull();
  });

  // Round 56 fix #1: empty-string fallback explicitly returns null so
  // CSV import can detect "missing date" cases without ambiguity.
  it("handles empty string explicitly without warning", () => {
    const r = normalizeDateToUTC("");
    expect(r.iso).toBeNull();
    expect(r.warning).toBeUndefined();
  });

  it("handles whitespace-only strings as empty (null)", () => {
    expect(normalizeDateToUTC("   ").iso).toBeNull();
    expect(normalizeDateToUTC("\t\n").iso).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    const result = normalizeDateToUTC("  2026-04-15T14:30:00Z  ");
    expect(result.iso).toBe("2026-04-15T14:30:00.000Z");
  });
});
