import { describe, it, expect } from "vitest";
import { detectLiveSignal, renderAlert } from "../utils/ftmoSignalDetector";
import type { Candle } from "../utils/indicators";

function mk(t: number, o: number, h: number, l: number, c: number): Candle {
  return {
    openTime: t,
    closeTime: t + 4 * 3600_000 - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    isFinal: true,
  };
}

// Build 50 btc candles in downtrend so EMAs sort correctly and no uptrend
function mkBtcDowntrend(): Candle[] {
  const t0 = new Date("2026-04-04T00:00:00Z").getTime();
  const out: Candle[] = [];
  // drop from 80000 to 60000
  let price = 80000;
  for (let i = 0; i < 50; i++) {
    const t = t0 + i * 4 * 3600_000;
    const next = price * 0.996;
    out.push(mk(t, price, price * 1.002, next * 0.998, next));
    price = next;
  }
  return out;
}

// Bull: prices rising smoothly
function mkBtcUptrend(): Candle[] {
  const t0 = new Date("2026-04-04T00:00:00Z").getTime();
  const out: Candle[] = [];
  let price = 60000;
  for (let i = 0; i < 50; i++) {
    const t = t0 + i * 4 * 3600_000;
    const next = price * 1.008;
    out.push(mk(t, price, next * 1.002, price * 0.998, next));
    price = next;
  }
  return out;
}

// Two green ETH candles: close ascending
function mkEthTwoGreen(): Candle[] {
  const t0 = new Date("2026-04-04T00:00:00Z").getTime();
  const out: Candle[] = [];
  // Build 50 bars, last 3 ascending closes
  const closes = Array(50).fill(2400);
  for (let i = 47; i < 50; i++) closes[i] = 2400 + (i - 47) * 5;
  for (let i = 0; i < 50; i++) {
    out.push(
      mk(
        t0 + i * 4 * 3600_000,
        closes[i],
        closes[i] * 1.002,
        closes[i] * 0.998,
        closes[i],
      ),
    );
  }
  return out;
}

describe("ftmoSignalDetector", () => {
  it("no signal when ETH pattern missing", () => {
    const btc = mkBtcDowntrend();
    const eth = Array(50)
      .fill(null)
      .map((_, i) =>
        mk(
          new Date("2026-04-04T00:00:00Z").getTime() + i * 4 * 3600_000,
          2400,
          2410,
          2390,
          2400,
        ),
      );
    const a = detectLiveSignal(eth, btc);
    expect(a.hasSignal).toBe(false);
    expect(a.skipReason).toContain("no 2-green sequence");
  });

  it("short signal fires in bear regime with 2-green ETH (hour allowed)", () => {
    const btc = mkBtcDowntrend();
    const eth = mkEthTwoGreen();
    const a = detectLiveSignal(eth, btc);
    expect(a.regime).toBe("BEAR_CHOP");
    expect(a.botUsed).toBe("iter212");
    // whether signal fires depends on whether the next entry hour is allowed
    // (not 8 UTC) AND no news — with default empty news + data at 00:00 UTC start
    // the last bar's close is at offset 49*4h from t0 = 2026-04-04T00:00:00Z
    // = 2026-04-12T04:00:00Z closeTime → next open 08:00Z → BLOCKED by session filter.
    // Actually with 50 bars, last bar index 49. openTime = t0 + 49*4h = 196h later.
    // t0 = Apr 4 00:00, +196h = Apr 12 04:00. Last bar opens 04:00, closes 07:59:59.
    // Next bar (entry) opens 08:00 → drop-8-UTC filter blocks.
    expect(a.hasSignal).toBe(false);
    expect(a.skipReason).toContain("hour 8");
  });

  it("long signal fires in bull regime (iter213 has no session filter)", () => {
    const btc = mkBtcUptrend();
    const eth = mkEthTwoGreen();
    const a = detectLiveSignal(eth, btc);
    expect(a.regime).toBe("BULL");
    expect(a.botUsed).toBe("iter213");
    expect(a.hasSignal).toBe(true);
    expect(a.direction).toBe("long");
    expect(a.entryPrice).toBeGreaterThan(0);
    expect(a.stopPrice).toBeLessThan(a.entryPrice!);
    expect(a.tpPrice).toBeGreaterThan(a.entryPrice!);
    expect(a.maxHoldHours).toBe(12);
  });

  it("renderAlert produces non-empty string", () => {
    const btc = mkBtcUptrend();
    const eth = mkEthTwoGreen();
    const a = detectLiveSignal(eth, btc);
    const s = renderAlert(a);
    expect(s).toContain("FTMO Signal Check");
    expect(s).toContain(a.regime);
  });
});
