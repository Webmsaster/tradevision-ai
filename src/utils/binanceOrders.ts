/**
 * Binance Futures order placement — WRITES orders.
 *
 * SAFETY PROTOCOL (enforced by `validateOrder()` before every HTTP call):
 *  1. EMERGENCY_HALT=1 env var blocks ALL orders
 *  2. Testnet is default; mainnet requires BINANCE_LIVE_MODE=1
 *  3. Hard cap: max notional per order (default $1000, override via
 *     BINANCE_MAX_ORDER_NOTIONAL)
 *  4. Symbol whitelist: only symbols in HF_DAYTRADING_ASSETS or LOCKED_EDGES
 *  5. Dry-run mode: returns simulated response without hitting API
 *
 * Every validation failure throws `OrderBlockedError` with a human-readable
 * reason. Callers should NOT catch and retry — a blocked order is a signal
 * that something is misconfigured.
 */
import crypto from "node:crypto";
import {
  configFromEnv,
  buildSignedQuery,
  type BinanceConfig,
} from "@/utils/binanceAccount";
import { HF_DAYTRADING_ASSETS } from "@/utils/hfDaytrading";

const MAINNET = "https://fapi.binance.com";
const TESTNET = "https://testnet.binancefuture.com";

export class OrderBlockedError extends Error {
  constructor(reason: string) {
    super(`Order blocked: ${reason}`);
    this.name = "OrderBlockedError";
  }
}

export interface PlaceOrderInput {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  /** Quantity in base asset (e.g. SUI contracts, not USDT). */
  quantity: number;
  /** Required for LIMIT; optional for MARKET. */
  price?: number;
  /** Post-only for maker-fee guarantee (LIMIT only). */
  postOnly?: boolean;
  /** Reduce-only for exits (won't open new positions). */
  reduceOnly?: boolean;
  /** Client order id for idempotency. */
  clientOrderId?: string;
  /** Notional estimate for safety cap check. If missing, use quantity × price. */
  notionalUsd?: number;
}

export interface OrderResponse {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  status: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED";
  type: "MARKET" | "LIMIT";
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  executedQty: number;
  avgPrice: number;
}

export interface OrderSafetyConfig {
  /** Max notional per order in USD. */
  maxNotionalUsd: number;
  /** Allowed symbols (whitelist). */
  symbolWhitelist: Set<string>;
  /** Require testnet (BINANCE_LIVE_MODE!=1). */
  testnetOnly: boolean;
  /** Dry-run mode — no HTTP call, returns simulated response. */
  dryRun: boolean;
  /** Hard emergency halt — block EVERYTHING. */
  emergencyHalt: boolean;
}

export function safetyConfigFromEnv(): OrderSafetyConfig {
  const whitelist = new Set<string>(
    HF_DAYTRADING_ASSETS as unknown as string[],
  );
  return {
    maxNotionalUsd: Number(process.env.BINANCE_MAX_ORDER_NOTIONAL ?? 1000),
    symbolWhitelist: whitelist,
    testnetOnly: process.env.BINANCE_LIVE_MODE !== "1",
    // SAFE BY DEFAULT: dry-run unless explicitly disabled. Requires
    // BINANCE_LIVE_EXECUTE=1 to make real HTTP calls.
    dryRun: process.env.BINANCE_LIVE_EXECUTE !== "1",
    emergencyHalt: process.env.EMERGENCY_HALT === "1",
  };
}

/**
 * Validates an order against all safety rules. Throws `OrderBlockedError`
 * on any violation. Pure — no side effects.
 */
export function validateOrder(
  order: PlaceOrderInput,
  cfg: BinanceConfig,
  safety: OrderSafetyConfig,
): void {
  if (safety.emergencyHalt) {
    throw new OrderBlockedError("EMERGENCY_HALT=1 env var active");
  }
  if (safety.testnetOnly && !cfg.testnet) {
    throw new OrderBlockedError(
      "mainnet blocked; set BINANCE_LIVE_MODE=1 to override (be careful)",
    );
  }
  if (!safety.symbolWhitelist.has(order.symbol)) {
    throw new OrderBlockedError(
      `symbol ${order.symbol} not in whitelist (${Array.from(safety.symbolWhitelist).join(", ")})`,
    );
  }
  const notional = order.notionalUsd ?? order.quantity * (order.price ?? 0);
  if (notional > safety.maxNotionalUsd) {
    throw new OrderBlockedError(
      `notional $${notional.toFixed(0)} > max $${safety.maxNotionalUsd}`,
    );
  }
  if (order.type === "LIMIT" && order.price === undefined) {
    throw new OrderBlockedError("LIMIT order requires price");
  }
  if (order.quantity <= 0) {
    throw new OrderBlockedError("quantity must be > 0");
  }
  if (order.postOnly && order.type !== "LIMIT") {
    throw new OrderBlockedError("postOnly only valid on LIMIT orders");
  }
}

