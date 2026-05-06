import { describe, it, expect } from "vitest";
import * as configs from "@/utils/ftmoDaytrade24h";

describe("FTMO config module loads", () => {
  it("all FTMO_DAYTRADE_24H_CONFIG_* exports defined (catches spreadCrossAssetFilter throw)", () => {
    const configKeys = Object.keys(configs).filter((k) =>
      k.startsWith("FTMO_DAYTRADE_24H_"),
    );
    expect(configKeys.length).toBeGreaterThan(20);
    for (const k of configKeys) {
      expect((configs as Record<string, unknown>)[k]).toBeDefined();
    }
  });
});
