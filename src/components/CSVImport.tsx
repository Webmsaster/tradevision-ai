'use client';

import { useState, useRef, DragEvent, ChangeEvent } from 'react';
import { Trade, CSVColumnMapping } from '@/types/trade';
import {
  parseCSVFile,
  getCSVHeaders,
  mapCSVToTrades,
  autoDetectMapping,
  PLATFORM_PRESETS,
} from '@/utils/csvParser';

interface CSVImportProps {
  onImport: (trades: Trade[]) => void;
}

const MAPPING_FIELDS: { key: keyof CSVColumnMapping; label: string; required: boolean }[] = [
  { key: 'pair', label: 'Pair / Symbol', required: true },
  { key: 'direction', label: 'Direction / Side', required: true },
  { key: 'entryPrice', label: 'Entry Price', required: true },
  { key: 'exitPrice', label: 'Exit Price', required: true },
  { key: 'quantity', label: 'Quantity', required: true },
  { key: 'entryDate', label: 'Entry Date', required: false },
  { key: 'exitDate', label: 'Exit Date', required: false },
  { key: 'fees', label: 'Fees', required: false },
  { key: 'leverage', label: 'Leverage', required: false },
];

const PLATFORM_OPTIONS = [
  { value: 'auto', label: 'Auto Detect' },
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'mt4', label: 'MT4' },
  { value: 'generic', label: 'Generic' },
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const EMPTY_MAPPING: CSVColumnMapping = {
  pair: '',
  direction: '',
  entryPrice: '',
  exitPrice: '',
  quantity: '',
  entryDate: '',
  exitDate: '',
  fees: '',
  leverage: '',
};