function baseUrl(cfg: BinanceConfig): string {
  return cfg.testnet ? TESTNET : MAINNET;
}

async function signedPost<T>(
  path: string,
  params: Record<string, string | number>,
  cfg: BinanceConfig,
): Promise<T> {
  if (!cfg.apiKey || !cfg.apiSecret) {
    throw new Error("Binance API key/secret not set");
  }
  const qs = buildSignedQuery(params, cfg);
  const url = `${baseUrl(cfg)}${path}?${qs}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": cfg.apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Binance ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

async function signedDelete<T>(
  path: string,
  params: Record<string, string | number>,
  cfg: BinanceConfig,
): Promise<T> {
  if (!cfg.apiKey || !cfg.apiSecret) {
    throw new Error("Binance API key/secret not set");
  }
  const qs = buildSignedQuery(params, cfg);
  const url = `${baseUrl(cfg)}${path}?${qs}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "X-MBX-APIKEY": cfg.apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Binance ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

function simulatedResponse(order: PlaceOrderInput): OrderResponse {
  return {
    orderId: Math.floor(Math.random() * 1e9),
    clientOrderId: order.clientOrderId ?? `dry-${crypto.randomUUID()}`,
    symbol: order.symbol,
    status: order.type === "MARKET" ? "FILLED" : "NEW",
    type: order.type,
    side: order.side,
    quantity: order.quantity,
    price: order.price ?? 0,
    executedQty: order.type === "MARKET" ? order.quantity : 0,
    avgPrice: order.price ?? 0,
  };
}

export async function placeOrder(
  order: PlaceOrderInput,
  cfg: BinanceConfig = configFromEnv(),
  safety: OrderSafetyConfig = safetyConfigFromEnv(),
): Promise<OrderResponse> {
  validateOrder(order, cfg, safety);
  if (safety.dryRun) {
    return simulatedResponse(order);
  }
  const params: Record<string, string | number> = {
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    quantity: order.quantity,
  };
  if (order.type === "LIMIT") {
    params.price = order.price!;
    params.timeInForce = order.postOnly ? "GTX" : "GTC"; // GTX = post-only
  }
  if (order.reduceOnly) params.reduceOnly = "true";
  if (order.clientOrderId) params.newClientOrderId = order.clientOrderId;

  type Raw = {
    orderId: number;
    clientOrderId: string;
    symbol: string;
    status: OrderResponse["status"];
    type: OrderResponse["type"];
    side: OrderResponse["side"];
    origQty: string;
    price: string;
    executedQty: string;
    avgPrice: string;
  };
  const r = await signedPost<Raw>("/fapi/v1/order", params, cfg);
  return {
    orderId: r.orderId,
    clientOrderId: r.clientOrderId,
    symbol: r.symbol,
    status: r.status,
    type: r.type,
    side: r.side,
    quantity: parseFloat(r.origQty),
    price: parseFloat(r.price),
    executedQty: parseFloat(r.executedQty),
    avgPrice: parseFloat(r.avgPrice),
  };
}

export async function cancelOrder(
  symbol: string,
  orderId: number,
  cfg: BinanceConfig = configFromEnv(),
  safety: OrderSafetyConfig = safetyConfigFromEnv(),
): Promise<{ canceled: true; orderId: number }> {
  if (safety.emergencyHalt) {
    // Allow cancels even on halt — they reduce risk
  }
  if (safety.dryRun) {
    return { canceled: true, orderId };
  }
  await signedDelete("/fapi/v1/order", { symbol, orderId }, cfg);
  return { canceled: true, orderId };
}

export async function cancelAllOpenOrders(
  symbol: string,
  cfg: BinanceConfig = configFromEnv(),
  safety: OrderSafetyConfig = safetyConfigFromEnv(),
): Promise<{ canceledSymbol: string }> {
  if (safety.dryRun) return { canceledSymbol: symbol };
  await signedDelete("/fapi/v1/allOpenOrders", { symbol }, cfg);
  return { canceledSymbol: symbol };
}
