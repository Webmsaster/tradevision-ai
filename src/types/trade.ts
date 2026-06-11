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
  /**
   * R67-Final (R15-A3 perf): pre-parsed exitDate epoch-ms cache. Computed
   * at the storage boundary (`dbToTrade`) and lazy-populated by
   * `loadTrades()` for localStorage payloads. Optional so existing
   * localStorage data stays compatible. NEVER persisted — `tradeToDb`
   * omits this field, and `saveTrades` writes the trade as-is (the cache
   * is reconstituted on next load). Consumers that sort/format dates can
   * prefer this cached number over `new Date(t.exitDate).getTime()` to
   * avoid re-parsing on every render.
   */
  exitMs?: number;
  /**
   * R67-Final (R15-A3 perf): pre-parsed entryDate epoch-ms cache.
   * See `exitMs` for semantics.
   */
  entryMs?: number;
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
  // 2026-05-16 Round 9 WARN FIX (trade types agent): validate optional
  // enum fields too. Previously a JSON import payload with garbage
  // emotion ("blast") or marketCondition ("<script>") slipped through
  // because only required fields were validated. `dbToTrade` allowlists
  // these, but isValidTrade is also used at the JSON-import boundary
  // (see JSDoc). Mirror the allow-lists here.
  const emotionValid =
    t.emotion === undefined ||
    (typeof t.emotion === "string" &&
      ["confident", "neutral", "fearful", "greedy", "fomo", "revenge"].includes(
        t.emotion,
      ));
  const marketConditionValid =
    t.marketCondition === undefined ||
    (typeof t.marketCondition === "string" &&
      ["trending", "ranging", "volatile", "calm"].includes(t.marketCondition));
  const confidenceValid =
    t.confidence === undefined ||
    (typeof t.confidence === "number" &&
      Number.isFinite(t.confidence) &&
      t.confidence >= 1 &&
      t.confidence <= 5);
  const screenshotValid =
    t.screenshot === undefined || typeof t.screenshot === "string";
  const setupTypeValid =
    t.setupType === undefined || typeof t.setupType === "string";
  const timeframeValid =
    t.timeframe === undefined || typeof t.timeframe === "string";
  const strategyValid =
    t.strategy === undefined || typeof t.strategy === "string";
  const notesValid = t.notes === undefined || typeof t.notes === "string";
  // R67-Final (R15-A3 perf): exitMs/entryMs are an OPTIONAL pre-parsed
  // numeric cache populated at the storage boundary. Tolerate either
  // missing or finite-number values; reject anything else so corrupt
  // payloads can't poison sorts/formatters.
  const exitMsValid =
    t.exitMs === undefined ||
    (typeof t.exitMs === "number" && Number.isFinite(t.exitMs));
  const entryMsValid =
    t.entryMs === undefined ||
    (typeof t.entryMs === "number" && Number.isFinite(t.entryMs));
  return (
    exitMsValid &&
    entryMsValid &&
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
    // R67-r8 audit: dates must be parseable to a finite epoch-ms. Without
    // this, JSON re-imports with naive EU strings ("15.04.2026") slipped
    // through and propagated NaN through all stats/aggregates downstream.
    typeof t.entryDate === "string" &&
    Number.isFinite(new Date(t.entryDate).getTime()) &&
    typeof t.exitDate === "string" &&
    Number.isFinite(new Date(t.exitDate).getTime()) &&
    typeof t.pnl === "number" &&
    Number.isFinite(t.pnl) &&
    typeof t.pnlPercent === "number" &&
    Number.isFinite(t.pnlPercent) &&
    tagsValid &&
    accountIdValid &&
    emotionValid &&
    marketConditionValid &&
    confidenceValid &&
    screenshotValid &&
    setupTypeValid &&
    timeframeValid &&
    strategyValid &&
    notesValid
  );
}

export interface TradeStats {
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  /** null when undefined (e.g. wins but no losses) instead of Infinity. */
  riskReward: number | null;
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
