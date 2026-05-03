import { describe, it, expect } from "vitest";
import {
  autoDetectMapping,
  mapCSVToTrades,
  sanitizeCSVField,
  PLATFORM_PRESETS,
  parseLocaleNumber,
} from "@/utils/csvParser";

describe("parseLocaleNumber — Phase 46 strict validation", () => {
  it("parses simple integers", () => {
    expect(parseLocaleNumber("1234")).toBe(1234);
    expect(parseLocaleNumber("-42")).toBe(-42);
  });
  it("parses simple decimals (US)", () => {
    expect(parseLocaleNumber("3.14")).toBe(3.14);
    expect(parseLocaleNumber("-0.5")).toBe(-0.5);
  });
  it("parses simple decimals (EU)", () => {
    expect(parseLocaleNumber("3,14")).toBe(3.14);
    expect(parseLocaleNumber("-0,5")).toBe(-0.5);
  });
  it("parses US thousand-separated", () => {
    expect(parseLocaleNumber("1,234")).toBe(1.234); // ambiguous → decimal interpretation
    expect(parseLocaleNumber("1,234,567")).toBe(1234567);
    expect(parseLocaleNumber("1,234.56")).toBe(1234.56);
  });
  it("parses EU thousand-separated", () => {
    expect(parseLocaleNumber("1.234.567")).toBe(1234567);
    expect(parseLocaleNumber("1.234,56")).toBe(1234.56);
  });
  it('rejects ambiguous "1,2,3" (was silently 1.2)', () => {
    expect(parseLocaleNumber("1,2,3")).toBeNaN();
  });
  it("rejects malformed thousand groups", () => {
    expect(parseLocaleNumber("1,23,456")).toBeNaN();
    expect(parseLocaleNumber("1.23.456")).toBeNaN();
  });
  it("rejects garbage", () => {
    expect(parseLocaleNumber("abc")).toBeNaN();
    expect(parseLocaleNumber("1.2.3,4")).toBeNaN();
    expect(parseLocaleNumber("1,2.3,4")).toBeNaN();
  });
  it("handles empty / undefined", () => {
    expect(parseLocaleNumber("")).toBeNaN();
    expect(parseLocaleNumber(undefined)).toBeNaN();
  });
});

describe("autoDetectMapping", () => {
  it("maps standard column names", () => {
    const headers = [
      "pair",
      "direction",
      "entry_price",
      "exit_price",
      "quantity",
      "entry_date",
      "exit_date",
      "fees",
      "leverage",
    ];
    const mapping = autoDetectMapping(headers);

    expect(mapping.pair).toBe("pair");
    expect(mapping.direction).toBe("direction");
    expect(mapping.entryPrice).toBe("entry_price");
    expect(mapping.exitPrice).toBe("exit_price");
    expect(mapping.quantity).toBe("quantity");
    expect(mapping.entryDate).toBe("entry_date");
    expect(mapping.exitDate).toBe("exit_date");
    expect(mapping.fees).toBe("fees");
    expect(mapping.leverage).toBe("leverage");
  });

  it("maps alternative column names", () => {
    const headers = [
      "symbol",
      "side",
      "open_price",
      "close_price",
      "amount",
      "date",
      "commission",
    ];
    const mapping = autoDetectMapping(headers);

    expect(mapping.pair).toBe("symbol");
    expect(mapping.direction).toBe("side");
    expect(mapping.entryPrice).toBe("open_price");
    expect(mapping.exitPrice).toBe("close_price");
    expect(mapping.quantity).toBe("amount");
    expect(mapping.fees).toBe("commission");
  });

  it("is case insensitive", () => {
    const headers = [
      "PAIR",
      "Direction",
      "Entry_Price",
      "EXIT_PRICE",
      "Quantity",
    ];
    const mapping = autoDetectMapping(headers);

    expect(mapping.pair).toBe("PAIR");
    expect(mapping.direction).toBe("Direction");
    expect(mapping.entryPrice).toBe("Entry_Price");
    expect(mapping.exitPrice).toBe("EXIT_PRICE");
    expect(mapping.quantity).toBe("Quantity");
  });

  it("returns partial mapping for unknown columns", () => {
    const headers = ["pair", "unknown_col"];
    const mapping = autoDetectMapping(headers);

    expect(mapping.pair).toBe("pair");
    expect(mapping.direction).toBeUndefined();
  });
});

