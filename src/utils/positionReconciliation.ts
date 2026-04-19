/**
 * Position Reconciliation — compare paper-state open positions vs Binance
 * live positions. Detects:
 *   - Position closed on exchange but still open in paper (fill we missed)
 *   - Position open in paper but no longer on exchange (external close)
 *   - Size mismatch (partial fill)
 *   - Direction mismatch (should never happen, flag hard)
 *
 * Called from the paper-trade tick when BINANCE_LIVE=1 so the paper log
 * mirrors real execution. Diffs are logged; callers decide how to act.
 */
import type { PaperPosition } from "@/utils/paperTradeLogger";
import type { OpenPosition } from "@/utils/binanceAccount";

export interface ReconciliationDiff {
  paperOnly: PaperPosition[]; // open in paper, not on exchange
  exchangeOnly: OpenPosition[]; // on exchange, not in paper
  directionMismatch: Array<{ paper: PaperPosition; exchange: OpenPosition }>;
  sizeMismatch: Array<{
    paper: PaperPosition;
    exchange: OpenPosition;
    paperQty: number;
    exchangeQty: number;
  }>;
  matched: Array<{ paper: PaperPosition; exchange: OpenPosition }>;
}

/**
 * Reconciles paper open-positions against a Binance account snapshot.
 *
 * @param paperCapital  Needed to convert paper notional→qty estimate when
 *                      comparing to exchange positionAmt. If you can provide
 *                      actual notionals per-position via `notionalsById`,
 *                      pass those instead for exact size-diff.
 */
export function reconcile(args: {
  paperOpen: PaperPosition[];
  exchangePositions: OpenPosition[];
  notionalsById?: Record<string, number>;
}): ReconciliationDiff {
  const paper = [...args.paperOpen];
  const exchange = [...args.exchangePositions];

  const matched: Array<{ paper: PaperPosition; exchange: OpenPosition }> = [];
  const directionMismatch: ReconciliationDiff["directionMismatch"] = [];
  const sizeMismatch: ReconciliationDiff["sizeMismatch"] = [];

  // Match by symbol (1:1 per symbol — we enforce dup-symbol-block in risk gate)
  const paperBySym = new Map<string, PaperPosition>();
  for (const p of paper) paperBySym.set(p.symbol, p);
  const exchangeBySym = new Map<string, OpenPosition>();
  for (const e of exchange) exchangeBySym.set(e.symbol, e);

  for (const [sym, p] of paperBySym) {
    const e = exchangeBySym.get(sym);
    if (!e) continue;
    // Direction check: paper=long → exchange positionAmt > 0
    const exchangeDir = e.positionAmt > 0 ? "long" : "short";
    if (exchangeDir !== p.direction) {
      directionMismatch.push({ paper: p, exchange: e });
      continue;
    }
    const paperQty = args.notionalsById
      ? (args.notionalsById[p.id] ?? 0) / p.entry
      : Math.abs(e.positionAmt); // fallback: treat as matched
    const exchangeQty = Math.abs(e.positionAmt);
    const pct =
      exchangeQty > 0 ? Math.abs(paperQty - exchangeQty) / exchangeQty : 0;
    // Tolerate ±5% (rounding, partial fills in progress)
    if (pct > 0.05 && args.notionalsById) {
      sizeMismatch.push({
        paper: p,
        exchange: e,
        paperQty,
        exchangeQty,
      });
    } else {
      matched.push({ paper: p, exchange: e });
    }
  }

  const paperOnly = paper.filter((p) => !exchangeBySym.has(p.symbol));
  const exchangeOnly = exchange.filter(
    (e) => !paperBySym.has(e.symbol) && Math.abs(e.positionAmt) > 0,
  );

  return { paperOnly, exchangeOnly, directionMismatch, sizeMismatch, matched };
}

export function formatDiffSummary(diff: ReconciliationDiff): string {
  const lines: string[] = [];
  lines.push(`  matched: ${diff.matched.length}`);
  if (diff.paperOnly.length > 0) {
    lines.push(
      `  ⚠ paperOnly (${diff.paperOnly.length}): ${diff.paperOnly.map((p) => p.symbol).join(", ")} — close may have missed paper-log`,
    );
  }
  if (diff.exchangeOnly.length > 0) {
    lines.push(
      `  ⚠ exchangeOnly (${diff.exchangeOnly.length}): ${diff.exchangeOnly.map((e) => e.symbol).join(", ")} — open on exchange but not tracked`,
    );
  }
  if (diff.directionMismatch.length > 0) {
    lines.push(
      `  ✗ DIRECTION MISMATCH (${diff.directionMismatch.length}): ${diff.directionMismatch.map((m) => m.paper.symbol).join(", ")} — HARD FAIL`,
    );
  }
  if (diff.sizeMismatch.length > 0) {
    lines.push(
      `  ⚡ size mismatch (${diff.sizeMismatch.length}): ${diff.sizeMismatch.map((m) => `${m.paper.symbol} paper=${m.paperQty.toFixed(3)} exch=${m.exchangeQty.toFixed(3)}`).join(", ")}`,
    );
  }
  return lines.join("\n");
}
