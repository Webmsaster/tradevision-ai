"use client";
import { useState, useEffect, useMemo } from "react";
import { Trade } from "@/types/trade";
import { exportToJSON, exportToCSV, importFromJSON } from "@/utils/storage";
import { useTradeStorage } from "@/hooks/useTradeStorage";
import CSVImport from "@/components/CSVImport";
import ConfirmDialog from "@/components/ConfirmDialog";

export default function ImportPage() {
  const { trades, importTrades, clearAll, setAllTrades } = useTradeStorage();
  const [notification, setNotification] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [jsonImportMode, setJsonImportMode] = useState<"merge" | "replace">(
    "merge",
  );
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);
  const [pendingReplaceTrades, setPendingReplaceTrades] = useState<
    Trade[] | null
  >(null);

  // Check if sample data is already loaded by looking for sample IDs
  const sampleDataLoaded = useMemo(
    () => trades.some((t) => t.id.startsWith("sample-")),
    [trades],
  );

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
  async function handleCSVImport(newTrades: Trade[]) {
    const count = await importTrades(newTrades);
    setNotification({
      message: `Successfully imported ${count} trade${count !== 1 ? "s" : ""} from CSV.`,
      type: "success",
    });
  }

  // ---------------------------------------------------------------------------
  // JSON Import handler
  // ---------------------------------------------------------------------------
  function resetJsonFileInput() {
    setJsonFile(null);
    const fileInput = document.getElementById(
      "json-file-input",
    ) as HTMLInputElement | null;
    if (fileInput) fileInput.value = "";
  }

  async function runMergeImport(importedTrades: Trade[]) {
    const count = await importTrades(importedTrades);
    resetJsonFileInput();
    setNotification({
      message: `Merged ${count} new trade${count !== 1 ? "s" : ""} from JSON.`,
      type: "success",
    });
  }

  async function runReplaceImport(importedTrades: Trade[]) {
    await setAllTrades(importedTrades);
    resetJsonFileInput();
    setNotification({
      message: `Replaced existing data with ${importedTrades.length} trade${importedTrades.length !== 1 ? "s" : ""} from JSON.`,
      type: "success",
    });
  }

  async function confirmReplaceImport() {
    if (!pendingReplaceTrades) return;
    try {
      await runReplaceImport(pendingReplaceTrades);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to replace data from JSON file.";
      setNotification({ message, type: "error" });
    } finally {
      setPendingReplaceTrades(null);
      setShowReplaceConfirm(false);
    }
  }

  async function handleJSONImport() {
    if (!jsonFile) return;

    try {
      const importedTrades = await importFromJSON(jsonFile);

      if (importedTrades.length === 0) {
        setNotification({
          message: "The JSON file contains no trades.",
          type: "error",
        });
        return;
      }

      if (jsonImportMode === "replace") {
        if (trades.length > 0) {
          setPendingReplaceTrades(importedTrades);
          setShowReplaceConfirm(true);
          return;
        }
        await runReplaceImport(importedTrades);
      } else {
        await runMergeImport(importedTrades);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to import JSON file.";
      setNotification({ message, type: "error" });
    }
  }

  // ---------------------------------------------------------------------------
  // Export handlers
  // ---------------------------------------------------------------------------
  function handleExportJSON() {
    if (trades.length === 0) {
      setNotification({ message: "No trades to export.", type: "error" });
      return;
    }
    exportToJSON(trades);
    setNotification({
      message: "Trading data exported as JSON.",
      type: "success",
    });
  }

  async function handleExportCSV() {
    if (trades.length === 0) {
      setNotification({ message: "No trades to export.", type: "error" });
      return;
    }
    await exportToCSV(trades);
    setNotification({
      message: "Trading data exported as CSV.",
      type: "success",
    });
  }

  // ---------------------------------------------------------------------------
  // Sample data handler
  // ---------------------------------------------------------------------------
  async function handleLoadSampleData() {
    const { sampleTrades } = await import("@/data/sampleTrades");
    const count = await importTrades(sampleTrades);
    setNotification({
      message: `Loaded ${count} sample trade${count !== 1 ? "s" : ""}.`,
      type: "success",
    });
  }

  // ---------------------------------------------------------------------------
  // Clear all data handler
  // ---------------------------------------------------------------------------
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  function handleClearAllData() {
    setShowClearConfirm(true);
  }

  function confirmClearAll() {
    clearAll();
    setShowClearConfirm(false);
    setNotification({
      message: "All trading data has been cleared.",
      type: "success",
    });
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
              <label htmlFor="json-file-input" className="input-label">
                JSON file
              </label>
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
            <div className="import-json-mode">
              <span className="import-json-mode-label">Restore mode</span>
              <label className="import-json-mode-option">
                <input
                  type="radio"
                  name="json-import-mode"
                  value="merge"
                  checked={jsonImportMode === "merge"}
                  onChange={() => setJsonImportMode("merge")}
                />
                <span>Merge (keep existing trades)</span>
              </label>
              <label className="import-json-mode-option">
                <input
                  type="radio"
                  name="json-import-mode"
                  value="replace"
                  checked={jsonImportMode === "replace"}
                  onChange={() => setJsonImportMode("replace")}
                />
                <span>Replace all existing trades</span>
              </label>
            </div>
            <button
              className="btn btn-primary"
              disabled={!jsonFile}
              onClick={handleJSONImport}
            >
              {jsonImportMode === "replace"
                ? "Replace with JSON"
                : "Import JSON"}
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
              You have <strong>{trades.length}</strong> trade
              {trades.length !== 1 ? "s" : ""}
            </p>
            <div style={{ display: "flex", gap: "12px" }}>
              <button className="btn btn-primary" onClick={handleExportJSON}>
                Export as JSON
              </button>
              <button className="btn btn-secondary" onClick={handleExportCSV}>
                Export as CSV
              </button>
            </div>
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
              <button
                className="btn btn-secondary"
                onClick={handleLoadSampleData}
              >
                Load Sample Data
              </button>
            )}
          </div>

          {/* Danger Zone */}
          <div className="glass-card import-card import-danger-zone">
            <h3 className="import-card-title">Danger Zone</h3>
            <p className="import-card-desc">
              Permanently delete all trading data from your browser. This action
              cannot be undone.
            </p>
            <button className="btn btn-danger" onClick={handleClearAllData}>
              Clear All Data
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showClearConfirm}
        title="Clear All Data"
        message="Are you sure you want to delete all trading data? This action cannot be undone."
        confirmLabel="Clear All"
        onConfirm={confirmClearAll}
        onCancel={() => setShowClearConfirm(false)}
      />

      <ConfirmDialog
        isOpen={showReplaceConfirm}
        title="Replace Existing Trades?"
        message={`This will overwrite your current ${trades.length} trade${trades.length !== 1 ? "s" : ""} with the JSON backup. This action cannot be undone.`}
        confirmLabel="Replace All"
        onConfirm={confirmReplaceImport}
        onCancel={() => {
          setShowReplaceConfirm(false);
          setPendingReplaceTrades(null);
        }}
      />
    </div>
  );
}
