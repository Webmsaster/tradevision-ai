/**
 * Funding Carry Backtester (market-neutral).
 *
 * Strategy: when Binance perpetual funding is persistently positive (longs
 * paying shorts), open a cash-and-carry position: LONG spot + SHORT perp.
 * The short-perp pays no borrow cost and earns the funding-rate every 8h.
 * The long-spot matches direction → delta-neutral. P&L = cumulative funding
 * minus fees on the four legs (enter+exit × spot+perp).
 *
 * Research basis:
 *   - Alexander, Deng, Zou (2023) "Bitcoin Futures Basis Trading" (IJFA):
 *     documented 8-15% p.a. net-of-fees on BTC/ETH perp basis.
 *   - Franz & Valentin (2024, SSRN 4756124) "Crypto Carry": replicated
 *     across 20+ major perp pairs.
 *
 * Why it works: structural retail long-bias in crypto perpetuals → funding
 * is positive ~70% of the time on majors. Capturing it with a neutral hedge
 * removes directional risk. The trade only loses if funding flips sharply
 * negative for an extended stretch.
 *
 * Entry rule: funding > entryThreshold for N consecutive periods.
 * Exit rule:  funding < exitThreshold (or flips negative).
 */

import { fetchFundingHistory, type FundingEvent } from "@/utils/fundingRate";

export interface CarryConfig {
  entryThreshold: number; // e.g. 0.0002 = 0.02%/8h (~22% annualised)
  exitThreshold: number; // e.g. 0.00005 = 0.005%/8h (~5% annualised)
  consecutiveEntryPeriods: number; // require N periods above threshold to enter
  perLegFee: number; // one-way fee, applied 4× (open spot, open perp, close spot, close perp)
}

export const DEFAULT_CARRY_CONFIG: CarryConfig = {
  entryThreshold: 0.0002,
  exitThreshold: 0.00005,
  consecutiveEntryPeriods: 3,
  perLegFee: 0.0004, // 0.04% taker
};

export interface CarryTrade {
  symbol: string;
  openTime: number;
  closeTime: number;
  periods: number;
  grossCarryPct: number; // sum of funding rates collected (always positive on a profitable trade)
  feesPct: number;
  netCarryPct: number;
  annualisedPct: number;
  side: "long-basis" | "short-basis"; // long-basis = short-perp+long-spot; short-basis = long-perp+short-spot
}

export interface CarryReport {
  symbol: string;
  trades: CarryTrade[];
  totalPeriods: number;
  periodsInTrade: number;
  grossCarryPct: number;
  feesPct: number;
  netCarryPct: number;
  annualisedPct: number;
  maxDrawdownPct: number;
  equityCurve: number[];
  fundingPositivePct: number; // share of periods where funding > 0
  meanFunding: number;
  medianFunding: number;
}

function computeStats(funding: FundingEvent[]): {
  positivePct: number;
  mean: number;
  median: number;
} {
  const rates = funding.map((e) => e.fundingRate);
  const positive = rates.filter((r) => r > 0).length;
  const mean = rates.reduce((s, v) => s + v, 0) / Math.max(1, rates.length);
  const sorted = [...rates].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return {
    positivePct: rates.length ? positive / rates.length : 0,
    mean,
    median,
  };
}

