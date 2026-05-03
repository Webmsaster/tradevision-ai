/** Custom event name dispatched when settings are saved, listened to by Dashboard and useTradeStorage. */
export const SETTINGS_CHANGED_EVENT = "tradevision-settings-changed";

/** localStorage key for settings. */
export const SETTINGS_KEY = "tradevision-settings";

/**
 * localStorage key for trades. Authoritative copy lives in src/utils/storage.ts;
 * exported here so cross-tab `storage` event listeners (useTradeStorage hook)
 * can compare against the same constant instead of a string literal that drifts.
 */
export const STORAGE_KEY = "trading-journal-trades";

// ============================================================================
// Phase 72 (R45-CC-M3, R45-CC-L1): centralized day / month / file-size
// constants. Were previously redeclared inline at 3+ call sites with drift
// risk if locale or order ever changes.
// ============================================================================

export const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** File-size limits used across the app — single source of truth. */
export const FILE_SIZE = {
  /** Max screenshot data-URL size before validateScreenshot rejects. */
  SCREENSHOT_MAX: 2 * 1024 * 1024,
  /** Hard cap on uploaded image source file before compression. */
  IMAGE_UPLOAD_MAX: 5 * 1024 * 1024,
  /** Max JSON backup file the import path will accept. */
  JSON_IMPORT_MAX: 10 * 1024 * 1024,
} as const;
