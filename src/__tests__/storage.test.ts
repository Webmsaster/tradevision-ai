import { describe, it, expect, beforeEach, vi } from 'vitest';
import { saveTrades, loadTrades, addTrade, updateTrade, deleteTrade, clearAllData, importFromJSON, hasSavedData } from '@/utils/storage';
import type { Trade } from '@/types/trade';

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'test-1',
    pair: 'BTC/USDT',
    direction: 'long',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    entryDate: '2024-01-01T10:00:00Z',
    exitDate: '2024-01-01T14:00:00Z',
    pnl: 10,
    pnlPercent: 10,
    fees: 0,
    notes: '',
    tags: [],
    leverage: 1,
    ...overrides,
  };
}

// Mock localStorage
const store: Record<string, string> = {};

beforeEach(() => {
  Object.keys(store).forEach((key) => delete store[key]);

  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
  });
});

describe('saveTrades / loadTrades', () => {
  it('saves and loads trades correctly', () => {
    const trades = [makeTrade(), makeTrade({ id: 'test-2', pair: 'ETH/USDT' })];
    saveTrades(trades);
    const loaded = loadTrades();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].pair).toBe('BTC/USDT');
    expect(loaded[1].pair).toBe('ETH/USDT');
  });

  it('returns empty array when no data stored', () => {
    expect(loadTrades()).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    store['trading-journal-trades'] = 'not-valid-json';
    expect(loadTrades()).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    store['trading-journal-trades'] = '{"foo":"bar"}';
    expect(loadTrades()).toEqual([]);
  });

  it('filters out invalid trade objects', () => {
    store['trading-journal-trades'] = JSON.stringify([
      makeTrade(),
      { id: 'bad', pair: 123 }, // invalid: pair must be string
      null,
      'not-an-object',
    ]);
    const loaded = loadTrades();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('test-1');
  });

  it('separates screenshots to a separate key', () => {
    const trades = [makeTrade({ screenshot: 'data:image/png;base64,abc123' })];
    saveTrades(trades);

    const tradesData = JSON.parse(store['trading-journal-trades']);
    expect(tradesData[0].screenshot).toBeUndefined();

    const screenshots = JSON.parse(store['trading-journal-screenshots']);
    expect(screenshots['test-1']).toBe('data:image/png;base64,abc123');
  });

  it('re-attaches screenshots on load', () => {
    store['trading-journal-trades'] = JSON.stringify([makeTrade()]);
    store['trading-journal-screenshots'] = JSON.stringify({ 'test-1': 'data:image/png;base64,abc' });
    const loaded = loadTrades();
    expect(loaded[0].screenshot).toBe('data:image/png;base64,abc');
  });
});

describe('addTrade', () => {
  it('adds a trade and persists', () => {
    const result = addTrade(makeTrade());
    expect(result).toHaveLength(1);
    expect(loadTrades()).toHaveLength(1);
  });

  it('appends to existing trades', () => {
    addTrade(makeTrade({ id: 'a' }));
    const result = addTrade(makeTrade({ id: 'b' }));
    expect(result).toHaveLength(2);
  });
});

describe('updateTrade', () => {
  it('updates an existing trade by id', () => {
    addTrade(makeTrade({ id: 'a', pair: 'BTC/USDT' }));
    const result = updateTrade(makeTrade({ id: 'a', pair: 'ETH/USDT' }));
    expect(result[0].pair).toBe('ETH/USDT');
  });

  it('does nothing if trade id not found', () => {
    addTrade(makeTrade({ id: 'a' }));
    const result = updateTrade(makeTrade({ id: 'non-existent', pair: 'SOL/USDT' }));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });
});

describe('deleteTrade', () => {
  it('removes a trade by id', () => {
    addTrade(makeTrade({ id: 'a' }));
    addTrade(makeTrade({ id: 'b' }));
    const result = deleteTrade('a');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('returns unchanged array if id not found', () => {
    addTrade(makeTrade({ id: 'a' }));
    const result = deleteTrade('nonexistent');
    expect(result).toHaveLength(1);
  });
});

describe('clearAllData', () => {
  it('removes all trade data', () => {
    addTrade(makeTrade());
    clearAllData();
    expect(loadTrades()).toEqual([]);
  });
});

describe('hasSavedData', () => {
  it('returns false when no data', () => {
    expect(hasSavedData()).toBe(false);
  });

  it('returns true when trades exist', () => {
    addTrade(makeTrade());
    expect(hasSavedData()).toBe(true);
  });

  it('returns false for empty array', () => {
    store['trading-journal-trades'] = '[]';
    expect(hasSavedData()).toBe(false);
  });
});

describe('importFromJSON', () => {
  function makeFile(content: string): File {
    return new File([content], 'test.json', { type: 'application/json' });
  }

  it('imports trades from a raw array', async () => {
    const trades = [makeTrade()];
    const file = makeFile(JSON.stringify(trades));
    const result = await importFromJSON(file);
    expect(result).toHaveLength(1);
    expect(result[0].pair).toBe('BTC/USDT');
  });

  it('imports trades from a wrapped format', async () => {
    const wrapper = { exportDate: '2024-01-01', version: '1.0', trades: [makeTrade()] };
    const file = makeFile(JSON.stringify(wrapper));
    const result = await importFromJSON(file);
    expect(result).toHaveLength(1);
  });

  it('deduplicates duplicate trade ids in a backup file', async () => {
    const duplicateId = 'dup-1';
    const wrapper = {
      exportDate: '2024-01-01',
      version: '1.0',
      trades: [
        makeTrade({ id: duplicateId, pair: 'BTC/USDT' }),
        makeTrade({ id: duplicateId, pair: 'ETH/USDT' }),
      ],
    };
    const file = makeFile(JSON.stringify(wrapper));
    const result = await importFromJSON(file);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(duplicateId);
    expect(result[0].pair).toBe('BTC/USDT');
  });

  it('preserves screenshot data from JSON backup entries', async () => {
    const wrapper = {
      exportDate: '2024-01-01',
      version: '1.0',
      trades: [makeTrade({ id: 'img-1', screenshot: 'data:image/png;base64,abc123' })],
    };
    const file = makeFile(JSON.stringify(wrapper));
    const result = await importFromJSON(file);
    expect(result).toHaveLength(1);
    expect(result[0].screenshot).toBe('data:image/png;base64,abc123');
  });

  it('rejects files with no valid trades', async () => {
    const file = makeFile(JSON.stringify([{ id: 'bad' }]));
    await expect(importFromJSON(file)).rejects.toThrow('No valid trades found');
  });

  it('rejects invalid JSON structure', async () => {
    const file = makeFile(JSON.stringify({ something: 'else' }));
    await expect(importFromJSON(file)).rejects.toThrow('Invalid JSON structure');
  });

  it('rejects files over 10 MB', async () => {
    const bigContent = 'x'.repeat(11 * 1024 * 1024);
    const file = new File([bigContent], 'big.json', { type: 'application/json' });
    await expect(importFromJSON(file)).rejects.toThrow('File too large');
  });

  it('rejects unparseable JSON', async () => {
    const file = makeFile('not json at all');
    await expect(importFromJSON(file)).rejects.toThrow('Failed to parse JSON');
  });
});
