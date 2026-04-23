import { describe, it, expect } from "vitest";
import {
  filterNewsEvents,
  isNewsBlackout,
  type NewsEvent,
} from "../utils/forexFactoryNews";

const t0 = new Date("2026-04-22T13:30:00Z").getTime();
const sample: NewsEvent[] = [
  { timestamp: t0, impact: "High", currency: "USD", title: "CPI y/y" },
  {
    timestamp: t0 + 3 * 3600_000,
    impact: "Medium",
    currency: "USD",
    title: "Retail",
  },
  {
    timestamp: t0 + 6 * 3600_000,
    impact: "High",
    currency: "EUR",
    title: "ECB",
  },
  {
    timestamp: t0 + 9 * 3600_000,
    impact: "Low",
    currency: "JPY",
    title: "PPI",
  },
];

describe("forexFactoryNews — filter", () => {
  it("defaults to high-impact USD/EUR/GBP only", () => {
    const out = filterNewsEvents(sample);
    expect(out.length).toBe(2);
    expect(out.map((e) => e.title)).toEqual(["CPI y/y", "ECB"]);
  });

  it("can include medium impact", () => {
    const out = filterNewsEvents(sample, { impacts: ["High", "Medium"] });
    expect(out.length).toBe(3);
  });

  it("can restrict currencies", () => {
    const out = filterNewsEvents(sample, { currencies: ["USD"] });
    expect(out.length).toBe(1);
  });
});

describe("forexFactoryNews — blackout", () => {
  it("flags exact-match timestamp", () => {
    expect(isNewsBlackout(t0, sample, 2)).toBe(true);
  });

  it("flags within buffer", () => {
    expect(isNewsBlackout(t0 - 90_000, sample, 2)).toBe(true); // 1.5 min before
    expect(isNewsBlackout(t0 + 90_000, sample, 2)).toBe(true);
  });

  it("does NOT flag outside buffer", () => {
    expect(isNewsBlackout(t0 - 3 * 60_000, sample, 2)).toBe(false); // 3 min before
    expect(isNewsBlackout(t0 + 3 * 60_000, sample, 2)).toBe(false);
  });

  it("handles empty events gracefully", () => {
    expect(isNewsBlackout(t0, [], 2)).toBe(false);
  });
});
