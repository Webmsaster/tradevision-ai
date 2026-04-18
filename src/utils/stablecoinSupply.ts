/**
 * Stablecoin Supply Signal.
 *
 * Research: Grobys & Huynh (2022) — "The effects of stablecoin transfers
 * on cryptocurrencies." Large USDT supply increases (mints) precede
 * bullish BTC moves over 24-48h; supply decreases (burns) are weaker
 * bearish signals.
 *
 * Mechanism: new USDT supply = new dollar liquidity entering crypto → BTC
 * demand spike within 12-48h as liquidity reaches exchanges.
 *
 * Data source: CoinGecko `/coins/{id}/market_chart` — free, returns up to
 * 365 days of daily market cap. Market-cap delta serves as proxy for net
 * mint/burn. No Etherscan scraping needed.
 *
 * Signal:
 *   - Day-over-day USDT market cap increases by > threshold → long BTC
 *   - Decrease < -threshold → short BTC (weaker, also fades slower)
 */

import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";

export interface SupplySample {
  timeMs: number;
  marketCapUsd: number;
  deltaUsd: number; // vs previous day
  deltaPct: number; // delta / prev market cap
}

export async function fetchUsdtSupplyHistory(
  days = 365,
): Promise<SupplySample[]> {
  const url = new URL(
    "https://api.coingecko.com/api/v3/coins/tether/market_chart",
  );
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("days", String(Math.min(days, 365)));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`CoinGecko USDT fetch failed: ${res.status}`);
  const json = (await res.json()) as { market_caps: [number, number][] };
  const rows = json.market_caps ?? [];
  const out: SupplySample[] = [];
  for (let i = 0; i < rows.length; i++) {
    const [ts, mcap] = rows[i];
    const prev = i > 0 ? rows[i - 1][1] : mcap;
    const delta = mcap - prev;
    const deltaPct = prev > 0 ? delta / prev : 0;
    out.push({
      timeMs: ts,
      marketCapUsd: mcap,
      deltaUsd: delta,
      deltaPct,
    });
  }
  return out;
}

export interface SupplyBacktestConfig {
  mintThresholdUsd: number; // 500_000_000 = $500M
  burnThresholdUsd: number; // -500_000_000
  holdBars: number; // 24 bars on 1h = 24h
  stopPct: number; // 0.02
  costs?: CostConfig;
  longOnly?: boolean;
}

export const DEFAULT_SUPPLY_CONFIG: SupplyBacktestConfig = {
  mintThresholdUsd: 500_000_000,
  burnThresholdUsd: -500_000_000,
  holdBars: 24,
  stopPct: 0.02,
  longOnly: false,
};

export interface SupplyTrade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  triggerDeltaUsd: number;
  netPnlPct: number;
  exitReason: "time" | "stop";
}

export interface SupplyReport {
  trades: SupplyTrade[];
  signalsFired: number;
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  meanDeltaUsd: number;
  stdDeltaUsd: number;
  maxMintUsd: number;
  maxBurnUsd: number;
}

export function runSupplyBacktest(
  supply: SupplySample[],
  btcCandles: Candle[],
  config: SupplyBacktestConfig = DEFAULT_SUPPLY_CONFIG,
): SupplyReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const sortedBtc = [...btcCandles].sort((a, b) => a.openTime - b.openTime);
  const trades: SupplyTrade[] = [];
  let signalsFired = 0;
  const deltas = supply.map((s) => s.deltaUsd);
  const meanD = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  const stdD = Math.sqrt(
    deltas.reduce((a, b) => a + (b - meanD) * (b - meanD), 0) /
      Math.max(1, deltas.length),
  );
  const maxMint = Math.max(...deltas);
  const maxBurn = Math.min(...deltas);

  for (const s of supply) {
    const fireLong = s.deltaUsd > config.mintThresholdUsd;
    const fireShort = !config.longOnly && s.deltaUsd < config.burnThresholdUsd;
    if (!fireLong && !fireShort) continue;
    signalsFired++;

    // Find BTC candle at or after the supply timestamp
    const entryIdx = sortedBtc.findIndex((c) => c.openTime >= s.timeMs);
    if (entryIdx < 0 || entryIdx + config.holdBars >= sortedBtc.length)
      continue;

    const direction: "long" | "short" = fireLong ? "long" : "short";
    const entry = sortedBtc[entryIdx].open;
    const stopLevel =
      direction === "long"
        ? entry * (1 - config.stopPct)
        : entry * (1 + config.stopPct);
    let exitIdx = entryIdx + config.holdBars;
    let exitReason: SupplyTrade["exitReason"] = "time";
    let exitPrice = sortedBtc[exitIdx].close;
    for (let j = entryIdx + 1; j <= exitIdx; j++) {
      const bar = sortedBtc[j];
      if (direction === "long" && bar.low <= stopLevel) {
        exitIdx = j;
        exitPrice = stopLevel;
        exitReason = "stop";
        break;
      }
      if (direction === "short" && bar.high >= stopLevel) {
        exitIdx = j;
        exitPrice = stopLevel;
        exitReason = "stop";
        break;
      }
    }

    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction,
      holdingHours: config.holdBars,
      config: costs,
    });
    trades.push({
      entryTime: sortedBtc[entryIdx].openTime,
      exitTime: sortedBtc[exitIdx].closeTime,
      direction,
      entry,
      exit: exitPrice,
      triggerDeltaUsd: s.deltaUsd,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
  }

  const returns = trades.map((t) => t.netPnlPct);
  const netRet = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;
  const gW = returns.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const gL = Math.abs(returns.filter((r) => r < 0).reduce((s, v) => s + v, 0));
  const pf = gL > 0 ? gW / gL : Infinity;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const sd = Math.sqrt(v);
  const periodDays =
    trades.length > 0
      ? (trades[trades.length - 1].exitTime - trades[0].entryTime) / 86400000
      : 365;
  const perYear = periodDays > 0 ? (trades.length / periodDays) * 365 : 0;
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0;

  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1] * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades,
    signalsFired,
    netReturnPct: netRet,
    winRate,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
    meanDeltaUsd: meanD,
    stdDeltaUsd: stdD,
    maxMintUsd: maxMint,
    maxBurnUsd: maxBurn,
  };
}
