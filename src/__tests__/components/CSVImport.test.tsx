import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CSVImport from '@/components/CSVImport';

// Mock csvParser module
vi.mock('@/utils/csvParser', () => ({
  parseCSVFile: vi.fn(),
  getCSVHeaders: vi.fn(),
  mapCSVToTrades: vi.fn(),
  autoDetectMapping: vi.fn(() => ({})),
  PLATFORM_PRESETS: {
    binance: { pair: 'Symbol', direction: 'Side', entryPrice: 'Entry Price', exitPrice: 'Exit Price', quantity: 'Quantity' },
  },
}));

// Mock formatters
vi.mock('@/utils/formatters', () => ({
  formatPrice: (v: number) => `$${v.toFixed(2)}`,
  formatPnl: (v: number) => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`,
  formatShortDate: (v: string) => v.slice(0, 10),
}));

const mockOnImport = vi.fn();

describe('CSVImport', () => {
  it('renders step 1 (Upload) by default', () => {
    render(<CSVImport onImport={mockOnImport} />);
    expect(screen.getByText('Drag & drop your CSV file here')).toBeInTheDocument();
    expect(screen.getByText('or click to browse files')).toBeInTheDocument();
  });

  it('renders step indicators', () => {
    render(<CSVImport onImport={mockOnImport} />);
    expect(screen.getByText('Upload')).toBeInTheDocument();
    expect(screen.getByText('Map Columns')).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('renders platform preset selector', () => {
    render(<CSVImport onImport={mockOnImport} />);
    expect(screen.getByLabelText('Platform Preset')).toBeInTheDocument();
    expect(screen.getByText('Auto Detect')).toBeInTheDocument();
    expect(screen.getByText('Binance')).toBeInTheDocument();
    expect(screen.getByText('Bybit')).toBeInTheDocument();
  });

  it('Continue button is disabled when no file selected', () => {
    render(<CSVImport onImport={mockOnImport} />);
    const btn = screen.getByText('Continue');
    expect(btn).toBeDisabled();
  });

  it('shows error for non-CSV file', () => {
    render(<CSVImport onImport={mockOnImport} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText('Please upload a .csv file.')).toBeInTheDocument();
  });

  it('shows error for oversized file', () => {
    render(<CSVImport onImport={mockOnImport} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    // Create a file object and override size
    const file = new File(['x'], 'big.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText('File too large. Maximum size is 10 MB.')).toBeInTheDocument();
  });

  it('accepts valid CSV file and shows filename', () => {
    render(<CSVImport onImport={mockOnImport} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['pair,direction\nBTC,long'], 'trades.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText('trades.csv')).toBeInTheDocument();
  });

  it('removes selected file', () => {
    render(<CSVImport onImport={mockOnImport} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['data'], 'trades.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText('trades.csv')).toBeInTheDocument();

    const removeBtn = screen.getByTitle('Remove file');
    fireEvent.click(removeBtn);
    expect(screen.queryByText('trades.csv')).not.toBeInTheDocument();
  });

  it('dropzone has correct aria attributes', () => {
    render(<CSVImport onImport={mockOnImport} />);
    const dropzone = screen.getByRole('button', { name: /drag.*drop/i });
    expect(dropzone).toBeInTheDocument();
    expect(dropzone.getAttribute('tabindex')).toBe('0');
  });

  it('handles drag over styling', () => {
    render(<CSVImport onImport={mockOnImport} />);
    const dropzone = screen.getByRole('button', { name: /drag.*drop/i });

    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });
    expect(dropzone.className).toContain('drag-over');

    fireEvent.dragLeave(dropzone, { dataTransfer: { files: [] } });
    expect(dropzone.className).not.toContain('drag-over');
  });
});
