/**
 * PM2 ecosystem config for 3-Strategy Multi-Account FTMO Bot.
 *
 * Round 60 deploy: 3 accounts running 3 different strategies for
 * decorrelated min-1-pass ~94%.
 *
 * Account 1: R28_V6_PASSLOCK (master Telegram listener)
 * Account 2: V5_TITANIUM (long-history validated)
 * Account 3: V5_AMBER (best step=1d)
 *
 * Usage:
 *   # Per-account env files must exist + filled:
 *   #   .env.ftmo.demo1, .env.ftmo.titanium, .env.ftmo.amber
 *   pm2 start tools/ecosystem-multi.config.js
 *   pm2 save
 *
 * Stop all 3:
 *   pm2 stop ftmo-r28-v6 ftmo-titanium ftmo-amber
 *
 * Per-account state-dirs auto-derived: ftmo-state-<FTMO_TF>-<FTMO_ACCOUNT_ID>
 */
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    console.warn(`[pm2-multi] WARNING: ${filePath} not found — skipping account`);
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
      // Strip trailing inline-comment "FOO=bar # comment" only when unquoted.
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    env[key] = val;
  }
  return env;
}

// Track allocated state-dirs across all accounts to catch collisions.
const seenStateDirs = new Map(); // stateDir -> envFile

function buildAppPair(envFile, accountLabel) {
  const env = loadEnvFile(envFile);
  if (!env) return [];
  const tf = env.FTMO_TF;
  const accountId = env.FTMO_ACCOUNT_ID || "default";
  if (!tf) {
    console.warn(`[pm2-multi] ${envFile} missing FTMO_TF — skipping`);
    return [];
  }
  const stateDir = path.resolve(REPO_ROOT, `ftmo-state-${tf}-${accountId}`);
  if (seenStateDirs.has(stateDir)) {
    console.error(
      `[pm2-multi] FATAL: state-dir collision — ${envFile} resolves to the same FTMO_STATE_DIR as ${seenStateDirs.get(stateDir)}.\n` +
        `         Both have FTMO_TF=${tf} + FTMO_ACCOUNT_ID=${accountId}. Set a unique FTMO_ACCOUNT_ID per env file.`,
    );
    process.exit(2);
  }
  seenStateDirs.set(stateDir, envFile);
  // Ensure state-dir exists for log files. mkdir is racy across concurrent PM2
  // launches, so swallow EEXIST and only fail if the path is a non-directory.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }
  const stat = fs.statSync(stateDir);
  if (!stat.isDirectory()) {
    console.error(`[pm2-multi] FATAL: ${stateDir} exists but is not a directory.`);
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
        // R67-r8: AVAUSD (no X) per FTMO MT5 dialog (2026-04-27).
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
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.demo1"), "r28-v6"),
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.titanium"), "titanium"),
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.amber"), "amber"),
];

if (apps.length === 0) {
  console.error(
    "[pm2-multi] FATAL: no env files loaded. Copy .env.ftmo.*.example → .env.ftmo.* and fill in.",
  );
  process.exit(1);
}

// Validate Telegram-master flag: at most one account may long-poll getUpdates,
// otherwise Telegram returns 409 Conflict. Zero is allowed (no /commands but
// alerts still send).
const masters = apps
  .filter((a) => a.name.startsWith("ftmo-signal-"))
  .filter((a) => {
    const v = a.env.FTMO_TELEGRAM_BOT_MASTER;
    return v === "1" || v === "true";
  })
  .map((a) => a.name.replace("ftmo-signal-", ""));
if (masters.length > 1) {
  console.error(
    `[pm2-multi] FATAL: ${masters.length} accounts have FTMO_TELEGRAM_BOT_MASTER=1 (${masters.join(", ")}). ` +
      "Only one account may run the Telegram listener — Telegram getUpdates returns 409 Conflict otherwise.",
  );
  process.exit(4);
}
if (masters.length === 0) {
  console.warn(
    "[pm2-multi] WARNING: no account has FTMO_TELEGRAM_BOT_MASTER=1 — Telegram /commands disabled (alerts still send).",
  );
}

console.log(
  `[pm2-multi] Launching ${apps.length / 2} account(s): ` +
    apps
      .filter((a) => a.name.startsWith("ftmo-signal-"))
      .map((a) => a.name.replace("ftmo-signal-", ""))
      .join(", "),
);

module.exports = { apps };
