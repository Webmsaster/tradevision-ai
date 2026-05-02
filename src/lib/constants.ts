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
