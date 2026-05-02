/**
 * Deribit 25-Delta Risk-Reversal Skew (direction filter).
 *
 * Research: Deribit Insights (2023/2024) "Options Edge in Volatility
 * Regimes" — institutional option positioning shows in the 25-delta
 * call-vs-put IV skew. When 25d-call IV > 25d-put IV by notable margin,
 * institutions are bidding for upside = bullish bias. Inverse = bearish.
 *
 * We approximate 25-delta by taking the ATM+5% call and ATM-5% put
 * (cheap-and-dirty but good enough for a filter). Real 25d requires
 * full option-chain delta calculation which needs more data.
 *
 * Endpoint (free public):
 *   https://www.deribit.com/api/v2/public/get_book_summary_by_currency?
 *     currency=BTC&kind=option
 *
 * Returns array of option books. Each has markIv, strike, expiration_ts,
 * instrument_name. We filter:
 *   - nearest expiry (shortest days-to-expiry > 1 day)
 *   - BTC-... -C (call) and BTC-... -P (put)
 *   - strikes nearest ATM ± ~5%
 */

import type { PremiumSnapshot } from "@/utils/coinbasePremium";

const DERIBIT_URL =
  "https://www.deribit.com/api/v2/public/get_book_summary_by_currency";

export interface DeribitSkewSnapshot {
  capturedAt: number;
  expiry: string; // e.g. "26APR26"
  spotEstimate: number;
  call25dIv: number | null;
  put25dIv: number | null;
  skewPct: number; // (call - put) as percentage-point, e.g. 0.02 = 2pp
  bias: "bullish" | "bearish" | "neutral";
  magnitude: "extreme" | "strong" | "moderate" | "noise";
  interpretation: string;
}

interface RawOption {
  instrument_name: string;
  mark_price: number;
  underlying_price: number;
  mark_iv: number;
}

function parseInstrument(name: string): {
  expiry: string;
  strike: number;
  type: "C" | "P";
} | null {
  // BTC-26APR26-70000-C
  const parts = name.split("-");
  if (parts.length !== 4) return null;
  const [, exp, strike, type] = parts;
  if (type !== "C" && type !== "P") return null;
  const s = parseFloat(strike);
  if (!isFinite(s)) return null;
  return { expiry: exp, strike: s, type };
}

export async function fetchDeribitSkew(): Promise<DeribitSkewSnapshot> {
  const url = new URL(DERIBIT_URL);
  url.searchParams.set("currency", "BTC");
  url.searchParams.set("kind", "option");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Deribit fetch failed: ${res.status}`);
  const json = (await res.json()) as { result: RawOption[] };
  const rows = json.result ?? [];
  if (rows.length === 0) {
    throw new Error("Deribit returned no option books");
  }

  // Group by expiry and take the shortest active expiry (>1 day away)
  const byExpiry = new Map<string, RawOption[]>();
  for (const r of rows) {
    const parsed = parseInstrument(r.instrument_name);
    if (!parsed) continue;
    const key = parsed.expiry;
    const arr = byExpiry.get(key) ?? [];
    arr.push(r);
    byExpiry.set(key, arr);
  }

  // Choose the closest expiry by decoding date (DDMMMYY)
  const now = Date.now();
  const monthMap: Record<string, number> = {
    JAN: 0,
    FEB: 1,
    MAR: 2,
    APR: 3,
    MAY: 4,
    JUN: 5,
    JUL: 6,
    AUG: 7,
    SEP: 8,
    OCT: 9,
    NOV: 10,
    DEC: 11,
  };
  function expiryMs(exp: string): number {
    const m = exp.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!m) return 0;
    const day = parseInt(m[1]!);
    const mon = monthMap[m[2]] ?? 0;
    const year = 2000 + parseInt(m[3]!);
    return Date.UTC(year, mon, day, 8);
  }

  const expiryCandidates = [...byExpiry.entries()]
    .map(([exp, list]) => ({ exp, list, ms: expiryMs(exp) }))
    .filter((e) => e.ms > now + 24 * 60 * 60 * 1000)
    .sort((a, b) => a.ms - b.ms);

  if (expiryCandidates.length === 0) {
    throw new Error("No Deribit expiry >1 day away");
  }
  const chosen = expiryCandidates[0];
  const list = chosen.list;

  // Underlying from first row
  const spot = list[0]?.underlying_price ?? 0;

  // Find strike closest to spot * 1.05 (call 25d proxy) and spot * 0.95 (put 25d proxy)
  const callTarget = spot * 1.05;
  const putTarget = spot * 0.95;
  let bestCall: RawOption | null = null;
  let bestPut: RawOption | null = null;
  let bestCallDist = Infinity;
  let bestPutDist = Infinity;
  for (const r of list) {
    const parsed = parseInstrument(r.instrument_name);
    if (!parsed) continue;
    if (parsed.type === "C") {
      const d = Math.abs(parsed.strike - callTarget);
      if (d < bestCallDist && r.mark_iv > 0) {
        bestCall = r;
        bestCallDist = d;
      }
    } else {
      const d = Math.abs(parsed.strike - putTarget);
      if (d < bestPutDist && r.mark_iv > 0) {
        bestPut = r;
        bestPutDist = d;
      }
    }
  }

  const callIv = bestCall?.mark_iv ?? null;
  const putIv = bestPut?.mark_iv ?? null;
  const skewPct =
    callIv !== null && putIv !== null ? (callIv - putIv) / 100 : 0;
  const abs = Math.abs(skewPct);
  const magnitude: DeribitSkewSnapshot["magnitude"] =
    abs > 0.05
      ? "extreme"
      : abs > 0.03
        ? "strong"
        : abs > 0.01
          ? "moderate"
          : "noise";
  const bias: DeribitSkewSnapshot["bias"] =
    abs < 0.01 ? "neutral" : skewPct > 0 ? "bullish" : "bearish";

  let interpretation: string;
  if (bias === "neutral") {
    interpretation = "25d call-put skew within 1pp — no positioning tilt";
  } else if (bias === "bullish") {
    interpretation =
      magnitude === "extreme"
        ? "EXTREME call-bid skew (>5pp) — institutions heavily long-gamma"
        : magnitude === "strong"
          ? "Strong call-bid skew — option desks positioning bullish"
          : "Mild bullish skew";
  } else {
    interpretation =
      magnitude === "extreme"
        ? "EXTREME put-bid skew (>5pp) — fear regime, institutions hedging down"
        : magnitude === "strong"
          ? "Strong put-bid skew — option desks positioning defensive"
          : "Mild bearish skew";
  }

  return {
    capturedAt: Date.now(),
    expiry: chosen.exp,
    spotEstimate: spot,
    call25dIv: callIv,
    put25dIv: putIv,
    skewPct,
    bias,
    magnitude,
    interpretation,
  };
}

// Intentional unused export placeholder so future signal fusion knows the
// common snapshot shape; mirrors PremiumSnapshot usage pattern.
void ({} as PremiumSnapshot);