export function runFundingCarryBacktest(
  symbol: string,
  funding: FundingEvent[],
  config: CarryConfig = DEFAULT_CARRY_CONFIG,
): CarryReport {
  const sorted = [...funding].sort((a, b) => a.fundingTime - b.fundingTime);
  const trades: CarryTrade[] = [];
  const equity = [1];
  let inPosition: "long-basis" | "short-basis" | null = null;
  let posStart = -1;
  let posCarry = 0;
  let longConsec = 0;
  let shortConsec = 0;
  let periodsInTrade = 0;

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];

    if (inPosition === null) {
      // Track consecutive streaks in both directions
      if (ev.fundingRate > config.entryThreshold) {
        longConsec++;
        shortConsec = 0;
        if (longConsec >= config.consecutiveEntryPeriods) {
          inPosition = "long-basis";
          posStart = i;
          posCarry = 0;
        }
      } else if (ev.fundingRate < -config.entryThreshold) {
        shortConsec++;
        longConsec = 0;
        if (shortConsec >= config.consecutiveEntryPeriods) {
          inPosition = "short-basis";
          posStart = i;
          posCarry = 0;
        }
      } else {
        longConsec = 0;
        shortConsec = 0;
      }
      equity.push(equity[equity.length - 1]!);
      continue;
    }

    // In position: the carry we collect depends on side.
    // long-basis (short-perp+long-spot) → earns ev.fundingRate (positive when funding>0)
    // short-basis (long-perp+short-spot) → earns -ev.fundingRate (positive when funding<0)
    const perPeriodCarry =
      inPosition === "long-basis" ? ev.fundingRate : -ev.fundingRate;
    posCarry += perPeriodCarry;
    periodsInTrade++;

    // Exit when funding leaves the favourable zone
    const shouldExit =
      inPosition === "long-basis"
        ? ev.fundingRate < config.exitThreshold
        : ev.fundingRate > -config.exitThreshold;

    if (shouldExit || i === sorted.length - 1) {
      const fees = config.perLegFee * 4;
      const net = posCarry - fees;
      const periods = i - posStart + 1;
      const ann = periods > 0 ? (net / periods) * 3 * 365 : 0;
      trades.push({
        symbol,
        openTime: sorted[posStart]!.fundingTime,
        closeTime: ev.fundingTime,
        periods,
        grossCarryPct: posCarry,
        feesPct: fees,
        netCarryPct: net,
        annualisedPct: ann,
        side: inPosition,
      });
      equity.push(equity[equity.length - 1]! * (1 + net));
      inPosition = null;
      posStart = -1;
      posCarry = 0;
      longConsec = 0;
      shortConsec = 0;
    } else {
      equity.push(equity[equity.length - 1]! * (1 + perPeriodCarry));
    }
  }

  const totalNet = trades.reduce((s, t) => s + t.netCarryPct, 0);
  const totalGross = trades.reduce((s, t) => s + t.grossCarryPct, 0);
  const totalFees = trades.reduce((s, t) => s + t.feesPct, 0);
  const totalPeriods = sorted.length;
  const annualised =
    periodsInTrade > 0 ? (totalNet / periodsInTrade) * 3 * 365 : 0;

  // Max drawdown on the equity curve
  let peak = 1;
  let maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const stats = computeStats(sorted);

  return {
    symbol,
    trades,
    totalPeriods,
    periodsInTrade,
    grossCarryPct: totalGross,
    feesPct: totalFees,
    netCarryPct: totalNet,
    annualisedPct: annualised,
    maxDrawdownPct: maxDd,
    equityCurve: equity,
    fundingPositivePct: stats.positivePct,
    meanFunding: stats.mean,
    medianFunding: stats.median,
  };
}

export async function fetchAndBacktestCarry(
  symbol: string,
  periods = 3000,
  config: CarryConfig = DEFAULT_CARRY_CONFIG,
): Promise<CarryReport> {
  // Binance /fundingRate returns max 200 rows per call regardless of `limit`.
  // We page backwards using `endTime` set to oldest-1 from the previous page
  // until we've collected `periods` rows or hit the start of listed history.
  const all: FundingEvent[] = [];
  const seen = new Set<number>();
  let endTime: number | undefined = undefined;
  const maxPages = Math.ceil(periods / 200) + 5;

  for (let page = 0; page < maxPages && all.length < periods; page++) {
    const url = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("limit", "1000");
    if (endTime !== undefined) url.searchParams.set("endTime", String(endTime));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Binance funding fetch failed: ${res.status}`);
    const rows: { fundingTime: number; fundingRate: string; symbol: string }[] =
      await res.json();
    if (!rows || rows.length === 0) break;
    const fresh: FundingEvent[] = [];
    for (const r of rows) {
      if (!seen.has(r.fundingTime)) {
        seen.add(r.fundingTime);
        fresh.push({
          symbol: r.symbol,
          fundingTime: r.fundingTime,
          fundingRate: parseFloat(r.fundingRate),
        });
      }
    }
    if (fresh.length === 0) break;
    all.unshift(...fresh);
    // Go one ms earlier than the oldest row of THIS batch
    const oldest = rows[0]!.fundingTime;
    endTime = oldest - 1;
  }

  const sorted = all
    .sort((a, b) => a.fundingTime - b.fundingTime)
    .slice(-periods);
  return runFundingCarryBacktest(symbol, sorted, config);
}

// Re-export for callers that already consume funding history directly
export { fetchFundingHistory };
