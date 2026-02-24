import { Trade } from '@/types/trade';

// =============================================================================
// Sample Trades for Demo Mode
// 55+ realistic crypto trades spanning 2024-06-01 to 2024-12-15
//
// Intentional patterns embedded for AI insight detection:
//   1. Revenge Trading (trades #15-#18): 3 consecutive losses then oversized position
//   2. Holding Losers: winning trades held 2-8h, losing trades held 24-72h
//   3. Bad Time Trading: 5+ trades entered 2-4 AM UTC, mostly losses
//   4. Overleverage After Wins: winning streak #30-#33, then #34 uses 10x leverage
//   5. Loss Aversion: small wins (+1-2%) but large losses (-3-5%)
//   6. BTC/USDT consistency: ~70% win rate across 10+ trades
//
// PnL formulas:
//   Long:  pnl = (exitPrice - entryPrice) * quantity * leverage - fees
//   Short: pnl = (entryPrice - exitPrice) * quantity * leverage - fees
//   pnlPercent = pnl / (entryPrice * quantity) * 100
// =============================================================================

export const sampleTrades: Trade[] = [
  // ===== TRADE #1 — BTC/USDT Long WIN =====
  {
    id: 'sample-1',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 67500,
    exitPrice: 68400,
    quantity: 0.05,
    entryDate: '2024-06-01T10:30:00Z',
    exitDate: '2024-06-01T14:15:00Z',
    // pnl = (68400 - 67500) * 0.05 * 2 - 4.50 = 900 * 0.05 * 2 - 4.50 = 90 - 4.50 = 85.50
    pnl: 85.50,
    // pnlPercent = 85.50 / (67500 * 0.05) * 100 = 85.50 / 3375 * 100 = 2.533...
    pnlPercent: 2.53,
    fees: 4.50,
    notes: 'Breakout trade above resistance',
    tags: ['breakout', 'trend'],
    leverage: 2,
  },

  // ===== TRADE #2 — ETH/USDT Long WIN =====
  {
    id: 'sample-2',
    pair: 'ETH/USDT',
    direction: 'long',
    entryPrice: 3450,
    exitPrice: 3510,
    quantity: 0.5,
    entryDate: '2024-06-03T08:00:00Z',
    exitDate: '2024-06-03T12:30:00Z',
    // pnl = (3510 - 3450) * 0.5 * 2 - 3.20 = 60 * 0.5 * 2 - 3.20 = 60 - 3.20 = 56.80
    pnl: 56.80,
    // pnlPercent = 56.80 / (3450 * 0.5) * 100 = 56.80 / 1725 * 100 = 3.293...
    pnlPercent: 3.29,
    fees: 3.20,
    notes: 'Support bounce off 200 EMA',
    tags: ['support', 'trend'],
    leverage: 2,
  },

  // ===== TRADE #3 — SOL/USDT Long WIN =====
  {
    id: 'sample-3',
    pair: 'SOL/USDT',
    direction: 'long',
    entryPrice: 145,
    exitPrice: 148.50,
    quantity: 5,
    entryDate: '2024-06-05T15:00:00Z',
    exitDate: '2024-06-05T19:00:00Z',
    // pnl = (148.50 - 145) * 5 * 3 - 2.80 = 3.50 * 5 * 3 - 2.80 = 52.50 - 2.80 = 49.70
    pnl: 49.70,
    // pnlPercent = 49.70 / (145 * 5) * 100 = 49.70 / 725 * 100 = 6.855...
    pnlPercent: 6.86,
    fees: 2.80,
    notes: 'Followed the trend',
    tags: ['trend'],
    leverage: 3,
  },

  // ===== TRADE #4 — BTC/USDT Short LOSS (Loss Aversion: large loss -3.7%) =====
  {
    id: 'sample-4',
    pair: 'BTC/USDT',
    direction: 'short',
    entryPrice: 68000,
    exitPrice: 70500,
    quantity: 0.04,
    entryDate: '2024-06-07T11:00:00Z',
    exitDate: '2024-06-09T11:00:00Z', // Holding loser: 48h
    // pnl = (68000 - 70500) * 0.04 * 2 - 5.00 = (-2500) * 0.04 * 2 - 5.00 = -200 - 5.00 = -205.00
    pnl: -205.00,
    // pnlPercent = -205.00 / (68000 * 0.04) * 100 = -205.00 / 2720 * 100 = -7.536...
    pnlPercent: -7.54,
    fees: 5.00,
    notes: 'Held too long hoping for reversal',
    tags: ['counter-trend'],
    leverage: 2,
  },

  // ===== TRADE #5 — DOGE/USDT Long WIN (small win +1.2%) =====
  {
    id: 'sample-5',
    pair: 'DOGE/USDT',
    direction: 'long',
    entryPrice: 0.14,
    exitPrice: 0.1420,
    quantity: 5000,
    entryDate: '2024-06-10T09:30:00Z',
    exitDate: '2024-06-10T13:00:00Z',
    // pnl = (0.1420 - 0.14) * 5000 * 2 - 1.50 = 0.002 * 5000 * 2 - 1.50 = 20 - 1.50 = 18.50
    pnl: 18.50,
    // pnlPercent = 18.50 / (0.14 * 5000) * 100 = 18.50 / 700 * 100 = 2.643
    pnlPercent: 2.64,
    fees: 1.50,
    notes: 'Quick scalp',
    tags: ['scalp'],
    leverage: 2,
  },

  // ===== TRADE #6 — XRP/USDT Long LOSS (Loss Aversion: large loss) =====
  {
    id: 'sample-6',
    pair: 'XRP/USDT',
    direction: 'long',
    entryPrice: 0.52,
    exitPrice: 0.495,
    quantity: 2000,
    entryDate: '2024-06-12T14:00:00Z',
    exitDate: '2024-06-14T14:00:00Z', // Holding loser: 48h
    // pnl = (0.495 - 0.52) * 2000 * 2 - 1.80 = (-0.025) * 2000 * 2 - 1.80 = -100 - 1.80 = -101.80
    pnl: -101.80,
    // pnlPercent = -101.80 / (0.52 * 2000) * 100 = -101.80 / 1040 * 100 = -9.788
    pnlPercent: -9.79,
    fees: 1.80,
    notes: 'Should have cut losses sooner',
    tags: ['swing'],
    leverage: 2,
  },

  // ===== TRADE #7 — BTC/USDT Long WIN =====
  {
    id: 'sample-7',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 69000,
    exitPrice: 69800,
    quantity: 0.06,
    entryDate: '2024-06-15T10:00:00Z',
    exitDate: '2024-06-15T16:00:00Z',
    // pnl = (69800 - 69000) * 0.06 * 2 - 5.50 = 800 * 0.06 * 2 - 5.50 = 96 - 5.50 = 90.50
    pnl: 90.50,
    // pnlPercent = 90.50 / (69000 * 0.06) * 100 = 90.50 / 4140 * 100 = 2.186
    pnlPercent: 2.19,
    fees: 5.50,
    notes: 'Followed the trend',
    tags: ['trend'],
    leverage: 2,
  },

  // ===== TRADE #8 — BNB/USDT Short WIN =====
  {
    id: 'sample-8',
    pair: 'BNB/USDT',
    direction: 'short',
    entryPrice: 590,
    exitPrice: 578,
    quantity: 2,
    entryDate: '2024-06-17T13:00:00Z',
    exitDate: '2024-06-17T18:30:00Z',
    // pnl = (590 - 578) * 2 * 2 - 2.40 = 12 * 2 * 2 - 2.40 = 48 - 2.40 = 45.60
    pnl: 45.60,
    // pnlPercent = 45.60 / (590 * 2) * 100 = 45.60 / 1180 * 100 = 3.864
    pnlPercent: 3.86,
    fees: 2.40,
    notes: 'Rejection at resistance',
    tags: ['resistance', 'scalp'],
    leverage: 2,
  },

  // ===== TRADE #9 — AVAX/USDT Long LOSS =====
  {
    id: 'sample-9',
    pair: 'AVAX/USDT',
    direction: 'long',
    entryPrice: 35.00,
    exitPrice: 33.80,
    quantity: 20,
    entryDate: '2024-06-19T16:00:00Z',
    exitDate: '2024-06-21T10:00:00Z', // Holding loser: ~42h
    // pnl = (33.80 - 35.00) * 20 * 2 - 1.80 = (-1.20) * 20 * 2 - 1.80 = -48 - 1.80 = -49.80
    pnl: -49.80,
    // pnlPercent = -49.80 / (35.00 * 20) * 100 = -49.80 / 700 * 100 = -7.114
    pnlPercent: -7.11,
    fees: 1.80,
    notes: '',
    tags: ['swing'],
    leverage: 2,
  },

  // ===== TRADE #10 — BTC/USDT Long WIN (Bad Time: 3 AM but this one wins) =====
  {
    id: 'sample-10',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 64500,
    exitPrice: 65200,
    quantity: 0.05,
    entryDate: '2024-06-22T03:15:00Z', // Bad time: 3:15 AM UTC
    exitDate: '2024-06-22T08:00:00Z',
    // pnl = (65200 - 64500) * 0.05 * 2 - 4.20 = 700 * 0.05 * 2 - 4.20 = 70 - 4.20 = 65.80
    pnl: 65.80,
    // pnlPercent = 65.80 / (64500 * 0.05) * 100 = 65.80 / 3225 * 100 = 2.040
    pnlPercent: 2.04,
    fees: 4.20,
    notes: 'Late night trade, got lucky',
    tags: ['late-night'],
    leverage: 2,
  },

  // ===== TRADE #11 — ETH/USDT Short LOSS (Bad Time: 2:30 AM) =====
  {
    id: 'sample-11',
    pair: 'ETH/USDT',
    direction: 'short',
    entryPrice: 3380,
    exitPrice: 3440,
    quantity: 0.8,
    entryDate: '2024-06-24T02:30:00Z', // Bad time: 2:30 AM UTC
    exitDate: '2024-06-24T06:00:00Z',
    // pnl = (3380 - 3440) * 0.8 * 2 - 3.50 = (-60) * 0.8 * 2 - 3.50 = -96 - 3.50 = -99.50
    pnl: -99.50,
    // pnlPercent = -99.50 / (3380 * 0.8) * 100 = -99.50 / 2704 * 100 = -3.679
    pnlPercent: -3.68,
    fees: 3.50,
    notes: 'Tired, bad decision',
    tags: ['late-night'],
    leverage: 2,
  },

  // ===== TRADE #12 — SOL/USDT Short LOSS =====
  {
    id: 'sample-12',
    pair: 'SOL/USDT',
    direction: 'short',
    entryPrice: 155,
    exitPrice: 160,
    quantity: 4,
    entryDate: '2024-06-26T11:00:00Z',
    exitDate: '2024-06-27T17:00:00Z', // Holding loser: 30h
    // pnl = (155 - 160) * 4 * 2 - 2.00 = (-5) * 4 * 2 - 2.00 = -40 - 2.00 = -42.00
    pnl: -42.00,
    // pnlPercent = -42.00 / (155 * 4) * 100 = -42.00 / 620 * 100 = -6.774
    pnlPercent: -6.77,
    fees: 2.00,
    notes: 'Shorted too early in uptrend',
    tags: ['counter-trend'],
    leverage: 2,
  },

  // ===== TRADE #13 — BTC/USDT Long WIN =====
  {
    id: 'sample-13',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 62000,
    exitPrice: 63100,
    quantity: 0.04,
    entryDate: '2024-06-28T09:00:00Z',
    exitDate: '2024-06-28T15:00:00Z',
    // pnl = (63100 - 62000) * 0.04 * 3 - 5.00 = 1100 * 0.04 * 3 - 5.00 = 132 - 5.00 = 127.00
    pnl: 127.00,
    // pnlPercent = 127.00 / (62000 * 0.04) * 100 = 127.00 / 2480 * 100 = 5.121
    pnlPercent: 5.12,
    fees: 5.00,
    notes: 'Strong breakout with volume',
    tags: ['breakout', 'trend'],
    leverage: 3,
  },

  // ===== TRADE #14 — MATIC/USDT Long LOSS =====
  {
    id: 'sample-14',
    pair: 'MATIC/USDT',
    direction: 'long',
    entryPrice: 0.72,
    exitPrice: 0.695,
    quantity: 1000,
    entryDate: '2024-07-01T12:00:00Z',
    exitDate: '2024-07-03T08:00:00Z', // Holding loser: 44h
    // pnl = (0.695 - 0.72) * 1000 * 2 - 1.50 = (-0.025) * 1000 * 2 - 1.50 = -50 - 1.50 = -51.50
    pnl: -51.50,
    // pnlPercent = -51.50 / (0.72 * 1000) * 100 = -51.50 / 720 * 100 = -7.153
    pnlPercent: -7.15,
    fees: 1.50,
    notes: 'Thought it would bounce',
    tags: ['swing'],
    leverage: 2,
  },

  // ==========================================================================
  // REVENGE TRADING PATTERN (trades #15-#18):
  // Three consecutive losses (#15, #16, #17) followed by an oversized position (#18)
  // ==========================================================================

  // ===== TRADE #15 — ETH/USDT Long LOSS (1st consecutive loss) =====
  {
    id: 'sample-15',
    pair: 'ETH/USDT',
    direction: 'long',
    entryPrice: 3200,
    exitPrice: 3120,
    quantity: 0.6,
    entryDate: '2024-07-04T10:00:00Z',
    exitDate: '2024-07-04T16:00:00Z',
    // pnl = (3120 - 3200) * 0.6 * 2 - 3.00 = (-80) * 0.6 * 2 - 3.00 = -96 - 3.00 = -99.00
    pnl: -99.00,
    // pnlPercent = -99.00 / (3200 * 0.6) * 100 = -99.00 / 1920 * 100 = -5.156
    pnlPercent: -5.16,
    fees: 3.00,
    notes: 'Stopped out at support',
    tags: ['support'],
    leverage: 2,
  },

  // ===== TRADE #16 — SOL/USDT Short LOSS (2nd consecutive loss) =====
  {
    id: 'sample-16',
    pair: 'SOL/USDT',
    direction: 'short',
    entryPrice: 140,
    exitPrice: 147,
    quantity: 5,
    entryDate: '2024-07-05T09:00:00Z',
    exitDate: '2024-07-05T14:00:00Z',
    // pnl = (140 - 147) * 5 * 2 - 2.00 = (-7) * 5 * 2 - 2.00 = -70 - 2.00 = -72.00
    pnl: -72.00,
    // pnlPercent = -72.00 / (140 * 5) * 100 = -72.00 / 700 * 100 = -10.286
    pnlPercent: -10.29,
    fees: 2.00,
    notes: 'Wrong direction, market pumped',
    tags: ['counter-trend'],
    leverage: 2,
  },

  // ===== TRADE #17 — BNB/USDT Long LOSS (3rd consecutive loss) =====
  {
    id: 'sample-17',
    pair: 'BNB/USDT',
    direction: 'long',
    entryPrice: 560,
    exitPrice: 545,
    quantity: 2,
    entryDate: '2024-07-06T11:00:00Z',
    exitDate: '2024-07-06T17:00:00Z',
    // pnl = (545 - 560) * 2 * 2 - 2.50 = (-15) * 2 * 2 - 2.50 = -60 - 2.50 = -62.50
    pnl: -62.50,
    // pnlPercent = -62.50 / (560 * 2) * 100 = -62.50 / 1120 * 100 = -5.580
    pnlPercent: -5.58,
    fees: 2.50,
    notes: 'Another loss, frustrated',
    tags: [],
    leverage: 2,
  },

  // ===== TRADE #18 — ETH/USDT Long LOSS (REVENGE TRADE: 2.5x normal quantity!) =====
  {
    id: 'sample-18',
    pair: 'ETH/USDT',
    direction: 'long',
    entryPrice: 3100,
    exitPrice: 3020,
    quantity: 1.5, // Normal is ~0.5-0.8, this is 2-3x oversized
    entryDate: '2024-07-06T19:00:00Z', // Same day as #17 — emotional
    exitDate: '2024-07-07T02:00:00Z',
    // pnl = (3020 - 3100) * 1.5 * 3 - 8.00 = (-80) * 1.5 * 3 - 8.00 = -360 - 8.00 = -368.00
    pnl: -368.00,
    // pnlPercent = -368.00 / (3100 * 1.5) * 100 = -368.00 / 4650 * 100 = -7.914
    pnlPercent: -7.91,
    fees: 8.00,
    notes: 'Revenge trade - tried to win back losses with bigger size',
    tags: ['revenge', 'emotional'],
    leverage: 3,
  },

  // ==========================================================================
  // Recovery / Mixed trades #19-#29
  // ==========================================================================

  // ===== TRADE #19 — BTC/USDT Long WIN =====
  {
    id: 'sample-19',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 57500,
    exitPrice: 58200,
    quantity: 0.05,
    entryDate: '2024-07-10T10:00:00Z',
    exitDate: '2024-07-10T15:30:00Z',
    // pnl = (58200 - 57500) * 0.05 * 2 - 4.00 = 700 * 0.05 * 2 - 4.00 = 70 - 4.00 = 66.00
    pnl: 66.00,
    // pnlPercent = 66.00 / (57500 * 0.05) * 100 = 66.00 / 2875 * 100 = 2.296
    pnlPercent: 2.30,
    fees: 4.00,
    notes: 'Back to basics, smaller size',
    tags: ['trend'],
    leverage: 2,
  },

  // ===== TRADE #20 — DOGE/USDT Short LOSS =====
  {
    id: 'sample-20',
    pair: 'DOGE/USDT',
    direction: 'short',
    entryPrice: 0.12,
    exitPrice: 0.1260,
    quantity: 5000,
    entryDate: '2024-07-12T08:00:00Z',
    exitDate: '2024-07-13T14:00:00Z', // Holding loser: 30h
    // pnl = (0.12 - 0.1260) * 5000 * 1 - 1.20 = (-0.006) * 5000 * 1 - 1.20 = -30 - 1.20 = -31.20
    pnl: -31.20,
    // pnlPercent = -31.20 / (0.12 * 5000) * 100 = -31.20 / 600 * 100 = -5.200
    pnlPercent: -5.20,
    fees: 1.20,
    notes: 'Shorted meme coin, got squeezed',
    tags: ['counter-trend'],
    leverage: 1,
  },

  // ===== TRADE #21 — SOL/USDT Long WIN =====
  {
    id: 'sample-21',
    pair: 'SOL/USDT',
    direction: 'long',
    entryPrice: 135,
    exitPrice: 139,
    quantity: 6,
    entryDate: '2024-07-15T14:00:00Z',
    exitDate: '2024-07-15T20:00:00Z',
    // pnl = (139 - 135) * 6 * 2 - 2.50 = 4 * 6 * 2 - 2.50 = 48 - 2.50 = 45.50
    pnl: 45.50,
    // pnlPercent = 45.50 / (135 * 6) * 100 = 45.50 / 810 * 100 = 5.617
    pnlPercent: 5.62,
    fees: 2.50,
    notes: 'Followed the trend',
    tags: ['trend'],
    leverage: 2,
  },

  // ===== TRADE #22 — XRP/USDT Short LOSS (Bad Time: 3:45 AM, holding loser) =====
  {
    id: 'sample-22',
    pair: 'XRP/USDT',
    direction: 'short',
    entryPrice: 0.58,
    exitPrice: 0.61,
    quantity: 2000,
    entryDate: '2024-07-17T03:45:00Z', // Bad time: 3:45 AM UTC
    exitDate: '2024-07-18T15:00:00Z', // Holding loser: ~35h
    // pnl = (0.58 - 0.61) * 2000 * 2 - 1.80 = (-0.03) * 2000 * 2 - 1.80 = -120 - 1.80 = -121.80
    pnl: -121.80,
    // pnlPercent = -121.80 / (0.58 * 2000) * 100 = -121.80 / 1160 * 100 = -10.500
    pnlPercent: -10.50,
    fees: 1.80,
    notes: 'Late night short, held way too long',
    tags: ['late-night', 'swing'],
    leverage: 2,
  },

  // ===== TRADE #23 — BTC/USDT Long WIN =====
  {
    id: 'sample-23',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 59000,
    exitPrice: 59900,
    quantity: 0.04,
    entryDate: '2024-07-20T09:30:00Z',
    exitDate: '2024-07-20T14:00:00Z',
    // pnl = (59900 - 59000) * 0.04 * 2 - 3.80 = 900 * 0.04 * 2 - 3.80 = 72 - 3.80 = 68.20
    pnl: 68.20,
    // pnlPercent = 68.20 / (59000 * 0.04) * 100 = 68.20 / 2360 * 100 = 2.890
    pnlPercent: 2.89,
    fees: 3.80,
    notes: '',
    tags: ['trend'],
    leverage: 2,
  },

  // ===== TRADE #24 — ETH/USDT Long LOSS (Loss Aversion: -4.2% loss) =====
  {
    id: 'sample-24',
    pair: 'ETH/USDT',
    direction: 'long',
    entryPrice: 3300,
    exitPrice: 3180,
    quantity: 0.7,
    entryDate: '2024-07-22T12:00:00Z',
    exitDate: '2024-07-24T12:00:00Z', // Holding loser: 48h
    // pnl = (3180 - 3300) * 0.7 * 2 - 4.00 = (-120) * 0.7 * 2 - 4.00 = -168 - 4.00 = -172.00
    pnl: -172.00,
    // pnlPercent = -172.00 / (3300 * 0.7) * 100 = -172.00 / 2310 * 100 = -7.446
    pnlPercent: -7.45,
    fees: 4.00,
    notes: 'Held hoping for recovery, should have stopped out',
    tags: ['swing'],
    leverage: 2,
  },

  // ===== TRADE #25 — BTC/USDT Short WIN =====
  {
    id: 'sample-25',
    pair: 'BTC/USDT',
    direction: 'short',
    entryPrice: 66000,
    exitPrice: 65100,
    quantity: 0.03,
    entryDate: '2024-07-26T10:00:00Z',
    exitDate: '2024-07-26T14:30:00Z',
    // pnl = (66000 - 65100) * 0.03 * 2 - 3.00 = 900 * 0.03 * 2 - 3.00 = 54 - 3.00 = 51.00
    pnl: 51.00,
    // pnlPercent = 51.00 / (66000 * 0.03) * 100 = 51.00 / 1980 * 100 = 2.576
    pnlPercent: 2.58,
    fees: 3.00,
    notes: 'Resistance rejection, clean setup',
    tags: ['resistance'],
    leverage: 2,
  },

  // ===== TRADE #26 — AVAX/USDT Long LOSS (Bad Time: 2:10 AM) =====
  {
    id: 'sample-26',
    pair: 'AVAX/USDT',
    direction: 'long',
    entryPrice: 28.00,
    exitPrice: 26.80,
    quantity: 25,
    entryDate: '2024-07-28T02:10:00Z', // Bad time: 2:10 AM UTC
    exitDate: '2024-07-28T10:00:00Z',
    // pnl = (26.80 - 28.00) * 25 * 2 - 1.50 = (-1.20) * 25 * 2 - 1.50 = -60 - 1.50 = -61.50
    pnl: -61.50,
    // pnlPercent = -61.50 / (28.00 * 25) * 100 = -61.50 / 700 * 100 = -8.786
    pnlPercent: -8.79,
    fees: 1.50,
    notes: 'Couldnt sleep, entered impulsively',
    tags: ['late-night', 'emotional'],
    leverage: 2,
  },

  // ===== TRADE #27 — BNB/USDT Long WIN =====
  {
    id: 'sample-27',
    pair: 'BNB/USDT',
    direction: 'long',
    entryPrice: 540,
    exitPrice: 552,
    quantity: 2,
    entryDate: '2024-08-01T10:00:00Z',
    exitDate: '2024-08-01T16:00:00Z',
    // pnl = (552 - 540) * 2 * 2 - 2.20 = 12 * 2 * 2 - 2.20 = 48 - 2.20 = 45.80
    pnl: 45.80,
    // pnlPercent = 45.80 / (540 * 2) * 100 = 45.80 / 1080 * 100 = 4.241
    pnlPercent: 4.24,
    fees: 2.20,
    notes: 'Clean breakout above range',
    tags: ['breakout'],
    leverage: 2,
  },

  // ===== TRADE #28 — DOGE/USDT Short LOSS (Bad Time: 3:20 AM) =====
  {
    id: 'sample-28',
    pair: 'DOGE/USDT',
    direction: 'short',
    entryPrice: 0.11,
    exitPrice: 0.1150,
    quantity: 8000,
    entryDate: '2024-08-03T03:20:00Z', // Bad time: 3:20 AM UTC
    exitDate: '2024-08-03T08:00:00Z',
    // pnl = (0.11 - 0.1150) * 8000 * 1 - 1.50 = (-0.005) * 8000 * 1 - 1.50 = -40 - 1.50 = -41.50
    pnl: -41.50,
    // pnlPercent = -41.50 / (0.11 * 8000) * 100 = -41.50 / 880 * 100 = -4.716
    pnlPercent: -4.72,
    fees: 1.50,
    notes: 'Insomniac trade',
    tags: ['late-night'],
    leverage: 1,
  },

  // ===== TRADE #29 — SOL/USDT Short WIN =====
  {
    id: 'sample-29',
    pair: 'SOL/USDT',
    direction: 'short',
    entryPrice: 170,
    exitPrice: 163,
    quantity: 4,
    entryDate: '2024-08-06T11:00:00Z',
    exitDate: '2024-08-06T17:00:00Z',
    // pnl = (170 - 163) * 4 * 2 - 2.20 = 7 * 4 * 2 - 2.20 = 56 - 2.20 = 53.80
    pnl: 53.80,
    // pnlPercent = 53.80 / (170 * 4) * 100 = 53.80 / 680 * 100 = 7.912
    pnlPercent: 7.91,
    fees: 2.20,
    notes: 'Bearish divergence on RSI',
    tags: ['divergence'],
    leverage: 2,
  },

  // ==========================================================================
  // WINNING STREAK + OVERLEVERAGE PATTERN (trades #30-#34):
  // 4 wins in a row (#30-#33) then overleverage on #34 (10x)
  // ==========================================================================

  // ===== TRADE #30 — BTC/USDT Long WIN (streak 1/4) =====
  {
    id: 'sample-30',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 61000,
    exitPrice: 61800,
    quantity: 0.05,
    entryDate: '2024-08-10T09:00:00Z',
    exitDate: '2024-08-10T13:00:00Z',
    // pnl = (61800 - 61000) * 0.05 * 2 - 4.00 = 800 * 0.05 * 2 - 4.00 = 80 - 4.00 = 76.00
    pnl: 76.00,
    // pnlPercent = 76.00 / (61000 * 0.05) * 100 = 76.00 / 3050 * 100 = 2.492
    pnlPercent: 2.49,
    fees: 4.00,
    notes: 'Breakout trade',
    tags: ['breakout'],
    leverage: 2,
  },

  // ===== TRADE #31 — ETH/USDT Long WIN (streak 2/4) =====
  {
    id: 'sample-31',
    pair: 'ETH/USDT',
    direction: 'long',
    entryPrice: 2900,
    exitPrice: 2960,
    quantity: 0.8,
    entryDate: '2024-08-12T10:00:00Z',
    exitDate: '2024-08-12T16:00:00Z',
    // pnl = (2960 - 2900) * 0.8 * 3 - 3.50 = 60 * 0.8 * 3 - 3.50 = 144 - 3.50 = 140.50
    pnl: 140.50,
    // pnlPercent = 140.50 / (2900 * 0.8) * 100 = 140.50 / 2320 * 100 = 6.056
    pnlPercent: 6.06,
    fees: 3.50,
    notes: 'Trend continuation, perfect entry',
    tags: ['trend'],
    leverage: 3,
  },

  // ===== TRADE #32 — SOL/USDT Long WIN (streak 3/4) =====
  {
    id: 'sample-32',
    pair: 'SOL/USDT',
    direction: 'long',
    entryPrice: 150,
    exitPrice: 156,
    quantity: 5,
    entryDate: '2024-08-14T11:00:00Z',
    exitDate: '2024-08-14T18:00:00Z',
    // pnl = (156 - 150) * 5 * 2 - 2.50 = 6 * 5 * 2 - 2.50 = 60 - 2.50 = 57.50
    pnl: 57.50,
    // pnlPercent = 57.50 / (150 * 5) * 100 = 57.50 / 750 * 100 = 7.667
    pnlPercent: 7.67,
    fees: 2.50,
    notes: 'On a roll!',
    tags: ['trend'],
    leverage: 2,
  },

  // ===== TRADE #33 — BTC/USDT Long WIN (streak 4/4) =====
  {
    id: 'sample-33',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 63000,
    exitPrice: 64200,
    quantity: 0.04,
    entryDate: '2024-08-16T09:30:00Z',
    exitDate: '2024-08-16T16:00:00Z',
    // pnl = (64200 - 63000) * 0.04 * 2 - 3.50 = 1200 * 0.04 * 2 - 3.50 = 96 - 3.50 = 92.50
    pnl: 92.50,
    // pnlPercent = 92.50 / (63000 * 0.04) * 100 = 92.50 / 2520 * 100 = 3.671
    pnlPercent: 3.67,
    fees: 3.50,
    notes: 'Strong momentum, 4 wins in a row',
    tags: ['trend', 'momentum'],
    leverage: 2,
  },

  // ===== TRADE #34 — ETH/USDT Long LOSS (OVERLEVERAGE: 10x after win streak!) =====
  {
    id: 'sample-34',
    pair: 'ETH/USDT',
    direction: 'long',
    entryPrice: 2950,
    exitPrice: 2880,
    quantity: 0.8,
    entryDate: '2024-08-17T10:00:00Z',
    exitDate: '2024-08-17T12:00:00Z',
    // pnl = (2880 - 2950) * 0.8 * 10 - 15.00 = (-70) * 0.8 * 10 - 15.00 = -560 - 15.00 = -575.00
    pnl: -575.00,
    // pnlPercent = -575.00 / (2950 * 0.8) * 100 = -575.00 / 2360 * 100 = -24.364
    pnlPercent: -24.36,
    fees: 15.00,
    notes: 'Felt invincible after streak, went 10x leverage. Big mistake.',
    tags: ['overleverage', 'emotional'],
    leverage: 10,
  },

  // ==========================================================================
  // Continued mixed trades #35-#57
  // ==========================================================================

  // ===== TRADE #35 — BTC/USDT Long LOSS =====
  {
    id: 'sample-35',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 58000,
    exitPrice: 57200,
    quantity: 0.05,
    entryDate: '2024-08-21T10:00:00Z',
    exitDate: '2024-08-22T22:00:00Z', // Holding loser: 36h
    // pnl = (57200 - 58000) * 0.05 * 2 - 4.00 = (-800) * 0.05 * 2 - 4.00 = -80 - 4.00 = -84.00
    pnl: -84.00,
    // pnlPercent = -84.00 / (58000 * 0.05) * 100 = -84.00 / 2900 * 100 = -2.897
    pnlPercent: -2.90,
    fees: 4.00,
    notes: 'Still shaken from overleverage loss',
    tags: ['swing'],
    leverage: 2,
  },

  // ===== TRADE #36 — SOL/USDT Long WIN =====
  {
    id: 'sample-36',
    pair: 'SOL/USDT',
    direction: 'long',
    entryPrice: 142,
    exitPrice: 146,
    quantity: 5,
    entryDate: '2024-08-24T13:00:00Z',
    exitDate: '2024-08-24T19:00:00Z',
    // pnl = (146 - 142) * 5 * 2 - 2.00 = 4 * 5 * 2 - 2.00 = 40 - 2.00 = 38.00
    pnl: 38.00,
    // pnlPercent = 38.00 / (142 * 5) * 100 = 38.00 / 710 * 100 = 5.352
    pnlPercent: 5.35,
    fees: 2.00,
    notes: 'Quick bounce off support',
    tags: ['support', 'trend'],
    leverage: 2,
  },

  // ===== TRADE #37 — XRP/USDT Long LOSS =====
  {
    id: 'sample-37',
    pair: 'XRP/USDT',
    direction: 'long',
    entryPrice: 0.55,
    exitPrice: 0.530,
    quantity: 2000,
    entryDate: '2024-08-28T09:00:00Z',
    exitDate: '2024-08-30T09:00:00Z', // Holding loser: 48h
    // pnl = (0.530 - 0.55) * 2000 * 1 - 1.50 = (-0.02) * 2000 * 1 - 1.50 = -40 - 1.50 = -41.50
    pnl: -41.50,
    // pnlPercent = -41.50 / (0.55 * 2000) * 100 = -41.50 / 1100 * 100 = -3.773
    pnlPercent: -3.77,
    fees: 1.50,
    notes: 'XRP dumped, held too long',
    tags: ['swing'],
    leverage: 1,
  },

  // ===== TRADE #38 — BTC/USDT Long WIN =====
  {
    id: 'sample-38',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 60500,
    exitPrice: 61400,
    quantity: 0.03,
    entryDate: '2024-09-02T10:30:00Z',
    exitDate: '2024-09-02T16:00:00Z',
    // pnl = (61400 - 60500) * 0.03 * 3 - 3.50 = 900 * 0.03 * 3 - 3.50 = 81 - 3.50 = 77.50
    pnl: 77.50,
    // pnlPercent = 77.50 / (60500 * 0.03) * 100 = 77.50 / 1815 * 100 = 4.270
    pnlPercent: 4.27,
    fees: 3.50,
    notes: 'Strong volume breakout',
    tags: ['breakout', 'trend'],
    leverage: 3,
  },

  // ===== TRADE #39 — DOGE/USDT Long LOSS (Bad Time: 2:50 AM) =====
  {
    id: 'sample-39',
    pair: 'DOGE/USDT',
    direction: 'long',
    entryPrice: 0.10,
    exitPrice: 0.0960,
    quantity: 10000,
    entryDate: '2024-09-04T02:50:00Z', // Bad time: 2:50 AM UTC
    exitDate: '2024-09-04T08:00:00Z',
    // pnl = (0.0960 - 0.10) * 10000 * 1 - 2.00 = (-0.004) * 10000 * 1 - 2.00 = -40 - 2.00 = -42.00
    pnl: -42.00,
    // pnlPercent = -42.00 / (0.10 * 10000) * 100 = -42.00 / 1000 * 100 = -4.200
    pnlPercent: -4.20,
    fees: 2.00,
    notes: 'FOMO entry at 3 AM, terrible idea',
    tags: ['late-night', 'FOMO'],
    leverage: 1,
  },

  // ===== TRADE #40 — ETH/USDT Short WIN =====
  {
    id: 'sample-40',
    pair: 'ETH/USDT',
    direction: 'short',
    entryPrice: 2500,
    exitPrice: 2440,
    quantity: 1.0,
    entryDate: '2024-09-06T11:00:00Z',
    exitDate: '2024-09-06T16:30:00Z',
    // pnl = (2500 - 2440) * 1.0 * 2 - 4.00 = 60 * 1.0 * 2 - 4.00 = 120 - 4.00 = 116.00
    pnl: 116.00,
    // pnlPercent = 116.00 / (2500 * 1.0) * 100 = 116.00 / 2500 * 100 = 4.640
    pnlPercent: 4.64,
    fees: 4.00,
    notes: 'Bear flag breakdown',
    tags: ['breakdown', 'trend'],
    leverage: 2,
  },

  // ===== TRADE #41 — BTC/USDT Long LOSS =====
  {
    id: 'sample-41',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 57000,
    exitPrice: 56100,
    quantity: 0.06,
    entryDate: '2024-09-10T09:00:00Z',
    exitDate: '2024-09-11T18:00:00Z', // Holding loser: 33h
    // pnl = (56100 - 57000) * 0.06 * 2 - 4.50 = (-900) * 0.06 * 2 - 4.50 = -108 - 4.50 = -112.50
    pnl: -112.50,
    // pnlPercent = -112.50 / (57000 * 0.06) * 100 = -112.50 / 3420 * 100 = -3.289
    pnlPercent: -3.29,
    fees: 4.50,
    notes: 'September dip caught me off guard',
    tags: ['swing'],
    leverage: 2,
  },

  // ===== TRADE #42 — MATIC/USDT Long WIN =====
  {
    id: 'sample-42',
    pair: 'MATIC/USDT',
    direction: 'long',
    entryPrice: 0.45,
    exitPrice: 0.465,
    quantity: 2000,
    entryDate: '2024-09-12T14:00:00Z',
    exitDate: '2024-09-12T20:00:00Z',
    // pnl = (0.465 - 0.45) * 2000 * 2 - 1.50 = 0.015 * 2000 * 2 - 1.50 = 60 - 1.50 = 58.50
    pnl: 58.50,
    // pnlPercent = 58.50 / (0.45 * 2000) * 100 = 58.50 / 900 * 100 = 6.500
    pnlPercent: 6.50,
    fees: 1.50,
    notes: 'MATIC bounced off key support',
    tags: ['support'],
    leverage: 2,
  },

  // ===== TRADE #43 — BNB/USDT Short WIN =====
  {
    id: 'sample-43',
    pair: 'BNB/USDT',
    direction: 'short',
    entryPrice: 520,
    exitPrice: 508,
    quantity: 3,
    entryDate: '2024-09-16T10:00:00Z',
    exitDate: '2024-09-16T15:00:00Z',
    // pnl = (520 - 508) * 3 * 2 - 3.00 = 12 * 3 * 2 - 3.00 = 72 - 3.00 = 69.00
    pnl: 69.00,
    // pnlPercent = 69.00 / (520 * 3) * 100 = 69.00 / 1560 * 100 = 4.423
    pnlPercent: 4.42,
    fees: 3.00,
    notes: 'Rejection at previous high',
    tags: ['resistance'],
    leverage: 2,
  },

  // ===== TRADE #44 — SOL/USDT Short WIN =====
  {
    id: 'sample-44',
    pair: 'SOL/USDT',
    direction: 'short',
    entryPrice: 158,
    exitPrice: 152,
    quantity: 4,
    entryDate: '2024-09-19T12:00:00Z',
    exitDate: '2024-09-19T18:00:00Z',
    // pnl = (158 - 152) * 4 * 2 - 2.50 = 6 * 4 * 2 - 2.50 = 48 - 2.50 = 45.50
    pnl: 45.50,
    // pnlPercent = 45.50 / (158 * 4) * 100 = 45.50 / 632 * 100 = 7.199
    pnlPercent: 7.20,
    fees: 2.50,
    notes: 'Bearish breakdown confirmed',
    tags: ['breakdown'],
    leverage: 2,
  },

  // ===== TRADE #45 — BTC/USDT Long WIN =====
  {
    id: 'sample-45',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 63500,
    exitPrice: 64500,
    quantity: 0.04,
    entryDate: '2024-09-23T10:00:00Z',
    exitDate: '2024-09-23T15:00:00Z',
    // pnl = (64500 - 63500) * 0.04 * 2 - 3.50 = 1000 * 0.04 * 2 - 3.50 = 80 - 3.50 = 76.50
    pnl: 76.50,
    // pnlPercent = 76.50 / (63500 * 0.04) * 100 = 76.50 / 2540 * 100 = 3.012
    pnlPercent: 3.01,
    fees: 3.50,
    notes: 'Clean level retest',
    tags: ['support', 'trend'],
    leverage: 2,
  },

  // ===== TRADE #46 — ETH/USDT Long LOSS (Loss Aversion: large loss) =====
  {
    id: 'sample-46',
    pair: 'ETH/USDT',
    direction: 'long',
    entryPrice: 2600,
    exitPrice: 2530,
    quantity: 0.8,
    entryDate: '2024-09-26T11:00:00Z',
    exitDate: '2024-09-28T11:00:00Z', // Holding loser: 48h
    // pnl = (2530 - 2600) * 0.8 * 2 - 3.00 = (-70) * 0.8 * 2 - 3.00 = -112 - 3.00 = -115.00
    pnl: -115.00,
    // pnlPercent = -115.00 / (2600 * 0.8) * 100 = -115.00 / 2080 * 100 = -5.529
    pnlPercent: -5.53,
    fees: 3.00,
    notes: 'Held hoping for bounce that never came',
    tags: ['swing'],
    leverage: 2,
  },

  // ===== TRADE #47 — AVAX/USDT Long LOSS =====
  {
    id: 'sample-47',
    pair: 'AVAX/USDT',
    direction: 'long',
    entryPrice: 25.00,
    exitPrice: 23.50,
    quantity: 30,
    entryDate: '2024-10-01T14:00:00Z',
    exitDate: '2024-10-03T14:00:00Z', // Holding loser: 48h
    // pnl = (23.50 - 25.00) * 30 * 2 - 2.00 = (-1.50) * 30 * 2 - 2.00 = -90 - 2.00 = -92.00
    pnl: -92.00,
    // pnlPercent = -92.00 / (25.00 * 30) * 100 = -92.00 / 750 * 100 = -12.267
    pnlPercent: -12.27,
    fees: 2.00,
    notes: 'Kept moving stop loss further away',
    tags: ['swing'],
    leverage: 2,
  },

  // ===== TRADE #48 — BTC/USDT Long LOSS =====
  {
    id: 'sample-48',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 67000,
    exitPrice: 65800,
    quantity: 0.03,
    entryDate: '2024-10-07T09:00:00Z',
    exitDate: '2024-10-08T21:00:00Z', // Holding loser: 36h
    // pnl = (65800 - 67000) * 0.03 * 2 - 3.00 = (-1200) * 0.03 * 2 - 3.00 = -72 - 3.00 = -75.00
    pnl: -75.00,
    // pnlPercent = -75.00 / (67000 * 0.03) * 100 = -75.00 / 2010 * 100 = -3.731
    pnlPercent: -3.73,
    fees: 3.00,
    notes: 'Fake breakout, dumped back down',
    tags: ['breakout'],
    leverage: 2,
  },

  // ===== TRADE #49 — XRP/USDT Long WIN =====
  {
    id: 'sample-49',
    pair: 'XRP/USDT',
    direction: 'long',
    entryPrice: 0.60,
    exitPrice: 0.618,
    quantity: 2000,
    entryDate: '2024-10-10T10:00:00Z',
    exitDate: '2024-10-10T16:00:00Z',
    // pnl = (0.618 - 0.60) * 2000 * 2 - 1.80 = 0.018 * 2000 * 2 - 1.80 = 72 - 1.80 = 70.20
    pnl: 70.20,
    // pnlPercent = 70.20 / (0.60 * 2000) * 100 = 70.20 / 1200 * 100 = 5.850
    pnlPercent: 5.85,
    fees: 1.80,
    notes: 'XRP news catalyst',
    tags: ['news'],
    leverage: 2,
  },

  // ===== TRADE #50 — ETH/USDT Short LOSS (Bad Time: 3:00 AM) =====
  {
    id: 'sample-50',
    pair: 'ETH/USDT',
    direction: 'short',
    entryPrice: 2700,
    exitPrice: 2760,
    quantity: 0.6,
    entryDate: '2024-10-13T03:00:00Z', // Bad time: 3:00 AM UTC
    exitDate: '2024-10-13T07:00:00Z',
    // pnl = (2700 - 2760) * 0.6 * 2 - 3.00 = (-60) * 0.6 * 2 - 3.00 = -72 - 3.00 = -75.00
    pnl: -75.00,
    // pnlPercent = -75.00 / (2700 * 0.6) * 100 = -75.00 / 1620 * 100 = -4.630
    pnlPercent: -4.63,
    fees: 3.00,
    notes: 'Insomnia trading again',
    tags: ['late-night'],
    leverage: 2,
  },

  // ===== TRADE #51 — BTC/USDT Long WIN =====
  {
    id: 'sample-51',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 71000,
    exitPrice: 72500,
    quantity: 0.03,
    entryDate: '2024-10-18T09:00:00Z',
    exitDate: '2024-10-18T15:00:00Z',
    // pnl = (72500 - 71000) * 0.03 * 2 - 3.50 = 1500 * 0.03 * 2 - 3.50 = 90 - 3.50 = 86.50
    pnl: 86.50,
    // pnlPercent = 86.50 / (71000 * 0.03) * 100 = 86.50 / 2130 * 100 = 4.061
    pnlPercent: 4.06,
    fees: 3.50,
    notes: 'BTC breaking highs',
    tags: ['breakout', 'trend'],
    leverage: 2,
  },

  // ===== TRADE #52 — SOL/USDT Short LOSS =====
  {
    id: 'sample-52',
    pair: 'SOL/USDT',
    direction: 'short',
    entryPrice: 175,
    exitPrice: 184,
    quantity: 3,
    entryDate: '2024-10-22T11:00:00Z',
    exitDate: '2024-10-23T20:00:00Z', // Holding loser: 33h
    // pnl = (175 - 184) * 3 * 2 - 2.00 = (-9) * 3 * 2 - 2.00 = -54 - 2.00 = -56.00
    pnl: -56.00,
    // pnlPercent = -56.00 / (175 * 3) * 100 = -56.00 / 525 * 100 = -10.667
    pnlPercent: -10.67,
    fees: 2.00,
    notes: 'Shorted SOL into news pump, bad timing',
    tags: ['news', 'counter-trend'],
    leverage: 2,
  },

  // ===== TRADE #53 — DOGE/USDT Long LOSS (Loss Aversion: -4.5%) =====
  {
    id: 'sample-53',
    pair: 'DOGE/USDT',
    direction: 'long',
    entryPrice: 0.15,
    exitPrice: 0.140,
    quantity: 6000,
    entryDate: '2024-10-26T13:00:00Z',
    exitDate: '2024-10-28T13:00:00Z', // Holding loser: 48h
    // pnl = (0.140 - 0.15) * 6000 * 1 - 2.00 = (-0.01) * 6000 * 1 - 2.00 = -60 - 2.00 = -62.00
    pnl: -62.00,
    // pnlPercent = -62.00 / (0.15 * 6000) * 100 = -62.00 / 900 * 100 = -6.889
    pnlPercent: -6.89,
    fees: 2.00,
    notes: 'Meme coin pump faded',
    tags: ['FOMO'],
    leverage: 1,
  },

  // ===== TRADE #54 — BTC/USDT Short WIN =====
  {
    id: 'sample-54',
    pair: 'BTC/USDT',
    direction: 'short',
    entryPrice: 73000,
    exitPrice: 71800,
    quantity: 0.02,
    entryDate: '2024-11-01T10:00:00Z',
    exitDate: '2024-11-01T16:00:00Z',
    // pnl = (73000 - 71800) * 0.02 * 3 - 3.00 = 1200 * 0.02 * 3 - 3.00 = 72 - 3.00 = 69.00
    pnl: 69.00,
    // pnlPercent = 69.00 / (73000 * 0.02) * 100 = 69.00 / 1460 * 100 = 4.726
    pnlPercent: 4.73,
    fees: 3.00,
    notes: 'Bearish engulfing at resistance',
    tags: ['resistance'],
    leverage: 3,
  },

  // ===== TRADE #55 — ETH/USDT Long WIN =====
  {
    id: 'sample-55',
    pair: 'ETH/USDT',
    direction: 'long',
    entryPrice: 2450,
    exitPrice: 2510,
    quantity: 1.0,
    entryDate: '2024-11-05T12:00:00Z',
    exitDate: '2024-11-05T18:00:00Z',
    // pnl = (2510 - 2450) * 1.0 * 2 - 4.50 = 60 * 1.0 * 2 - 4.50 = 120 - 4.50 = 115.50
    pnl: 115.50,
    // pnlPercent = 115.50 / (2450 * 1.0) * 100 = 115.50 / 2450 * 100 = 4.714
    pnlPercent: 4.71,
    fees: 4.50,
    notes: 'ETH bounce off key level',
    tags: ['support', 'trend'],
    leverage: 2,
  },

  // ===== TRADE #56 — BNB/USDT Long WIN (small win +1.6%) =====
  {
    id: 'sample-56',
    pair: 'BNB/USDT',
    direction: 'long',
    entryPrice: 580,
    exitPrice: 590,
    quantity: 2,
    entryDate: '2024-11-10T09:00:00Z',
    exitDate: '2024-11-10T12:00:00Z',
    // pnl = (590 - 580) * 2 * 2 - 2.50 = 10 * 2 * 2 - 2.50 = 40 - 2.50 = 37.50
    pnl: 37.50,
    // pnlPercent = 37.50 / (580 * 2) * 100 = 37.50 / 1160 * 100 = 3.233
    pnlPercent: 3.23,
    fees: 2.50,
    notes: '',
    tags: ['scalp'],
    leverage: 2,
  },

  // ===== TRADE #57 — SOL/USDT Long WIN (5x leverage — risky but paid off) =====
  {
    id: 'sample-57',
    pair: 'SOL/USDT',
    direction: 'long',
    entryPrice: 200,
    exitPrice: 205,
    quantity: 3,
    entryDate: '2024-11-13T14:00:00Z',
    exitDate: '2024-11-13T19:00:00Z',
    // pnl = (205 - 200) * 3 * 5 - 5.00 = 5 * 3 * 5 - 5.00 = 75 - 5.00 = 70.00
    pnl: 70.00,
    // pnlPercent = 70.00 / (200 * 3) * 100 = 70.00 / 600 * 100 = 11.667
    pnlPercent: 11.67,
    fees: 5.00,
    notes: 'Higher leverage but quick in and out',
    tags: ['momentum'],
    leverage: 5,
  },

  // ===== TRADE #58 — BTC/USDT Long WIN =====
  {
    id: 'sample-58',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 90000,
    exitPrice: 91500,
    quantity: 0.02,
    entryDate: '2024-11-18T10:00:00Z',
    exitDate: '2024-11-18T16:00:00Z',
    // pnl = (91500 - 90000) * 0.02 * 2 - 3.00 = 1500 * 0.02 * 2 - 3.00 = 60 - 3.00 = 57.00
    pnl: 57.00,
    // pnlPercent = 57.00 / (90000 * 0.02) * 100 = 57.00 / 1800 * 100 = 3.167
    pnlPercent: 3.17,
    fees: 3.00,
    notes: 'BTC rally to new highs',
    tags: ['breakout', 'trend'],
    leverage: 2,
  },

  // ===== TRADE #59 — XRP/USDT Long WIN =====
  {
    id: 'sample-59',
    pair: 'XRP/USDT',
    direction: 'long',
    entryPrice: 1.10,
    exitPrice: 1.15,
    quantity: 1000,
    entryDate: '2024-11-22T09:00:00Z',
    exitDate: '2024-11-22T14:00:00Z',
    // pnl = (1.15 - 1.10) * 1000 * 2 - 2.00 = 0.05 * 1000 * 2 - 2.00 = 100 - 2.00 = 98.00
    pnl: 98.00,
    // pnlPercent = 98.00 / (1.10 * 1000) * 100 = 98.00 / 1100 * 100 = 8.909
    pnlPercent: 8.91,
    fees: 2.00,
    notes: 'XRP SEC case resolution pump',
    tags: ['news'],
    leverage: 2,
  },

  // ===== TRADE #60 — AVAX/USDT Short WIN =====
  {
    id: 'sample-60',
    pair: 'AVAX/USDT',
    direction: 'short',
    entryPrice: 42.00,
    exitPrice: 40.00,
    quantity: 15,
    entryDate: '2024-11-26T11:00:00Z',
    exitDate: '2024-11-26T17:00:00Z',
    // pnl = (42.00 - 40.00) * 15 * 2 - 2.00 = 2.00 * 15 * 2 - 2.00 = 60 - 2.00 = 58.00
    pnl: 58.00,
    // pnlPercent = 58.00 / (42.00 * 15) * 100 = 58.00 / 630 * 100 = 9.206
    pnlPercent: 9.21,
    fees: 2.00,
    notes: 'Head and shoulders breakdown',
    tags: ['breakdown'],
    leverage: 2,
  },

  // ===== TRADE #61 — BTC/USDT Long LOSS =====
  {
    id: 'sample-61',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 95000,
    exitPrice: 93200,
    quantity: 0.02,
    entryDate: '2024-11-30T10:00:00Z',
    exitDate: '2024-12-01T22:00:00Z', // Holding loser: 36h
    // pnl = (93200 - 95000) * 0.02 * 2 - 3.50 = (-1800) * 0.02 * 2 - 3.50 = -72 - 3.50 = -75.50
    pnl: -75.50,
    // pnlPercent = -75.50 / (95000 * 0.02) * 100 = -75.50 / 1900 * 100 = -3.974
    pnlPercent: -3.97,
    fees: 3.50,
    notes: 'End of month selloff, caught long',
    tags: ['swing'],
    leverage: 2,
  },

  // ===== TRADE #62 — ETH/USDT Long WIN (small win) =====
  {
    id: 'sample-62',
    pair: 'ETH/USDT',
    direction: 'long',
    entryPrice: 3600,
    exitPrice: 3650,
    quantity: 0.5,
    entryDate: '2024-12-02T10:00:00Z',
    exitDate: '2024-12-02T14:00:00Z',
    // pnl = (3650 - 3600) * 0.5 * 2 - 3.00 = 50 * 0.5 * 2 - 3.00 = 50 - 3.00 = 47.00
    pnl: 47.00,
    // pnlPercent = 47.00 / (3600 * 0.5) * 100 = 47.00 / 1800 * 100 = 2.611
    pnlPercent: 2.61,
    fees: 3.00,
    notes: 'Quick trade during London session',
    tags: ['scalp'],
    leverage: 2,
  },

  // ===== TRADE #63 — DOGE/USDT Long LOSS =====
  {
    id: 'sample-63',
    pair: 'DOGE/USDT',
    direction: 'long',
    entryPrice: 0.40,
    exitPrice: 0.375,
    quantity: 3000,
    entryDate: '2024-12-04T13:00:00Z',
    exitDate: '2024-12-06T09:00:00Z', // Holding loser: 44h
    // pnl = (0.375 - 0.40) * 3000 * 1 - 2.00 = (-0.025) * 3000 * 1 - 2.00 = -75 - 2.00 = -77.00
    pnl: -77.00,
    // pnlPercent = -77.00 / (0.40 * 3000) * 100 = -77.00 / 1200 * 100 = -6.417
    pnlPercent: -6.42,
    fees: 2.00,
    notes: 'DOGE hype fading',
    tags: ['FOMO'],
    leverage: 1,
  },

  // ===== TRADE #64 — BTC/USDT Long LOSS =====
  {
    id: 'sample-64',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 97000,
    exitPrice: 95500,
    quantity: 0.02,
    entryDate: '2024-12-08T09:00:00Z',
    exitDate: '2024-12-09T16:00:00Z', // Holding loser: 31h
    // pnl = (95500 - 97000) * 0.02 * 2 - 3.00 = (-1500) * 0.02 * 2 - 3.00 = -60 - 3.00 = -63.00
    pnl: -63.00,
    // pnlPercent = -63.00 / (97000 * 0.02) * 100 = -63.00 / 1940 * 100 = -3.247
    pnlPercent: -3.25,
    fees: 3.00,
    notes: 'BTC pulled back from 100k attempt',
    tags: ['swing'],
    leverage: 2,
  },

  // ===== TRADE #65 — SOL/USDT Short LOSS (Bad Time: 3:30 AM) =====
  {
    id: 'sample-65',
    pair: 'SOL/USDT',
    direction: 'short',
    entryPrice: 230,
    exitPrice: 240,
    quantity: 3,
    entryDate: '2024-12-10T03:30:00Z', // Bad time: 3:30 AM UTC
    exitDate: '2024-12-10T09:00:00Z',
    // pnl = (230 - 240) * 3 * 2 - 2.00 = (-10) * 3 * 2 - 2.00 = -60 - 2.00 = -62.00
    pnl: -62.00,
    // pnlPercent = -62.00 / (230 * 3) * 100 = -62.00 / 690 * 100 = -8.986
    pnlPercent: -8.99,
    fees: 2.00,
    notes: 'Why do I keep trading at 3 AM',
    tags: ['late-night'],
    leverage: 2,
  },

  // ===== TRADE #66 — BNB/USDT Long WIN =====
  {
    id: 'sample-66',
    pair: 'BNB/USDT',
    direction: 'long',
    entryPrice: 680,
    exitPrice: 695,
    quantity: 1.5,
    entryDate: '2024-12-12T10:00:00Z',
    exitDate: '2024-12-12T16:00:00Z',
    // pnl = (695 - 680) * 1.5 * 2 - 2.50 = 15 * 1.5 * 2 - 2.50 = 45 - 2.50 = 42.50
    pnl: 42.50,
    // pnlPercent = 42.50 / (680 * 1.5) * 100 = 42.50 / 1020 * 100 = 4.167
    pnlPercent: 4.17,
    fees: 2.50,
    notes: 'BNB altseason move',
    tags: ['trend'],
    leverage: 2,
  },

  // ===== TRADE #67 — BTC/USDT Long WIN =====
  {
    id: 'sample-67',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 100000,
    exitPrice: 101200,
    quantity: 0.02,
    entryDate: '2024-12-14T09:00:00Z',
    exitDate: '2024-12-14T15:00:00Z',
    // pnl = (101200 - 100000) * 0.02 * 2 - 3.50 = 1200 * 0.02 * 2 - 3.50 = 48 - 3.50 = 44.50
    pnl: 44.50,
    // pnlPercent = 44.50 / (100000 * 0.02) * 100 = 44.50 / 2000 * 100 = 2.225
    pnlPercent: 2.23,
    fees: 3.50,
    notes: 'BTC 100k milestone!',
    tags: ['breakout', 'news'],
    leverage: 2,
  },
];
