/**
 * Hyperliquid Perp Funding — DEX-vs-CEX cohort divergence signal.
 *
 * Why: Binance/Bybit retail is "normie retail" — trades via fiat on-ramp,
 * uses leverage but is the modal crypto-trader. Hyperliquid retail is
 * "degen cohort" — self-custody, on-chain, higher average risk tolerance,
 * heavy meme + perp culture. When the two cohorts POSITION DIFFERENTLY,
 * the HL-Binance funding spread tells us something.
 *
 * Examples where divergence matters:
 *   - CEX funding ≈ 0 but HL funding DEEPLY negative → DEX crowd is
 *     shorting into a market that CEX is neutral on. Often appears at
 *     local bottoms (DEX shorts got punished → squeeze up).
 *   - CEX funding HOT but HL funding neutral/negative → CEX retail
 *     chasing longs, DEX crowd already hedged out. Often tops.
 *
 * API (public, no auth):
 *   POST https://api.hyperliquid.xyz/info
 *   body: {"type":"metaAndAssetCtxs"}
 *
 * Response: [{ universe: [{name,...}] }, [{funding, openInterest, premium,
 * markPx, oraclePx, ...}]] — two parallel arrays; universe[i] meta for
 * ctxs[i]. `funding` is HOURLY (unlike Binance 8h cadence).
 *
 * We convert HL funding to 8h equivalent (× 8) to compare directly.
 */

const HL_URL = "https://api.hyperliquid.xyz/info";

export interface HlAssetSnapshot {
  symbol: "BTC" | "ETH" | "SOL";
  funding1h: number; // raw hourly from HL
  funding8hEq: number; // × 8 for CEX comparison
  openInterest: number; // in base units (e.g. BTC count)
  premium: number; // (markPx - oraclePx) / oraclePx
  markPx: number;
  oraclePx: number;
}

export interface HlFundingSnapshot {
  capturedAt: number;
  btc?: HlAssetSnapshot;
  eth?: HlAssetSnapshot;
  sol?: HlAssetSnapshot;
}

interface HlUniverseEntry {
  name: string;
  szDecimals: number;
  isDelisted?: boolean;
}

interface HlAssetCtx {
  funding: string;
  openInterest: string;
  premium: string;
  markPx: string;
  oraclePx: string;
}

export async function fetchHyperliquidFunding(): Promise<HlFundingSnapshot> {
  const res = await fetch(HL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!res.ok) throw new Error(`Hyperliquid fetch failed: ${res.status}`);
  const json = (await res.json()) as [
    { universe: HlUniverseEntry[] },
    HlAssetCtx[],
  ];
  const universe = json[0]?.universe ?? [];
  const ctxs = json[1] ?? [];

  const wanted: Record<string, keyof HlFundingSnapshot> = {
    BTC: "btc",
    ETH: "eth",
    SOL: "sol",
  };
  const snap: HlFundingSnapshot = { capturedAt: Date.now() };
  for (let i = 0; i < universe.length; i++) {
    const u = universe[i];
    if (u!.isDelisted) continue;
    const key = wanted[u!.name];
    if (!key) continue;
    const c = ctxs[i];
    if (!c) continue;
    const f1h = parseFloat(c.funding);
    const sym = u!.name as HlAssetSnapshot["symbol"];
    const asset: HlAssetSnapshot = {
      symbol: sym,
      funding1h: f1h,
      funding8hEq: f1h * 8,
      openInterest: parseFloat(c.openInterest),
      premium: parseFloat(c.premium),
      markPx: parseFloat(c.markPx),
      oraclePx: parseFloat(c.oraclePx),
    };
    (snap[key] as HlAssetSnapshot | undefined) = asset;
  }
  return snap;
}

export interface CexHlSpread {
  symbol: "BTC" | "ETH" | "SOL";
  cexFunding8h: number;
  hlFunding8hEq: number;
  spread: number; // hl - cex (bps-of-notional per 8h)
  /** Magnitude bucket for UI/logic gating */
  magnitude: "extreme" | "strong" | "moderate" | "noise";
  /** Which side is more bearish: `hl-more-bearish` or `cex-more-bearish` or `aligned` */
  divergence: "hl-more-bearish" | "cex-more-bearish" | "aligned";
  interpretation: string;
}

/**
 * Compare HL 8h-equivalent funding vs CEX (Binance) most-recent 8h funding.
 * CEX funding should be passed in as its raw 8h-rate (e.g. 0.0001 = 1bp).
 * Returns a per-symbol spread snapshot + interpretation.
 */
export function compareCexHl(
  hl: HlFundingSnapshot,
  cexFundingBySym: Record<string, number>,
): CexHlSpread[] {
  const out: CexHlSpread[] = [];
  const map: { key: "btc" | "eth" | "sol"; sym: "BTC" | "ETH" | "SOL" }[] = [
    { key: "btc", sym: "BTC" },
    { key: "eth", sym: "ETH" },
    { key: "sol", sym: "SOL" },
  ];
  for (const { key, sym } of map) {
    const h = hl[key];
    if (!h) continue;
    const cex = cexFundingBySym[sym + "USDT"] ?? cexFundingBySym[sym] ?? 0;
    const spread = h.funding8hEq - cex;
    const abs = Math.abs(spread);
    const magnitude: CexHlSpread["magnitude"] =
      abs > 0.001
        ? "extreme"
        : abs > 0.0005
          ? "strong"
          : abs > 0.0001
            ? "moderate"
            : "noise";
    const divergence: CexHlSpread["divergence"] =
      abs < 0.00005
        ? "aligned"
        : spread < 0
          ? "hl-more-bearish"
          : "cex-more-bearish";
    let interpretation: string;
    if (divergence === "aligned") {
      interpretation = `HL and CEX funding aligned (Δ=${(spread * 10000).toFixed(2)}bp) — cohorts agree, no signal`;
    } else if (divergence === "hl-more-bearish") {
      interpretation =
        magnitude === "extreme"
          ? `EXTREME: HL ${(h.funding8hEq * 100).toFixed(3)}% vs CEX ${(cex * 100).toFixed(3)}% — DEX cohort deeply shorting, CEX neutral/long`
          : `HL funding more bearish by ${(abs * 10000).toFixed(1)}bp/8h — DEX shorts stacked vs CEX; watch for squeeze-up`;
    } else {
      interpretation =
        magnitude === "extreme"
          ? `EXTREME: CEX ${(cex * 100).toFixed(3)}% vs HL ${(h.funding8hEq * 100).toFixed(3)}% — CEX retail chasing longs, DEX cohort already hedged — watch for top`
          : `CEX funding more bullish by ${(abs * 10000).toFixed(1)}bp/8h — CEX retail long-crowded vs DEX`;
    }
    out.push({
      symbol: sym,
      cexFunding8h: cex,
      hlFunding8hEq: h.funding8hEq,
      spread,
      magnitude,
      divergence,
      interpretation,
    });
  }
  return out;
}
