/**
 * PM2 ecosystem config for 4-Stack Multi-Account FTMO Bot.
 *
 * 2026-05-19 Production Deploy (4 accounts × signal+executor pair):
 *
 *   Account 1: V5_AMBER_MAX_PASSLOCK  + Basket-18 + BNB 18/50  → 60.27% Step-1 (master Telegram listener)
 *   Account 2: V5_RUBIN_PASSLOCK       + Basket-18 + BNB 18/50  → 50.00% Step-1
 *   Account 3: V5_TITANIUM_PASSLOCK    + Basket-18 + BNB 18/50  → 41.76% Step-1
 *   Account 4: V5_AMBER_MAX_MR_PASSLOCK + Basket-18 + BNB 18/50 → 52.05% Step-1 (mean-reversion)
 *
 * 4-Stack OR-aggregation (per-window min-1-pass, n=146 common windows):
 *   AMBER+RUBIN+TITANIUM+MR = 84.93%
 *
 * Key correlation insight:
 *   AMBER ↔ TITANIUM = +0.001 (orthogonal — best diversifier)
 *   AMBER ↔ AMBER_MR = +0.258 (different signal class)
 *   AMBER ↔ RUBIN    = +0.700 (similar trend basket — least diverse)
 *
 * Usage:
 *   # Fill in MT5 logins + Telegram tokens in:
 *   #   .env.ftmo.account-1, .env.ftmo.account-2, .env.ftmo.account-3, .env.ftmo.account-4
 *   pm2 start tools/ecosystem.4stack.config.js
 *   pm2 save
 *
 * Stop all 4:
 *   pm2 stop ftmo-signal-amber-max ftmo-executor-amber-max \
 *            ftmo-signal-rubin ftmo-executor-rubin \
 *            ftmo-signal-titanium ftmo-executor-titanium \
 *            ftmo-signal-amber-mr ftmo-executor-amber-mr
 *
 * ⚠️ PRE-DEPLOY CHECKLIST:
 *   1. V5_RUBIN_PASSLOCK + V5_AMBER_MAX_MR_PASSLOCK are NOT yet registered in
 *      scripts/ftmoLiveService.ts TF_DISPATCH. Add them before deploy:
 *        "2h-trend-v5-rubin-passlock": "30m",
 *        "2h-trend-v5-amber-max-mr-passlock": "30m",
 *      Also add both to `isExplicitPasslockSister` so V4-engine routing kicks in.
 *   2. The backtest used CLI overrides --cross-asset-sym BNBUSDT --cross-asset-fast 18
 *      --cross-asset-slow 50 — the live engine reads CrossAssetFilter from the CFG.
 *      Patch the 4 templates in src/utils/ftmoDaytrade24h.ts (or templates.rs +
 *      mirror in TS) to set:
 *        crossAssetFilter: { symbol: "BNBUSDT", emaFastPeriod: 18, emaSlowPeriod: 50,
 *                            momentumBars: 6, direction: "any" }
 *      Without this, live signals fall back to the per-config default (BTC 9/21
 *      for most V5 configs) and lose ~10pp vs backtest.
 *   3. tp_mult=1.10 / Kelly fraction=0.5 / window=60 / min-trades=20 are also
 *      backtest CLI overrides. Verify the live live-engine path honors them or
 *      bake them into the cfg.
 */
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    console.warn(
      `[pm2-4stack] WARNING: ${filePath} not found — skipping account`,
    );
    return null;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    const isDQ = val.startsWith('"') && val.endsWith('"') && val.length >= 2;
    const isSQ = val.startsWith("'") && val.endsWith("'") && val.length >= 2;
    if (isDQ || isSQ) {
      val = val.slice(1, -1);
    } else {
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    env[key] = val;
  }
  return env;
}

const seenStateDirs = new Map();

