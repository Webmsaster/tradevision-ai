/**
 * One-time backfill helper for trade dates that pre-date the Round 54/56
 * UTC-normalisation work.
 *
 * Re-runs `normalizeDateToUTC` against every `entryDate` / `exitDate` on a
 * Trade list and returns a NEW array with the normalised values. Trades
 * whose dates cannot be parsed are returned unchanged (the caller can
 * decide whether to drop or keep them).
 *
 * IMPORTANT: this is NOT auto-run anywhere. Wire it into a one-off admin
 * action (e.g. a settings-page "Re-normalise dates" button) when migrating
 * a legacy localStorage / Supabase corpus. Running it twice is safe — once
 * a date is already in UTC ISO form, normalizeDateToUTC is idempotent.
 *
 * Usage:
 *   import { backfillTradeDatesToUTC } from "@/utils/dateBackfill";
 *   const fixed = backfillTradeDatesToUTC(trades);
 *   await Promise.all(fixed.map(saveTrade));
 */
import type { Trade } from "@/types/trade";
import { normalizeDateToUTC } from "@/utils/dateNormalize";

export function backfillTradeDatesToUTC(trades: Trade[]): Trade[] {
  return trades.map((t) => {
    const entryISO = normalizeDateToUTC(t.entryDate).iso;
    const exitISO = normalizeDateToUTC(t.exitDate).iso;
    // Preserve the original value if normalisation fails so we never lose
    // data — caller is expected to log + decide.
    return {
      ...t,
      entryDate: entryISO ?? t.entryDate,
      exitDate: exitISO ?? t.exitDate,
    };
  });
}