describe("mapCSVToTrades", () => {
  it("maps CSV rows to trades", () => {
    const data = [
      {
        Pair: "BTC/USDT",
        Direction: "long",
        "Entry Price": "50000",
        "Exit Price": "52000",
        Quantity: "0.1",
        "Entry Date": "2024-01-01T10:00:00Z",
        "Exit Date": "2024-01-01T14:00:00Z",
        Fees: "5",
        Leverage: "1",
      },
    ];

    const { trades } = mapCSVToTrades(data, PLATFORM_PRESETS.generic!);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.pair).toBe("BTC/USDT");
    expect(trades[0]!.direction).toBe("long");
    expect(trades[0]!.entryPrice).toBe(50000);
    expect(trades[0]!.exitPrice).toBe(52000);
    expect(trades[0]!.quantity).toBe(0.1);
    expect(trades[0]!.pnl).toBe(195); // (52000-50000)*0.1*1 - 5
  });

  it("filters out rows with missing essential fields", () => {
    const data = [
      {
        Pair: "",
        Direction: "long",
        "Entry Price": "100",
        "Exit Price": "110",
        Quantity: "1",
      },
      {
        Pair: "BTC/USDT",
        Direction: "long",
        "Entry Price": "abc",
        "Exit Price": "110",
        Quantity: "1",
      },
      {
        Pair: "BTC/USDT",
        Direction: "long",
        "Entry Price": "100",
        "Exit Price": "110",
        Quantity: "1",
      },
    ];

    const { trades } = mapCSVToTrades(data, PLATFORM_PRESETS.generic!);
    expect(trades).toHaveLength(1);
  });

  // Round 57 fix #3: previously unknown directions silently defaulted to
  // long; now the row is skipped with a structured warning.
  it("skips rows with unknown direction (no silent long-default)", () => {
    const data = [
      {
        Pair: "BTC/USDT",
        Direction: "unknown",
        "Entry Price": "100",
        "Exit Price": "110",
        Quantity: "1",
        "Entry Date": "",
        "Exit Date": "",
        Fees: "",
        Leverage: "",
      },
    ];

    const { trades, warnings } = mapCSVToTrades(
      data,
      PLATFORM_PRESETS.generic!,
    );
    expect(trades).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /direction/i.test(w))).toBe(true);
  });

  it("maps sell/buy to short/long", () => {
    const data = [
      {
        Pair: "ETH/USDT",
        Direction: "sell",
        "Entry Price": "100",
        "Exit Price": "90",
        Quantity: "1",
        "Entry Date": "",
        "Exit Date": "",
        Fees: "",
        Leverage: "",
      },
      {
        Pair: "ETH/USDT",
        Direction: "buy",
        "Entry Price": "100",
        "Exit Price": "110",
        Quantity: "1",
        "Entry Date": "",
        "Exit Date": "",
        Fees: "",
        Leverage: "",
      },
    ];

    const { trades } = mapCSVToTrades(data, PLATFORM_PRESETS.generic!);
    expect(trades[0]!.direction).toBe("short");
    expect(trades[1]!.direction).toBe("long");
  });
});

// ---------------------------------------------------------------------------
// Round 57 fix #2: per-call warnings array (replaces module-level singleton)
// ---------------------------------------------------------------------------

