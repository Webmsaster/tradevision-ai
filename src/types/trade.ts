export interface Trade {
  id: string;
  pair: string; // e.g. "BTC/USDT"
  direction: "long" | "short";
  /** Entry price in quote currency. Must be a positive finite number.
   *  @minimum 0 (exclusive) */
  entryPrice: number;
  /** Exit price in quote currency. Must be a positive finite number.
   *  @minimum 0 (exclusive) */
  exitPrice: number;
  /** Position size in base-currency units. Must be a positive finite number.
   *  @minimum 0 (exclusive) */
  quantity: number;
  entryDate: string; // ISO string
  exitDate: string; // ISO string
  pnl: number; // calculated
  pnlPercent: number; // calculated
  fees: number;
  notes: string;
  tags: string[];
  leverage: number;
  strategy?: string;
  emotion?: "confident" | "neutral" | "fearful" | "greedy" | "fomo" | "revenge";
  confidence?: number; // 1-5 scale
  setupType?: string; // e.g. "breakout", "pullback", "reversal"
  timeframe?: string; // e.g. "1m", "5m", "15m", "1h", "4h", "1d"
  marketCondition?: "trending" | "ranging" | "volatile" | "calm";
  screenshot?: string; // base64 data URL of an attached chart screenshot
  accountId?: string; // for multi-account support
}

/**
 * Round 6 audit (MEDIUM): runtime invariant check for the Trade shape.
 * Previously only enforced inside `storage.ts.isValidTrade` (DB-bound),
 * which left CSV/manual-form ingestion paths free to insert non-positive
 * `entryPrice` / `exitPrice` / `quantity` and produce NaN PnL downstream.
 * This is the canonical predicate; storage.ts re-uses it for JSON imports.
 *
 * Rejects:
 *  - non-finite numbers (NaN/Infinity)
 *  - non-positive entryPrice / exitPrice / quantity (zero or negative)
 *  - missing/wrong direction enum
 *  - non-string id/pair/dates
 *  - non-string-array tags
 */
export function isValidTrade(obj: unknown): obj is Trade {
  if (!obj || typeof obj !== "object") return false;
  const t = obj as Record<string, unknown>;
  const tagsValid =
    t.tags === undefined ||
    (Array.isArray(t.tags) && t.tags.every((x) => typeof x === "string"));
  const accountIdValid =
    t.accountId === undefined || typeof t.accountId === "string";
  return (
    typeof t.id === "string" &&
    typeof t.pair === "string" &&
    (t.direction === "long" || t.direction === "short") &&
    typeof t.entryPrice === "number" &&
    Number.isFinite(t.entryPrice) &&
    t.entryPrice > 0 &&
    typeof t.exitPrice === "number" &&
    Number.isFinite(t.exitPrice) &&
    t.exitPrice > 0 &&
    typeof t.quantity === "number" &&
    Number.isFinite(t.quantity) &&
    t.quantity > 0 &&
    typeof t.entryDate === "string" &&
    typeof t.exitDate === "string" &&
    typeof t.pnl === "number" &&
    Number.isFinite(t.pnl) &&
    typeof t.pnlPercent === "number" &&
    Number.isFinite(t.pnlPercent) &&
    tagsValid &&
    accountIdValid
  );
}

export interface TradeStats {
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  riskReward: number;
  expectancy: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  sharpeRatio: number;
  totalPnl: number;
  bestTrade: Trade | null;
  worstTrade: Trade | null;
  longestWinStreak: number;
  longestLossStreak: number;
  avgHoldTime: number; // in milliseconds
}

export interface AIInsight {
  id: string;
  type: "warning" | "positive" | "neutral";
  title: string;
  description: string;
  severity: number; // 1-10
  relatedTrades: string[];
  category: string;
}

export interface EquityCurvePoint {
  date: string;
  equity: number;
  drawdown: number;
}

export interface PerformanceByTime {
  label: string;
  trades: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
}

export interface CSVColumnMapping {
  pair: string;
  direction: string;
  entryPrice: string;
  exitPrice: string;
  quantity: string;
  entryDate: string;
  exitDate: string;
  fees: string;
  leverage: string;
}
