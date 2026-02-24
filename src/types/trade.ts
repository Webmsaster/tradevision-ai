export interface Trade {
  id: string;
  pair: string;           // e.g. "BTC/USDT"
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryDate: string;      // ISO string
  exitDate: string;       // ISO string
  pnl: number;            // calculated
  pnlPercent: number;     // calculated
  fees: number;
  notes: string;
  tags: string[];
  leverage: number;
  strategy?: string;
  emotion?: 'confident' | 'neutral' | 'fearful' | 'greedy' | 'fomo' | 'revenge';
  confidence?: number;  // 1-5 scale
  setupType?: string;   // e.g. "breakout", "pullback", "reversal"
  timeframe?: string;   // e.g. "1m", "5m", "15m", "1h", "4h", "1d"
  marketCondition?: 'trending' | 'ranging' | 'volatile' | 'calm';
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
  avgHoldTime: number;    // in milliseconds
}

export interface AIInsight {
  id: string;
  type: 'warning' | 'positive' | 'neutral';
  title: string;
  description: string;
  severity: number;       // 1-10
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
