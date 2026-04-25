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

// Edit this once to switch the bot between 1h/2h/4h:
const TF = process.env.FTMO_TF || "1h"; // "1h" | "2h" | "4h"
const STATE_DIR = path.resolve(__dirname, "..", `ftmo-state-${TF}`);
const REPO_ROOT = path.resolve(__dirname, "..");

// Telegram (set via real env vars or hardcode here for VPS-only deploy)
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "8784347792:AAGOuLww-yTQIYs_ZsE1EbvnoZuBpXaGMtU";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "8794162768";

const sharedEnv = {
  FTMO_TF: TF,
  FTMO_STATE_DIR: STATE_DIR,
  FTMO_START_BALANCE: "100000",
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
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
      args: "tools/ftmo_executor.py",
      interpreter: "none",
      env: {
        ...sharedEnv,
        FTMO_ETH_SYMBOL: "ETHUSD",
        FTMO_BTC_SYMBOL: "BTCUSD",
        FTMO_SOL_SYMBOL: "SOLUSD",
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