export default function CSVImport({ onImport }: CSVImportProps) {
  const [step, setStep] = useState<number>(1);
  const [file, setFile] = useState<File | null>(null);
  const [csvData, setCsvData] = useState<Record<string, string>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<CSVColumnMapping>({ ...EMPTY_MAPPING });
  const [mappedTrades, setMappedTrades] = useState<Trade[]>([]);
  const [skippedRows, setSkippedRows] = useState<number>(0);
  const [platform, setPlatform] = useState<string>('auto');
  const [dragOver, setDragOver] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // -------------------------------------------------------------------------
  // Step 1: File handling
  // -------------------------------------------------------------------------

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    setError('');

    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length > 0) {
      const droppedFile = droppedFiles[0];
      if (!(droppedFile.name.endsWith('.csv') || droppedFile.type === 'text/csv')) {
        setError('Please upload a .csv file.');
      } else if (droppedFile.size > MAX_FILE_SIZE) {
        setError('File too large. Maximum size is 10 MB.');
      } else {
        setFile(droppedFile);
      }
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    setError('');
    const selected = e.target.files?.[0];
    if (selected) {
      if (!(selected.name.endsWith('.csv') || selected.type === 'text/csv')) {
        setError('Please upload a .csv file.');
      } else if (selected.size > MAX_FILE_SIZE) {
        setError('File too large. Maximum size is 10 MB.');
      } else {
        setFile(selected);
      }
    }
  }

  function handleDropzoneClick() {
    fileInputRef.current?.click();
  }

  function handleDropzoneKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  }

  function handleRemoveFile() {
    setFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  async function handleProceedToMapping() {
    if (!file) return;

    setLoading(true);
    setError('');

    try {
      const result = await parseCSVFile(file);
      const parsedHeaders = getCSVHeaders(result);
      const parsedData = result.data;

      if (parsedHeaders.length === 0 || parsedData.length === 0) {
        setError('The CSV file appears to be empty or has no valid headers.');
        setLoading(false);
        return;
      }

      setHeaders(parsedHeaders);
      setCsvData(parsedData);

      // Determine initial mapping based on platform selection
      let initialMapping: Partial<CSVColumnMapping>;

      if (platform === 'auto') {
        initialMapping = autoDetectMapping(parsedHeaders);
      } else if (PLATFORM_PRESETS[platform]) {
        // Use preset but only for columns that actually exist in the CSV
        const preset = PLATFORM_PRESETS[platform];
        initialMapping = {};
        for (const [field, column] of Object.entries(preset)) {
          if (column && parsedHeaders.includes(column)) {
            (initialMapping as Record<string, string>)[field] = column;
          }
        }
      } else {
        initialMapping = autoDetectMapping(parsedHeaders);
      }

      setMapping({
        ...EMPTY_MAPPING,
        ...initialMapping,
      });

      setStep(2);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse the CSV file.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Column mapping
  // -------------------------------------------------------------------------

  function handleMappingChange(field: keyof CSVColumnMapping, value: string) {
    setMapping((prev) => ({ ...prev, [field]: value }));
  }

  function handleMapColumns() {
    setError('');

    // Validate required fields
    const missingRequired = MAPPING_FIELDS
      .filter((f) => f.required && !mapping[f.key])
      .map((f) => f.label);

    if (missingRequired.length > 0) {
      setError(`Please map the required fields: ${missingRequired.join(', ')}`);
      return;
    }

    try {
      const trades = mapCSVToTrades(csvData, mapping);
      const totalRows = csvData.length;
      const skipped = totalRows - trades.length;

      setMappedTrades(trades);
      setSkippedRows(skipped);

      if (trades.length === 0) {
        setError(
          'No valid trades could be parsed. Please check your column mappings and ensure the data is correct.'
        );
        return;
      }

      setStep(3);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to map CSV data to trades.';
      setError(message);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Preview & confirm
  // -------------------------------------------------------------------------

  function handleImport() {
    onImport(mappedTrades);
    setStep(4);
  }

  // -------------------------------------------------------------------------
  // Step 4: Reset
  // -------------------------------------------------------------------------

  function handleReset() {
    setStep(1);
    setFile(null);
    setCsvData([]);
    setHeaders([]);
    setMapping({ ...EMPTY_MAPPING });
    setMappedTrades([]);
    setSkippedRows(0);
    setPlatform('auto');
    setDragOver(false);
    setError('');
    setLoading(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function getStepStatus(s: number): string {
    if (s < step) return 'completed';
    if (s === step) return 'active';
    return '';
  }

  function formatPrice(value: number): string {
    return value.toFixed(2);
  }

  function formatPnl(value: number): string {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}`;
  }

  function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    const month = months[d.getMonth()];
    const day = String(d.getDate()).padStart(2, '0');
    const year = d.getFullYear();
    return `${month} ${day}, ${year}`;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const stepLabels = ['Upload', 'Map Columns', 'Preview', 'Done'];

  return (
    <div className="csv-import">
      {/* Step indicators */}
      <div className="csv-import-steps">
        {stepLabels.map((label, i) => {
          const stepNum = i + 1;
          return (
            <div key={stepNum} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {i > 0 && <div className="csv-step-divider" />}
              <div className={`csv-step-indicator ${getStepStatus(stepNum)}`}>
                <span className="csv-step-number">
                  {stepNum < step ? '\u2713' : stepNum}
                </span>
                <span className="csv-step-label">{label}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Step 1: File Upload                                               */}
      {/* ----------------------------------------------------------------- */}
      {step === 1 && (
        <div className="csv-step-content">
          <div
            className={`csv-dropzone${dragOver ? ' drag-over' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="Upload CSV file. Drag and drop or press Enter to browse files."
            onClick={handleDropzoneClick}
            onKeyDown={handleDropzoneKeyDown}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="csv-dropzone-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <div className="csv-dropzone-text">
              Drag & drop your CSV file here
            </div>
            <div className="csv-dropzone-hint">
              or click to browse files
            </div>
          </div>

          <input
            type="file"
            ref={fileInputRef}
            accept=".csv"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />

          {file && (
            <div className="csv-file-selected">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="csv-file-name">{file.name}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {(file.size / 1024).toFixed(1)} KB
              </span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemoveFile();
                }}
                title="Remove file"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}

          <div className="csv-platform-select">
            <label
              htmlFor="platform-select"
              style={{ display: 'block', marginBottom: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}
            >
              Platform Preset
            </label>
            <select
              id="platform-select"
              className="input"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              {PLATFORM_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {error && <div className="csv-error">{error}</div>}

          <div className="csv-import-actions">
            <button
              className="btn btn-primary"
              disabled={!file || loading}
              onClick={handleProceedToMapping}
            >
              {loading ? 'Parsing...' : 'Continue'}
            </button>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Step 2: Column Mapping                                            */}
      {/* ----------------------------------------------------------------- */}
      {step === 2 && (
        <div className="csv-step-content">
          <h3 style={{ marginBottom: '4px', fontSize: '1rem' }}>Map CSV Columns</h3>
          <p style={{ marginBottom: '20px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Match each trade field to the corresponding column in your CSV file.
            Fields marked with * are required.
          </p>

          <div className="csv-mapping-grid">
            {MAPPING_FIELDS.map((field) => (
              <div key={field.key} className="csv-mapping-field">
                <label
                  htmlFor={`mapping-${field.key}`}
                  style={{
                    display: 'block',
                    marginBottom: '4px',
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {field.label}{field.required ? ' *' : ''}
                </label>
                <select
                  id={`mapping-${field.key}`}
                  className="input"
                  value={mapping[field.key]}
                  onChange={(e) => handleMappingChange(field.key, e.target.value)}
                >
                  <option value="">-- Select column --</option>
                  {headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {/* Raw data preview table */}
          {csvData.length > 0 && (
            <>
              <h4 style={{ marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                CSV Preview (first 3 rows)
              </h4>
              <div className="csv-preview-table">
                <table>
                  <thead>
                    <tr>
                      {headers.map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvData.slice(0, 3).map((row, rowIdx) => (
                      <tr key={rowIdx}>
                        {headers.map((header) => (
                          <td key={header}>{row[header] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {error && <div className="csv-error">{error}</div>}

          <div className="csv-import-actions">
            <button className="btn btn-ghost" onClick={() => { setStep(1); setError(''); }}>
              Back
            </button>
            <button className="btn btn-primary" onClick={handleMapColumns}>
              Map Columns
            </button>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Step 3: Preview & Confirm                                         */}
      {/* ----------------------------------------------------------------- */}
      {step === 3 && (
        <div className="csv-step-content">
          <h3 style={{ marginBottom: '4px', fontSize: '1rem' }}>Preview Trades</h3>
          <p style={{ marginBottom: '20px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            {mappedTrades.length} trade{mappedTrades.length !== 1 ? 's' : ''} detected
            {skippedRows > 0 && (
              <span style={{ color: 'var(--text-warning, #f59e0b)' }}>
                {' '}&middot; {skippedRows} row{skippedRows !== 1 ? 's' : ''} skipped due to missing data
              </span>
            )}
          </p>

          <div className="csv-preview-table">
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Direction</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>Qty</th>
                  <th>PnL</th>
                  <th>Entry Date</th>
                  <th>Exit Date</th>
                </tr>
              </thead>
              <tbody>
                {mappedTrades.slice(0, 10).map((trade) => (
                  <tr key={trade.id}>
                    <td>{trade.pair}</td>
                    <td>
                      <span
                        style={{
                          color: trade.direction === 'long' ? 'var(--profit)' : 'var(--loss)',
                          fontWeight: 500,
                        }}
                      >
                        {trade.direction.toUpperCase()}
                      </span>
                    </td>
                    <td>{formatPrice(trade.entryPrice)}</td>
                    <td>{formatPrice(trade.exitPrice)}</td>
                    <td>{trade.quantity}</td>
                    <td
                      style={{
                        color: trade.pnl >= 0 ? 'var(--profit)' : 'var(--loss)',
                        fontWeight: 500,
                      }}
                    >
                      {formatPnl(trade.pnl)}
                    </td>
                    <td>{formatDate(trade.entryDate)}</td>
                    <td>{formatDate(trade.exitDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {mappedTrades.length > 10 && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px' }}>
              Showing first 10 of {mappedTrades.length} trades.
            </p>
          )}

          {error && <div className="csv-error">{error}</div>}

          <div className="csv-import-actions">
            <button className="btn btn-ghost" onClick={() => { setStep(2); setError(''); }}>
              Back
            </button>
            <button className="btn btn-primary" onClick={handleImport}>
              Import {mappedTrades.length} Trade{mappedTrades.length !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Step 4: Success                                                   */}
      {/* ----------------------------------------------------------------- */}
      {step === 4 && (
        <div className="csv-step-content">
          <div className="csv-success">
            <div className="csv-success-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <div className="csv-success-text">
              {mappedTrades.length} trade{mappedTrades.length !== 1 ? 's' : ''} imported successfully!
            </div>
            <div className="csv-success-count">
              Your trading data has been added to the journal.
            </div>
            <button className="btn btn-primary" onClick={handleReset}>
              Import More
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
