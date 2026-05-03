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

  // -- Round 57 fix #1: explicit format coverage ------------------------

  it("parses MT4 yyyy.mm.dd HH:MM format", () => {
    const r = normalizeDateToUTC("2026.04.15 14:30");
    expect(r.iso).toBe("2026-04-15T14:30:00.000Z");
    expect(r.warning).toBe("mt4-date-assumed-utc");
  });

  it("parses MT4 yyyy.mm.dd HH:MM:SS format", () => {
    const r = normalizeDateToUTC("2026.04.15 14:30:45");
    expect(r.iso).toBe("2026-04-15T14:30:45.000Z");
    expect(r.warning).toBe("mt4-date-assumed-utc");
  });

  it("parses EU dot-format dd.mm.yyyy HH:MM", () => {
    const r = normalizeDateToUTC("15.04.2026 14:30");
    expect(r.iso).toBe("2026-04-15T14:30:00.000Z");
    expect(r.warning).toBe("eu-date-assumed-utc");
  });

  it("parses EU dot-format date only", () => {
    const r = normalizeDateToUTC("15.04.2026");
    expect(r.iso).toBe("2026-04-15T00:00:00.000Z");
    expect(r.warning).toBe("eu-date-assumed-utc");
  });

  it("parses EU dash-format dd-mm-yyyy", () => {
    const r = normalizeDateToUTC("15-04-2026");
    expect(r.iso).toBe("2026-04-15T00:00:00.000Z");
    expect(r.warning).toBe("eu-date-assumed-utc");
  });

  it("parses EU slash-format when day>12 (unambiguous dmy)", () => {
    const r = normalizeDateToUTC("15/04/2026 14:30");
    expect(r.iso).toBe("2026-04-15T14:30:00.000Z");
    expect(r.warning).toBe("eu-date-assumed-utc");
  });

  it("parses US slash-format when second>12 (unambiguous mdy)", () => {
    const r = normalizeDateToUTC("04/15/2026 14:30");
    expect(r.iso).toBe("2026-04-15T14:30:00.000Z");
    expect(r.warning).toBe("us-date-assumed-utc");
  });

  it("emits ambiguous-slash warning when both parts ≤ 12 (defaults to dmy)", () => {
    const r = normalizeDateToUTC("04/05/2026");
    // 04/05 → dmy interpretation → 5 May 2026
    expect(r.iso).toBe("2026-05-04T00:00:00.000Z");
    expect(r.warning).toBe("ambiguous-slash-date-assumed-dmy");
  });

  it("rejects invalid components (month > 12)", () => {
    expect(normalizeDateToUTC("2026.13.01").iso).toBeNull();
    expect(normalizeDateToUTC("31.13.2026").iso).toBeNull();
  });

  it("rejects invalid day-of-month (Feb 30)", () => {
    // Feb 30 doesn't exist; Date.UTC silently rolls to Mar 2 — verify we
    // catch this via round-trip equality check.
    expect(normalizeDateToUTC("30.02.2026").iso).toBeNull();
    expect(normalizeDateToUTC("2026.02.30").iso).toBeNull();
  });

  it("rejects slash format when both parts > 12 (impossible)", () => {
    expect(normalizeDateToUTC("13/13/2026").iso).toBeNull();
  });

  it("rejects out-of-range hour/minute", () => {
    expect(normalizeDateToUTC("2026.04.15 25:00").iso).toBeNull();
    expect(normalizeDateToUTC("2026.04.15 14:60").iso).toBeNull();
  });
});
