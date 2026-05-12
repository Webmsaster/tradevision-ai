import { describe, it, expect } from "vitest";
import { parseLocaleNumberUI } from "@/utils/parseLocaleNumber";

/**
 * R67-RR3 Regression Hunt — confirm that the shared UI parser correctly
 * handles thousand-separators that the previous naive `replace(",", ".")`
 * helper silently corrupted by 1000×.
 */
describe("parseLocaleNumberUI — R67-RR3 thousand-separator regression", () => {
  it("returns 0 for empty/undefined (UI semantics)", () => {
    expect(parseLocaleNumberUI("")).toBe(0);
    expect(parseLocaleNumberUI(undefined)).toBe(0);
  });

  it("returns 0 for non-numeric garbage instead of NaN", () => {
    expect(parseLocaleNumberUI("abc")).toBe(0);
    expect(parseLocaleNumberUI("$45.50")).toBe(0);
  });

  it("plain integers + dot-decimals still work", () => {
    expect(parseLocaleNumberUI("1234")).toBe(1234);
    expect(parseLocaleNumberUI("3.14")).toBe(3.14);
    expect(parseLocaleNumberUI("0.5")).toBe(0.5);
  });

  it("DE comma-decimal still works (R14/R18 original case)", () => {
    expect(parseLocaleNumberUI("1,5")).toBe(1.5);
    expect(parseLocaleNumberUI("0,5")).toBe(0.5);
    expect(parseLocaleNumberUI("3,14")).toBe(3.14);
  });

  // The original R67-RR3 regression bugs — verify they no longer happen.
  it("US thousand-grouping `1,234.56` parses to 1234.56 (was 1.234)", () => {
    expect(parseLocaleNumberUI("1,234.56")).toBe(1234.56);
  });

  it("DE thousand-grouping `1.234,56` parses to 1234.56 (was 1.234)", () => {
    expect(parseLocaleNumberUI("1.234,56")).toBe(1234.56);
  });

  it("US multi-group `1,234,567` parses to 1234567 (was 1.234)", () => {
    expect(parseLocaleNumberUI("1,234,567")).toBe(1234567);
  });

  it("DE multi-group `1.234.567` parses to 1234567 (was NaN→0)", () => {
    expect(parseLocaleNumberUI("1.234.567")).toBe(1234567);
  });

  // Large position-size / risk-amount inputs from the Calculator that the
  // bug would have under-sized by 1000×.
  it("large account balance `100,000.00` USD → 100000 (was 100)", () => {
    expect(parseLocaleNumberUI("100,000.00")).toBe(100000);
  });

  it("ambiguous single-comma `10,000` is interpreted as decimal 10.0", () => {
    // Documented strict-parser behaviour from csvParser (Phase 46): a single
    // comma with exactly 3 fraction digits is treated as decimal because the
    // user can disambiguate by adding a dot (`10,000.00`). This matches the
    // csvParser test `expect(parseLocaleNumber("1,234")).toBe(1.234)`.
    expect(parseLocaleNumberUI("10,000")).toBe(10);
    // Unambiguous form still works:
    expect(parseLocaleNumberUI("10,000.00")).toBe(10000);
    expect(parseLocaleNumberUI("10.000,00")).toBe(10000);
  });

  it("ambiguous comma-only forms stay defensive", () => {
    // Strict parser interprets "1,2,3" as ambiguous → NaN → 0 fallback.
    expect(parseLocaleNumberUI("1,2,3")).toBe(0);
  });

  it("trailing comma `1,5,` is rejected (NaN→0)", () => {
    // The naive helper accidentally accepted this as 1.5; strict rejects.
    expect(parseLocaleNumberUI("1,5,")).toBe(0);
  });

  it("negative numbers preserved", () => {
    expect(parseLocaleNumberUI("-42")).toBe(-42);
    expect(parseLocaleNumberUI("-0,5")).toBe(-0.5);
    expect(parseLocaleNumberUI("-1,234.56")).toBe(-1234.56);
  });
});
