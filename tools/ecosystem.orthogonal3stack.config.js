/**
 * PM2 ecosystem config for the Orthogonal 3-Stack FTMO Bot.
 *
 * 2026-05-23 Production Deploy (3 accounts × signal+executor pair):
 *
 *   Account 1: V5_AMBER_MAX_PASSLOCK        + Basket-18 + BNB 18/50 → 32.90% combined-funded (TRUE-SEQUENTIAL)
 *   Account 5: V5_AMBER_MAX_PASSLOCK_BIDIR  + Basket-18 + BNB 18/50 → 29.79% combined-funded
 *   Account 4: V5_AMBER_MAX_MR_PASSLOCK     + Basket-18 + BNB 18/50 → 16.15% combined-funded
 *
 * 3-Stack OR-aggregation (per-window min-1-funded, n=997 valid windows):
 *   AMBER + BIDIR + MR = 51.96%   (vs 32.90% single-account → +19pp)
 *
 * Cross-signal-class diversification:
 *   AMBER  = trend-long  (invertDirection + disableShort=true)
 *   BIDIR  = trend long+short (disableShort=false on every asset)
 *   MR     = mean-revert (RSI 14, oversold=25/overbought=75)
 *
 * Pairwise correlations (binary funded vector, 2026-05-23 measured):
 *   AMBER <-> BIDIR  +0.300   (less orthogonal than hoped — still useful)
 *   AMBER <-> MR     +0.081   (genuinely orthogonal, drives diversification)
 *   BIDIR <-> MR     +0.209
 *
 * Usage:
 *   # Fill in MT5 logins + Telegram tokens in:
 *   #   .env.ftmo.account-1, .env.ftmo.account-4, .env.ftmo.account-5
 *   pm2 start tools/ecosystem.orthogonal3stack.config.js
 *   pm2 save
 *
 * Stop all 3:
 *   pm2 stop ftmo-signal-amber-max ftmo-executor-amber-max \
 *            ftmo-signal-amber-mr  ftmo-executor-amber-mr  \
 *            ftmo-signal-bidir     ftmo-executor-bidir
 *
 * ⚠️ PRE-DEPLOY CHECKLIST:
 *   1. TF_DISPATCH wiring (2026-05-23 commit 1b99975): AMBER + BIDIR + MR
 *      + RUBIN_PASSLOCK now registered in scripts/ftmoLiveService.ts and
 *      isExplicitPasslockSister → V4-engine routing kicks in.
 *   2. ⚠️ Cross-asset BNB 18/50 is NOT yet baked into the TS CFG. The Rust
 *      backtest CLI override (--cross-asset-sym BNBUSDT --cross-asset-fast 18
 *      --cross-asset-slow 50) is not honored at runtime. Live signals will
 *      use the per-config default (BTC 9/21 / BTC 10/15 depending on config)
 *      and lose ~5-10pp vs backtest. The TS engine cross-asset semantics
 *      differ from Rust's `direction:"any"` (TS uses skipShorts/skipLongs
 *      booleans) — patch needs careful direction-flag review.
 *   3. tp_mult=1.10 / Kelly fraction=0.5 / window=60 / min-trades=20 are
 *      backtest CLI overrides. Verify the live engine path honors them or
 *      bake into the CFG.
 *   4. Run `tools/signal_tracker_mode.py` 24-48h BEFORE buying Challenges
 *      so the live signal-history.jsonl is populated and the
 *      Challenge-Start-Gate (breadth>=4 + majors>=3) decides correctly from
 *      bar 1.
 */
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    console.warn(
      `[pm2-3stack] WARNING: ${filePath} not found — skipping account`,
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
    console.warn(`[pm2-3stack] ${envFile} missing FTMO_TF — skipping`);
    return [];
  }
  const stateDir = env.FTMO_STATE_DIR
    ? path.resolve(REPO_ROOT, env.FTMO_STATE_DIR)
    : path.resolve(REPO_ROOT, `ftmo-state-${tf}-${accountId}`);
  if (seenStateDirs.has(stateDir)) {
    console.error(
      `[pm2-3stack] FATAL: state-dir collision — ${envFile} resolves to the same FTMO_STATE_DIR as ${seenStateDirs.get(stateDir)}.\n` +
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
      `[pm2-3stack] FATAL: ${stateDir} exists but is not a directory.`,
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
  // Account 4 → AMBER_MR (mean-reversion — best orthogonality vs AMBER)
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.account-4"), "amber-mr"),
  // Account 5 → BIDIR (long+short variant)
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.account-5"), "bidir"),
];

if (apps.length === 0) {
  console.error(
    "[pm2-3stack] FATAL: no env files loaded. Copy .env.ftmo.account-{1,4,5}.example → .env.ftmo.account-{1,4,5} and fill in.",
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
    `[pm2-3stack] FATAL: ${masters.length} accounts have FTMO_TELEGRAM_BOT_MASTER=1 (${masters.join(", ")}). ` +
      "Only one account may run the Telegram listener — Telegram getUpdates returns 409 Conflict otherwise.",
  );
  process.exit(4);
}
if (masters.length === 0) {
  console.warn(
    "[pm2-3stack] WARNING: no account has FTMO_TELEGRAM_BOT_MASTER=1 — Telegram /commands disabled (alerts still send).",
  );
}

console.log(
  `[pm2-3stack] Launching ${apps.length / 2} account(s): ` +
    apps
      .filter((a) => a.name.startsWith("ftmo-signal-"))
      .map((a) => a.name.replace("ftmo-signal-", ""))
      .join(", "),
);

module.exports = { apps };
