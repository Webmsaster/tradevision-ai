import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tradesToCsv, downloadCsv, exportTradesToCsv } from "@/utils/csvExport";
import { Trade } from "@/types/trade";

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "t1",
    pair: "BTC/USDT",
    direction: "long",
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    entryDate: "2026-01-01T10:00:00Z",
    exitDate: "2026-01-01T12:00:00Z",
    pnl: 10,
    pnlPercent: 10,
    fees: 0.5,
    notes: "",
    tags: [],
    leverage: 1,
    ...overrides,
  };
}

describe("tradesToCsv", () => {
  it("writes header row only when trades is empty", () => {
    const csv = tradesToCsv([]);
    expect(csv.split("\n").length).toBe(1);
    expect(csv).toContain("ID");
    expect(csv).toContain("Pair");
    expect(csv).toContain("PnL");
  });

  it("writes one row per trade", () => {
    const csv = tradesToCsv([makeTrade(), makeTrade({ id: "t2" })]);
    expect(csv.split("\n").length).toBe(3);
  });

  it("includes trade values in output", () => {
    const csv = tradesToCsv([makeTrade({ pair: "ETH/USDT", pnl: 42.5 })]);
    expect(csv).toContain("ETH/USDT");
    expect(csv).toContain("42.5");
  });

  it("quotes cells containing commas", () => {
    const csv = tradesToCsv([makeTrade({ notes: "Bought, then sold" })]);
    expect(csv).toContain('"Bought, then sold"');
  });

  it("escapes quotes inside cells by doubling them", () => {
    const csv = tradesToCsv([makeTrade({ notes: 'he said "hi"' })]);
    expect(csv).toContain('"he said ""hi"""');
  });

  it("joins tags with semicolons", () => {
    const csv = tradesToCsv([makeTrade({ tags: ["a", "b", "c"] })]);
    expect(csv).toContain("a;b;c");
  });

  it("handles empty optional fields gracefully", () => {
    const csv = tradesToCsv([makeTrade()]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    // no crash and header column count matches row column count
    const headerCount = (lines[0].match(/,/g) || []).length;
    const rowCount = (lines[1].match(/,/g) || []).length;
    expect(rowCount).toBe(headerCount);
  });

  it("quotes cells containing newlines", () => {
    const csv = tradesToCsv([makeTrade({ notes: "line1\nline2" })]);
    expect(csv).toContain('"line1\nline2"');
  });
});

describe("downloadCsv", () => {
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let appendSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;
  let clickSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clickSpy = vi.fn();
    const fakeAnchor = {
      click: clickSpy,
      href: "",
      download: "",
    } as unknown as HTMLAnchorElement;
    createElementSpy = vi
      .spyOn(document, "createElement")
      .mockReturnValue(fakeAnchor);
    appendSpy = vi
      .spyOn(document.body, "appendChild")
      .mockImplementation((n) => n);
    removeSpy = vi
      .spyOn(document.body, "removeChild")
      .mockImplementation((n) => n);
    (global.URL.createObjectURL as unknown) = vi.fn(() => "blob:url");
    (global.URL.revokeObjectURL as unknown) = vi.fn();
  });

  afterEach(() => {
    createElementSpy.mockRestore();
    appendSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("creates an anchor and triggers click with given filename", () => {
    downloadCsv("test.csv", "col1,col2\n1,2");
    expect(createElementSpy).toHaveBeenCalledWith("a");
    expect(clickSpy).toHaveBeenCalledOnce();
  });
});

describe("exportTradesToCsv", () => {
  it("composes filename with date and invokes download path", () => {
    const clickSpy = vi.fn();
    const fakeAnchor = {
      click: clickSpy,
      href: "",
      download: "",
    } as unknown as HTMLAnchorElement;
    vi.spyOn(document, "createElement").mockReturnValue(fakeAnchor);
    vi.spyOn(document.body, "appendChild").mockImplementation((n) => n);
    vi.spyOn(document.body, "removeChild").mockImplementation((n) => n);
    (global.URL.createObjectURL as unknown) = vi.fn(() => "blob:url");
    (global.URL.revokeObjectURL as unknown) = vi.fn();

    exportTradesToCsv([makeTrade()], "my-trades");
    expect(fakeAnchor.download).toMatch(/^my-trades-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(clickSpy).toHaveBeenCalled();
  });
});
