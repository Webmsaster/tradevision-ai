'use client';
import { useState, useEffect } from 'react';
import { Trade } from '@/types/trade';
import { loadTrades, saveTrades, exportToJSON, importFromJSON, clearAllData } from '@/utils/storage';
import { sampleTrades } from '@/data/sampleTrades';
import CSVImport from '@/components/CSVImport';
import './page.css';

export default function ImportPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [sampleDataLoaded, setSampleDataLoaded] = useState(false);
  const [jsonFile, setJsonFile] = useState<File | null>(null);

  // Load trades on mount
  useEffect(() => {
    const loaded = loadTrades();
    setTrades(loaded);

    // Check if sample data is already loaded by looking for sample IDs
    const hasSample = loaded.some((t) => t.id.startsWith('sample-'));
    setSampleDataLoaded(hasSample);
  }, []);

  // Auto-dismiss notification after 3 seconds
  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => {
      setNotification(null);
    }, 3000);
    return () => clearTimeout(timer);
  }, [notification]);

  // ---------------------------------------------------------------------------
  // CSV Import handler
  // ---------------------------------------------------------------------------
  function handleCSVImport(newTrades: Trade[]) {
    const existing = loadTrades();
    const existingIds = new Set(existing.map((t) => t.id));
    const uniqueNewTrades = newTrades.filter((t) => !existingIds.has(t.id));
    const merged = [...existing, ...uniqueNewTrades];
    saveTrades(merged);
    setTrades(merged);
    setNotification({
      message: `Successfully imported ${uniqueNewTrades.length} trade${uniqueNewTrades.length !== 1 ? 's' : ''} from CSV.`,
      type: 'success',
    });
  }

  // ---------------------------------------------------------------------------
  // JSON Import handler
  // ---------------------------------------------------------------------------
  async function handleJSONImport() {
    if (!jsonFile) return;

    try {
      const importedTrades = await importFromJSON(jsonFile);

      if (importedTrades.length === 0) {
        setNotification({ message: 'The JSON file contains no trades.', type: 'error' });
        return;
      }

      const existing = loadTrades();
      const existingIds = new Set(existing.map((t) => t.id));
      const uniqueNewTrades = importedTrades.filter((t) => !existingIds.has(t.id));
      const merged = [...existing, ...uniqueNewTrades];
      saveTrades(merged);
      setTrades(merged);
      setJsonFile(null);

      // Reset the file input
      const fileInput = document.getElementById('json-file-input') as HTMLInputElement;
      if (fileInput) fileInput.value = '';

      setNotification({
        message: `Successfully imported ${uniqueNewTrades.length} trade${uniqueNewTrades.length !== 1 ? 's' : ''} from JSON.`,
        type: 'success',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import JSON file.';
      setNotification({ message, type: 'error' });
    }
  }

  // ---------------------------------------------------------------------------
  // Export handler
  // ---------------------------------------------------------------------------
  function handleExport() {
    if (trades.length === 0) {
      setNotification({ message: 'No trades to export.', type: 'error' });
      return;
    }
    exportToJSON(trades);
    setNotification({ message: 'Trading data exported successfully.', type: 'success' });
  }

  // ---------------------------------------------------------------------------
  // Sample data handler
  // ---------------------------------------------------------------------------
  function handleLoadSampleData() {
    const existing = loadTrades();
    const existingIds = new Set(existing.map((t) => t.id));
    const uniqueSampleTrades = sampleTrades.filter((t) => !existingIds.has(t.id));
    const merged = [...existing, ...uniqueSampleTrades];
    saveTrades(merged);
    setTrades(merged);
    setSampleDataLoaded(true);
    setNotification({
      message: `Loaded ${uniqueSampleTrades.length} sample trade${uniqueSampleTrades.length !== 1 ? 's' : ''}.`,
      type: 'success',
    });
  }

  // ---------------------------------------------------------------------------
  // Clear all data handler
  // ---------------------------------------------------------------------------
  function handleClearAllData() {
    const confirmed = window.confirm(
      'Are you sure you want to delete all trading data? This action cannot be undone.'
    );
    if (!confirmed) return;

    clearAllData();
    setTrades([]);
    setSampleDataLoaded(false);
    setNotification({ message: 'All trading data has been cleared.', type: 'success' });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="page-container">
      {/* Notification toast */}
      {notification && (
        <div className={`import-notification ${notification.type}`}>
          {notification.message}
        </div>
      )}

      {/* Page header */}
      <div className="page-header">
        <h1 className="page-title">Import & Export</h1>
        <p className="page-subtitle">Manage your trading data</p>
      </div>

      <div className="import-layout">
        {/* ----------------------------------------------------------------- */}
        {/* Left column: Import sections                                      */}
        {/* ----------------------------------------------------------------- */}
        <div>
          {/* CSV Import */}
          <div className="import-section">
            <h2 className="import-section-title">Import from CSV</h2>
            <CSVImport onImport={handleCSVImport} />
          </div>

          {/* JSON Import */}
          <div className="import-section">
            <h2 className="import-section-title">Import from JSON Backup</h2>
            <p className="import-section-desc">
              Restore trades from a previously exported JSON backup file.
            </p>
            <div className="import-json-input">
              <input
                id="json-file-input"
                type="file"
                accept=".json"
                className="input"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setJsonFile(file);
                }}
              />
            </div>
            <button
              className="btn btn-primary"
              disabled={!jsonFile}
              onClick={handleJSONImport}
            >
              Import JSON
            </button>
          </div>
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* Right column: Export, Sample Data, Danger Zone                     */}
        {/* ----------------------------------------------------------------- */}
        <div>
          {/* Export Data */}
          <div className="glass-card import-card">
            <h3 className="import-card-title">Export Data</h3>
            <p className="import-card-desc">
              Download a backup of all your trading data.
            </p>
            <p className="import-trade-count">
              You have <strong>{trades.length}</strong> trade{trades.length !== 1 ? 's' : ''}
            </p>
            <button className="btn btn-primary" onClick={handleExport}>
              Export as JSON
            </button>
          </div>

          {/* Sample Data */}
          <div className="glass-card import-card">
            <h3 className="import-card-title">Sample Data</h3>
            <p className="import-card-desc">
              Load 55+ demo trades to explore the app.
            </p>
            {sampleDataLoaded ? (
              <div className="import-sample-loaded">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <span>Sample data loaded</span>
              </div>
            ) : (
              <button className="btn btn-secondary" onClick={handleLoadSampleData}>
                Load Sample Data
              </button>
            )}
          </div>

          {/* Danger Zone */}
          <div className="glass-card import-card import-danger-zone">
            <h3 className="import-card-title">Danger Zone</h3>
            <p className="import-card-desc">
              Permanently delete all trading data from your browser. This action cannot be undone.
            </p>
            <button className="btn btn-danger" onClick={handleClearAllData}>
              Clear All Data
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
