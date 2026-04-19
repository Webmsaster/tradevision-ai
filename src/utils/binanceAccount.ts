/**
 * Binance Futures account read-only helpers.
 *
 * READ-ONLY at this stage — fetches balance, open positions, and order
 * history. No order-placement yet (that comes in iter73-74 after review).
 *
 * Uses HMAC-SHA256 signing per Binance docs:
 * https://binance-docs.github.io/apidocs/futures/en/#endpoint-security-type
 *
 * Env vars required:
 *   BINANCE_API_KEY
 *   BINANCE_API_SECRET
 *   BINANCE_TESTNET=1  (optional; defaults to mainnet if unset)
 *
 * SAFETY: always prefer testnet while developing. Mainnet keys can read
 * your real balance but this module CANNOT place orders — safe by design.
 */
import crypto from "node:crypto";

const MAINNET = "https://fapi.binance.com";
const TESTNET = "https://testnet.binancefuture.com";

export interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
  /** Recv window in ms (default 5000). */
  recvWindow?: number;
}

export function configFromEnv(): BinanceConfig {
  return {
    apiKey: process.env.BINANCE_API_KEY ?? "",
    apiSecret: process.env.BINANCE_API_SECRET ?? "",
    testnet: process.env.BINANCE_TESTNET === "1",
    recvWindow: Number(process.env.BINANCE_RECV_WINDOW ?? 5000),
  };
}

function baseUrl(cfg: BinanceConfig): string {
  return cfg.testnet ? TESTNET : MAINNET;
}

function sign(params: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(params).digest("hex");
}

/**
 * Builds a signed query string for a USDT-M Futures request.
 * Appends timestamp + signature.
 */
export function buildSignedQuery(
  params: Record<string, string | number>,
  cfg: BinanceConfig,
): string {
  const merged: Record<string, string | number> = {
    ...params,
    timestamp: Date.now(),
    recvWindow: cfg.recvWindow ?? 5000,
  };
  const qs = Object.entries(merged)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const signature = sign(qs, cfg.apiSecret);
  return `${qs}&signature=${signature}`;
}

async function signedGet<T>(
  path: string,
  params: Record<string, string | number>,
  cfg: BinanceConfig,
): Promise<T> {
  if (!cfg.apiKey || !cfg.apiSecret) {
    throw new Error(
      "Binance API key/secret not set (BINANCE_API_KEY / BINANCE_API_SECRET)",
    );
  }
  const qs = buildSignedQuery(params, cfg);
  const url = `${baseUrl(cfg)}${path}?${qs}`;
  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": cfg.apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Binance ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Account endpoints
// ---------------------------------------------------------------------------

export interface AccountBalance {
  asset: string;
  balance: number;
  availableBalance: number;
  crossWalletBalance: number;
  crossUnPnl: number;
}

export async function fetchAccountBalance(
  cfg: BinanceConfig = configFromEnv(),
): Promise<AccountBalance[]> {
  type Raw = {
    asset: string;
    balance: string;
    availableBalance: string;
    crossWalletBalance: string;
    crossUnPnl: string;
  };
  const rows = await signedGet<Raw[]>("/fapi/v2/balance", {}, cfg);
  return rows.map((r) => ({
    asset: r.asset,
    balance: parseFloat(r.balance),
    availableBalance: parseFloat(r.availableBalance),
    crossWalletBalance: parseFloat(r.crossWalletBalance),
    crossUnPnl: parseFloat(r.crossUnPnl),
  }));
}

export interface OpenPosition {
  symbol: string;
  positionAmt: number; // +long, -short, 0=flat
  entryPrice: number;
  markPrice: number;
  unrealisedPnl: number;
  liquidationPrice: number;
  leverage: number;
  marginType: "isolated" | "cross";
}

export async function fetchOpenPositions(
  cfg: BinanceConfig = configFromEnv(),
): Promise<OpenPosition[]> {
  type Raw = {
    symbol: string;
    positionAmt: string;
    entryPrice: string;
    markPrice: string;
    unRealizedProfit: string;
    liquidationPrice: string;
    leverage: string;
    marginType: "isolated" | "cross";
  };
  const rows = await signedGet<Raw[]>("/fapi/v2/positionRisk", {}, cfg);
  return rows
    .map<OpenPosition>((r) => ({
      symbol: r.symbol,
      positionAmt: parseFloat(r.positionAmt),
      entryPrice: parseFloat(r.entryPrice),
      markPrice: parseFloat(r.markPrice),
      unrealisedPnl: parseFloat(r.unRealizedProfit),
      liquidationPrice: parseFloat(r.liquidationPrice),
      leverage: parseInt(r.leverage, 10),
      marginType: r.marginType,
    }))
    .filter((p) => Math.abs(p.positionAmt) > 0);
}

export interface AccountSnapshot {
  usdtBalance: number;
  usdtAvailable: number;
  totalUnrealisedPnl: number;
  openPositions: OpenPosition[];
  fetchedAt: string;
  isTestnet: boolean;
}

/** One-shot aggregation for the dashboard. */
export async function snapshotAccount(
  cfg: BinanceConfig = configFromEnv(),
): Promise<AccountSnapshot> {
  const [balances, positions] = await Promise.all([
    fetchAccountBalance(cfg),
    fetchOpenPositions(cfg),
  ]);
  const usdt = balances.find((b) => b.asset === "USDT");
  const totalUpnl = positions.reduce((s, p) => s + p.unrealisedPnl, 0);
  return {
    usdtBalance: usdt?.balance ?? 0,
    usdtAvailable: usdt?.availableBalance ?? 0,
    totalUnrealisedPnl: totalUpnl,
    openPositions: positions,
    fetchedAt: new Date().toISOString(),
    isTestnet: cfg.testnet,
  };
}