describe("mapCSVToTrades - per-call warnings (R57 fix #2)", () => {
  function makeRow(entryDate: string) {
    return {
      Pair: "BTC/USDT",
      Direction: "long",
      "Entry Price": "100",
      "Exit Price": "110",
      Quantity: "1",
      "Entry Date": entryDate,
      "Exit Date": entryDate,
      Fees: "",
      Leverage: "",
    };
  }

  it("two consecutive imports both report naive-date warnings (no singleton latch)", () => {
    const naiveRow = [makeRow("2026-04-15 14:30")];

    const first = mapCSVToTrades(naiveRow, PLATFORM_PRESETS.generic!);
    expect(first.trades).toHaveLength(1);
    expect(first.warnings.length).toBeGreaterThan(0);
    expect(first.warnings.some((w) => /timezone|UTC/i.test(w))).toBe(true);

    // Second import — the OLD module-level _dateWarningEmitted flag would
    // have suppressed this. Verify the warning is still emitted.
    const second = mapCSVToTrades(naiveRow, PLATFORM_PRESETS.generic!);
    expect(second.trades).toHaveLength(1);
    expect(second.warnings.length).toBeGreaterThan(0);
    expect(second.warnings.some((w) => /timezone|UTC/i.test(w))).toBe(true);
  });

  it("populates warnings array with structured messages", () => {
    const data = [
      makeRow("2026-04-15 14:30"), // naive ISO
      makeRow("15/04/2026"), // ambiguous slash → defaults to dmy with warning
    ];
    const { trades, warnings } = mapCSVToTrades(
      data,
      PLATFORM_PRESETS.generic!,
    );
    expect(trades).toHaveLength(2);
    expect(warnings.length).toBeGreaterThan(0);
    // first row: 14:30 → naive; second row: 15/04/2026 first part is 15>12
    // so it's unambiguously dmy → eu-date-assumed-utc.
    expect(warnings.some((w) => /timezone|UTC/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 57 fix #3: extended direction matching
// ---------------------------------------------------------------------------

describe("mapCSVToTrades - extended direction parsing (R57 fix #3)", () => {
  function rowWith(direction: string) {
    return {
      Pair: "BTC/USDT",
      Direction: direction,
      "Entry Price": "100",
      "Exit Price": "110",
      Quantity: "1",
      "Entry Date": "2026-04-15T10:00:00Z",
      "Exit Date": "2026-04-15T11:00:00Z",
      Fees: "",
      Leverage: "",
    };
  }

  it("parses MT4-numeric direction (0=long, 1=short)", () => {
    const data = [rowWith("0"), rowWith("1")];
    const { trades, warnings } = mapCSVToTrades(
      data,
      PLATFORM_PRESETS.generic!,
    );
    expect(trades).toHaveLength(2);
    expect(trades[0]!.direction).toBe("long");
    expect(trades[1]!.direction).toBe("short");
    expect(warnings).toHaveLength(0);
  });

  it("parses German direction labels (kauf/verkauf)", () => {
    const data = [rowWith("Kauf"), rowWith("Verkauf"), rowWith("Kaufen")];
    const { trades } = mapCSVToTrades(data, PLATFORM_PRESETS.generic!);
    expect(trades).toHaveLength(3);
    expect(trades[0]!.direction).toBe("long");
    expect(trades[1]!.direction).toBe("short");
    expect(trades[2]!.direction).toBe("long");
  });

  it("parses single-letter L/S abbreviations", () => {
    const data = [rowWith("L"), rowWith("S")];
    const { trades } = mapCSVToTrades(data, PLATFORM_PRESETS.generic!);
    expect(trades).toHaveLength(2);
    expect(trades[0]!.direction).toBe("long");
    expect(trades[1]!.direction).toBe("short");
  });
});

describe("sanitizeCSVField", () => {
  it("returns normal values unchanged", () => {
    expect(sanitizeCSVField("BTC/USDT")).toBe("BTC/USDT");
    expect(sanitizeCSVField("long")).toBe("long");
    expect(sanitizeCSVField("100.50")).toBe("100.50");
  });

  it("strips = prefix (formula injection)", () => {
    expect(sanitizeCSVField("=CMD()")).toBe("CMD()");
    expect(sanitizeCSVField("=1+1")).toBe("1+1");
  });

  it("preserves + and - prefixes (valid in trading data)", () => {
    expect(sanitizeCSVField("+long")).toBe("+long");
    expect(sanitizeCSVField("-500.00")).toBe("-500.00");
    expect(sanitizeCSVField("+CMD()")).toBe("+CMD()");
    expect(sanitizeCSVField("-BTC/USDT")).toBe("-BTC/USDT");
  });

  it("strips @ prefix", () => {
    expect(sanitizeCSVField("@SUM(A1:A10)")).toBe("SUM(A1:A10)");
  });

  it("strips tab and subsequent dangerous prefixes", () => {
    expect(sanitizeCSVField("\t=CMD()")).toBe("CMD()");
    expect(sanitizeCSVField("\t\t@SUM()")).toBe("SUM()");
  });

  it("handles empty strings", () => {
    expect(sanitizeCSVField("")).toBe("");
    expect(sanitizeCSVField("  ")).toBe("");
  });

  it("trims whitespace", () => {
    expect(sanitizeCSVField("  BTC/USDT  ")).toBe("BTC/USDT");
  });
});

describe("mapCSVToTrades - CSV injection protection", () => {
  it("sanitizes pair field with formula prefix", () => {
    const data = [
      {
        Pair: "=CMD()",
        Direction: "long",
        "Entry Price": "100",
        "Exit Price": "110",
        Quantity: "1",
        "Entry Date": "",
        "Exit Date": "",
        Fees: "",
        Leverage: "",
      },
    ];
    const { trades } = mapCSVToTrades(data, PLATFORM_PRESETS.generic!);
    expect(trades[0]!.pair).toBe("CMD()");
  });

  it("sanitizes direction field", () => {
    const data = [
      {
        Pair: "BTC/USDT",
        Direction: "=long",
        "Entry Price": "100",
        "Exit Price": "110",
        Quantity: "1",
        "Entry Date": "",
        "Exit Date": "",
        Fees: "",
        Leverage: "",
      },
    ];
    const { trades } = mapCSVToTrades(data, PLATFORM_PRESETS.generic!);
    expect(trades[0]!.direction).toBe("long");
  });
});

describe("PLATFORM_PRESETS", () => {
  it("has all required presets", () => {
    expect(PLATFORM_PRESETS).toHaveProperty("binance");
    expect(PLATFORM_PRESETS).toHaveProperty("bybit");
    expect(PLATFORM_PRESETS).toHaveProperty("mt4");
    expect(PLATFORM_PRESETS).toHaveProperty("generic");
  });

  it("each preset has all required fields", () => {
    const requiredFields = [
      "pair",
      "direction",
      "entryPrice",
      "exitPrice",
      "quantity",
      "entryDate",
      "exitDate",
    ];

    for (const [_name, preset] of Object.entries(PLATFORM_PRESETS)) {
      for (const field of requiredFields) {
        expect(preset).toHaveProperty(field, expect.any(String));
      }
    }
  });
});
