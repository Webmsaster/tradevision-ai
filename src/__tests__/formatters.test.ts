import { describe, it, expect } from "vitest";
import {
  formatCurrency,
  formatFinite,
  formatPrice,
  formatPnl,
  formatPercent,
  formatTradeDate,
  formatDetailDate,
  formatShortDate,
} from "@/utils/formatters";

describe("formatCurrency", () => {
  it("formats positive numbers with dollar sign", () => {
    expect(formatCurrency(1234.56)).toBe("$1,234.56");
  });

  it("formats negative numbers with minus and dollar sign", () => {
    expect(formatCurrency(-500)).toBe("-$500.00");
  });

  it("formats zero", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("formats large numbers with commas", () => {
    expect(formatCurrency(1000000)).toBe("$1,000,000.00");
  });

  it("rounds to 2 decimal places", () => {
    expect(formatCurrency(99.999)).toBe("$100.00");
  });
});

describe("formatFinite", () => {
  it("formats a normal number", () => {
    expect(formatFinite(42.567)).toBe("42.57");
  });

  it("returns N/A for undefined", () => {
    expect(formatFinite(undefined)).toBe("N/A");
  });

  it("returns N/A for Infinity", () => {
    expect(formatFinite(Infinity)).toBe("N/A");
  });

  it("returns N/A for NaN", () => {
    expect(formatFinite(NaN)).toBe("N/A");
  });

  it("respects custom decimals", () => {
    expect(formatFinite(3.14159, 4)).toBe("3.1416");
  });
});

describe("formatPrice", () => {
  it("formats price to 2 decimals", () => {
    expect(formatPrice(1234.5)).toBe("1234.50");
  });

  it("formats zero", () => {
    expect(formatPrice(0)).toBe("0.00");
  });
});

describe("formatPnl", () => {
  it("adds + sign for positive", () => {
    expect(formatPnl(123.45)).toBe("+123.45");
  });

  it("keeps - sign for negative", () => {
    expect(formatPnl(-67.89)).toBe("-67.89");
  });

  it("formats zero without sign", () => {
    expect(formatPnl(0)).toBe("0.00");
  });
});

describe("formatPercent", () => {
  it("adds + sign and % for positive", () => {
    expect(formatPercent(12.34)).toBe("+12.3%");
  });

  it("keeps - sign and adds %", () => {
    expect(formatPercent(-4.56)).toBe("-4.6%");
  });

  it("formats zero without sign", () => {
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("respects custom decimals", () => {
    expect(formatPercent(12.345, 2)).toBe("+12.35%");
  });
});

describe("formatTradeDate", () => {
  it("formats ISO string to short date with time", () => {
    const result = formatTradeDate("2024-03-15T09:30:00Z");
    // Result depends on local timezone, but should contain month and time
    expect(result).toMatch(/^\w{3} \d{2}, \d{2}:\d{2}$/);
  });

  it("accepts Date objects", () => {
    const result = formatTradeDate(new Date(2024, 0, 1, 14, 30));
    expect(result).toBe("Jan 01, 14:30");
  });
});

describe("formatDetailDate", () => {
  it("formats with year", () => {
    const d = new Date(2024, 5, 15, 9, 5);
    const result = formatDetailDate(d.toISOString());
    expect(result).toMatch(/^\w{3} \d{2}, \d{4} \d{2}:\d{2}$/);
  });
});

describe("formatShortDate", () => {
  it("formats date without time", () => {
    const d = new Date(2024, 0, 1);
    const result = formatShortDate(d.toISOString());
    expect(result).toMatch(/^\w{3} \d{2}, \d{4}$/);
  });

  it("returns input for invalid date", () => {
    expect(formatShortDate("not-a-date")).toBe("not-a-date");
  });
});

// ---------------------------------------------------------------------------
// Round 60: displayInUTC option coverage (formatTradeDate / formatDetailDate /
// formatShortDate). Previously the UTC-bucket branch was never exercised by
// tests — only the local-time path. The aiAnalysis dashboard reconciliation
// (DateFormatOptions.displayInUTC=true) silently regressed without
// detection.
// ---------------------------------------------------------------------------

describe("formatters displayInUTC branch", () => {
  it("formatTradeDate uses UTC getters when displayInUTC=true", () => {
    // 2024-03-15T23:30:00Z is March-15 in UTC. Local TZ in CI/dev varies, but
    // UTC mode must always render "Mar 15, 23:30".
    const result = formatTradeDate("2024-03-15T23:30:00Z", {
      displayInUTC: true,
    });
    expect(result).toBe("Mar 15, 23:30");
  });

  it("formatDetailDate uses UTC getters when displayInUTC=true", () => {
    const result = formatDetailDate("2024-12-31T23:59:00Z", {
      displayInUTC: true,
    });
    expect(result).toBe("Dec 31, 2024 23:59");
  });

  it("formatShortDate uses UTC getters when displayInUTC=true", () => {
    // Local-TZ render of 00:00:00Z would shift the day backwards in
    // negative-offset TZs (e.g. America/New_York → "Dec 31, 2023").
    const result = formatShortDate("2024-01-01T00:00:00Z", {
      displayInUTC: true,
    });
    expect(result).toBe("Jan 01, 2024");
  });

  it("formatShortDate honours custom default (displayInUTC=false explicit)", () => {
    const d = new Date(Date.UTC(2024, 5, 15, 12, 0, 0));
    // local-TZ path: month/day from getMonth/getDate, not getUTCMonth.
    const result = formatShortDate(d.toISOString(), { displayInUTC: false });
    expect(result).toMatch(/^\w{3} \d{2}, 2024$/);
  });

  it("formatTradeDate pads single-digit minutes/hours in UTC mode", () => {
    // Round 56 UTC bucketing fix #5 — verify zero-padding via UTC path.
    const result = formatTradeDate("2024-01-01T03:05:00Z", {
      displayInUTC: true,
    });
    expect(result).toBe("Jan 01, 03:05");
  });
});