function buildAppPair(envFile, accountLabel) {
  const env = loadEnvFile(envFile);
  if (!env) return [];
  const tf = env.FTMO_TF;
  const accountId = env.FTMO_ACCOUNT_ID || "default";
  if (!tf) {
    console.warn(`[pm2-4stack] ${envFile} missing FTMO_TF — skipping`);
    return [];
  }
  const stateDir = env.FTMO_STATE_DIR
    ? path.resolve(REPO_ROOT, env.FTMO_STATE_DIR)
    : path.resolve(REPO_ROOT, `ftmo-state-${tf}-${accountId}`);
  if (seenStateDirs.has(stateDir)) {
    console.error(
      `[pm2-4stack] FATAL: state-dir collision — ${envFile} resolves to the same FTMO_STATE_DIR as ${seenStateDirs.get(stateDir)}.\n` +
        `         Both have FTMO_TF=${tf} + FTMO_ACCOUNT_ID=${accountId}. Set a unique FTMO_ACCOUNT_ID per env file.`,
    );
    process.exit(2);
  }
  seenStateDirs.set(stateDir, envFile);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }
  const stat = fs.statSync(stateDir);
  if (!stat.isDirectory()) {
    console.error(
      `[pm2-4stack] FATAL: ${stateDir} exists but is not a directory.`,
    );
    process.exit(3);
  }

  const sharedEnv = {
    ...env,
    FTMO_STATE_DIR: stateDir,
  };

  return [
    {
      name: `ftmo-signal-${accountLabel}`,
      cwd: REPO_ROOT,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "scripts/ftmoLiveService.ts",
      env: sharedEnv,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: "500M",
      out_file: path.join(stateDir, "pm2-signal.out.log"),
      error_file: path.join(stateDir, "pm2-signal.err.log"),
      time: true,
    },
    {
      name: `ftmo-executor-${accountLabel}`,
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
        FTMO_AVAX_SYMBOL: "AVAUSD",
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10000,
      max_memory_restart: "300M",
      out_file: path.join(stateDir, "pm2-executor.out.log"),
      error_file: path.join(stateDir, "pm2-executor.err.log"),
      time: true,
    },
  ];
}

const apps = [
  // Account 1 → AMBER_MAX (master Telegram listener)
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.account-1"), "amber-max"),
  // Account 2 → RUBIN
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.account-2"), "rubin"),
  // Account 3 → TITANIUM (best diversifier — corr 0.001 with AMBER)
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.account-3"), "titanium"),
  // Account 4 → AMBER_MR (mean-reversion signal class)
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.account-4"), "amber-mr"),
];

if (apps.length === 0) {
  console.error(
    "[pm2-4stack] FATAL: no env files loaded. Copy .env.ftmo.account-{1-4}.example → .env.ftmo.account-{1-4} and fill in.",
  );
  process.exit(1);
}

// Validate exactly one Telegram master listener.
const masters = apps
  .filter((a) => a.name.startsWith("ftmo-signal-"))
  .filter((a) => {
    const v = a.env.FTMO_TELEGRAM_BOT_MASTER;
    return v === "1" || v === "true";
  })
  .map((a) => a.name.replace("ftmo-signal-", ""));
if (masters.length > 1) {
  console.error(
    `[pm2-4stack] FATAL: ${masters.length} accounts have FTMO_TELEGRAM_BOT_MASTER=1 (${masters.join(", ")}). ` +
      "Only one account may run the Telegram listener — Telegram getUpdates returns 409 Conflict otherwise.",
  );
  process.exit(4);
}
if (masters.length === 0) {
  console.warn(
    "[pm2-4stack] WARNING: no account has FTMO_TELEGRAM_BOT_MASTER=1 — Telegram /commands disabled (alerts still send).",
  );
}

console.log(
  `[pm2-4stack] Launching ${apps.length / 2} account(s): ` +
    apps
      .filter((a) => a.name.startsWith("ftmo-signal-"))
      .map((a) => a.name.replace("ftmo-signal-", ""))
      .join(", "),
);

module.exports = { apps };
