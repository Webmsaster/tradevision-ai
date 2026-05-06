/**
 * PM2 ecosystem config for the FTMO bot.
 *
 * Usage on Windows VPS (after `npm install -g pm2 pm2-windows-startup`):
 *
 *   pm2 start tools/ecosystem.config.js
 *   pm2 save
 *   pm2-startup install   # auto-start on boot
 *
 * To switch timeframe between deploys, edit FTMO_TF in the env block
 * for both processes (must match), then `pm2 reload ecosystem.config.js`.
 *
 * Common commands:
 *   pm2 list                # show running services
 *   pm2 logs ftmo-signal    # tail Node service log
 *   pm2 logs ftmo-executor  # tail Python executor log
 *   pm2 restart all         # restart both
 *   pm2 stop all            # stop both
 *   pm2 delete all          # remove from PM2
 */
const path = require("path");

// Phase 62 (R45-CFG-5): default updated to the current production
// champion (V4-engine route — V5_QUARTZ_LITE_R28_V4). Was "1h" which
// pointed to a stale config; an operator running `pm2 start` without
// FTMO_TF would unknowingly run a different strategy than the one
// claimed in CLAUDE.md / docs.
const TF = process.env.FTMO_TF || "2h-trend-v5-quartz-lite-r28-v4engine";
const STATE_DIR = path.resolve(__dirname, "..", `ftmo-state-${TF}`);
const REPO_ROOT = path.resolve(__dirname, "..");

// Telegram — Phase 12 (CRITICAL Auth Bug 1): hardcoded fallback removed.
// Previously contained committed bot token + chat-id (visible in git history).
// MUST be set via real env vars / .env.ftmo / pm2 ecosystem env.
// REVOKE the leaked token at @BotFather → /revoke before redeploying.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn(
    "[pm2] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — running without Telegram alerts",
  );
}

const sharedEnv = {
  FTMO_TF: TF,
  FTMO_STATE_DIR: STATE_DIR,
  FTMO_START_BALANCE: "100000",
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  FTMO_TELEGRAM_BOT_MASTER: "1", // single-account: always master
};

module.exports = {
  apps: [
    {
      name: "ftmo-signal",
      cwd: REPO_ROOT,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "scripts/ftmoLiveService.ts",
      env: sharedEnv,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000, // 5s between restarts
      max_memory_restart: "500M",
      out_file: path.join(STATE_DIR, "pm2-signal.out.log"),
      error_file: path.join(STATE_DIR, "pm2-signal.err.log"),
      time: true, // prefix timestamps to log lines
    },
    {
      name: "ftmo-executor",
      cwd: REPO_ROOT,
      script: "python",
      args: "-u tools/ftmo_executor.py",
      interpreter: "none",
      env: {
        ...sharedEnv,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        FTMO_ETH_SYMBOL: "ETHUSD",
        FTMO_BTC_SYMBOL: "BTCUSD",
        FTMO_SOL_SYMBOL: "SOLUSD",
        FTMO_BCH_SYMBOL: "BCHUSD",
        FTMO_LTC_SYMBOL: "LTCUSD",
        FTMO_LINK_SYMBOL: "LNKUSD",
        FTMO_BNB_SYMBOL: "BNBUSD",
        FTMO_ADA_SYMBOL: "ADAUSD",
        FTMO_DOGE_SYMBOL: "DOGEUSD",
        // R67-r8 audit: REVERT inverse-regression. User-verified 2026-04-27
        // (FTMO MT5 Symbols dialog screenshot, see reference_ftmo_mt5_tickers.md):
        // FTMO ticker is AVAUSD (no X). The "Phase 62 typo fix" went the
        // wrong direction. ftmo_executor.py:140 default is correct AVAUSD.
        // With AVAXUSD: mt5.symbol_info("AVAXUSD") → None → AVAX silently
        // dropped. Don't "fix" this back without verifying MT5 dialog.
        FTMO_AVAX_SYMBOL: "AVAUSD",
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10000, // 10s — give MT5 time to come back after disconnect
      max_memory_restart: "300M",
      out_file: path.join(STATE_DIR, "pm2-executor.out.log"),
      error_file: path.join(STATE_DIR, "pm2-executor.err.log"),
      time: true,
    },
  ],
};
