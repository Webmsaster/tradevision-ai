import { describe, it, expect } from "vitest";
import {
  validateOrder,
  placeOrder,
  OrderBlockedError,
  type OrderSafetyConfig,
  type PlaceOrderInput,
} from "@/utils/binanceOrders";
import type { BinanceConfig } from "@/utils/binanceAccount";

const cfgTestnet: BinanceConfig = {
  apiKey: "k",
  apiSecret: "s",
  testnet: true,
  recvWindow: 5000,
};
const cfgMainnet: BinanceConfig = { ...cfgTestnet, testnet: false };

const safeDefault: OrderSafetyConfig = {
  maxNotionalUsd: 1000,
  symbolWhitelist: new Set(["SUIUSDT", "AVAXUSDT"]),
  testnetOnly: true,
  dryRun: true,
  emergencyHalt: false,
};

const baseOrder: PlaceOrderInput = {
  symbol: "SUIUSDT",
  side: "BUY",
  type: "LIMIT",
  quantity: 100,
  price: 2.0,
  postOnly: true,
  notionalUsd: 200,
};

describe("binanceOrders — validateOrder", () => {
  it("passes a normal order on testnet with dry-run", () => {
    expect(() =>
      validateOrder(baseOrder, cfgTestnet, safeDefault),
    ).not.toThrow();
  });

  it("blocks when EMERGENCY_HALT active", () => {
    expect(() =>
      validateOrder(baseOrder, cfgTestnet, {
        ...safeDefault,
        emergencyHalt: true,
      }),
    ).toThrow(OrderBlockedError);
  });

  it("blocks mainnet when testnetOnly=true", () => {
    expect(() => validateOrder(baseOrder, cfgMainnet, safeDefault)).toThrow(
      /mainnet blocked/,
    );
  });

  it("allows mainnet when testnetOnly=false", () => {
    expect(() =>
      validateOrder(baseOrder, cfgMainnet, {
        ...safeDefault,
        testnetOnly: false,
      }),
    ).not.toThrow();
  });

  it("blocks unwhitelisted symbol", () => {
    expect(() =>
      validateOrder(
        { ...baseOrder, symbol: "SHIBUSDT" },
        cfgTestnet,
        safeDefault,
      ),
    ).toThrow(/not in whitelist/);
  });

  it("blocks oversized notional", () => {
    expect(() =>
      validateOrder(
        { ...baseOrder, notionalUsd: 2000 },
        cfgTestnet,
        safeDefault,
      ),
    ).toThrow(/max \$1000/);
  });

  it("blocks LIMIT without price", () => {
    expect(() =>
      validateOrder(
        { ...baseOrder, type: "LIMIT", price: undefined },
        cfgTestnet,
        safeDefault,
      ),
    ).toThrow(/LIMIT order requires price/);
  });

  it("blocks qty ≤ 0", () => {
    expect(() =>
      validateOrder({ ...baseOrder, quantity: 0 }, cfgTestnet, safeDefault),
    ).toThrow(/quantity must be > 0/);
  });

  it("blocks postOnly on MARKET order", () => {
    expect(() =>
      validateOrder(
        {
          ...baseOrder,
          type: "MARKET",
          postOnly: true,
          price: undefined,
          notionalUsd: 200,
        },
        cfgTestnet,
        safeDefault,
      ),
    ).toThrow(/postOnly only valid on LIMIT/);
  });
});

describe("binanceOrders — placeOrder dry-run", () => {
  it("dry-run returns simulated response without HTTP", async () => {
    const r = await placeOrder(baseOrder, cfgTestnet, safeDefault);
    expect(r.orderId).toBeGreaterThan(0);
    expect(r.symbol).toBe("SUIUSDT");
    expect(r.quantity).toBe(100);
    expect(r.status).toBe("NEW"); // LIMIT → NEW
  });

  it("dry-run MARKET returns FILLED status", async () => {
    const r = await placeOrder(
      {
        ...baseOrder,
        type: "MARKET",
        postOnly: false,
        price: undefined,
      },
      cfgTestnet,
      safeDefault,
    );
    expect(r.status).toBe("FILLED");
    expect(r.executedQty).toBe(100);
  });

  it("dry-run respects EMERGENCY_HALT", async () => {
    await expect(
      placeOrder(baseOrder, cfgTestnet, {
        ...safeDefault,
        emergencyHalt: true,
      }),
    ).rejects.toThrow(/EMERGENCY_HALT/);
  });

  it("dry-run rejects oversized notional before HTTP", async () => {
    await expect(
      placeOrder({ ...baseOrder, notionalUsd: 5000 }, cfgTestnet, safeDefault),
    ).rejects.toThrow(/max \$1000/);
  });
});
