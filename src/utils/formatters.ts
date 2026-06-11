/**
 * Shared formatting utilities used across dashboard, report, charts, and tables.
 */
import { MONTHS_SHORT } from "@/lib/constants";

/** Format a number as $1,234.56 with sign handling. */
export function formatCurrency(n: number): string {
  const isNegative = n < 0;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return isNegative ? `-$${formatted}` : `$${formatted}`;
}

/** Format a number that might be Infinity or NaN as a safe string. */
export function formatFinite(
  value: number | null | undefined,
  decimals = 2,
): string {
  if (value === undefined || value === null) return "N/A";
  if (!Number.isFinite(value)) return "N/A";
  return value.toFixed(decimals);
}

/** Format a price as "1234.56" (no dollar sign, for tables). */
export function formatPrice(value: number): string {
  return value.toFixed(2);
}

/** Format PnL with sign: "+123.45" or "-67.89". */
export function formatPnl(value: number): string {
  // 2026-05-15 (Audit-Round-6 / Agent #6 HOCH): negative-zero leak. The
  // old code returned `"-0.00"` for tiny negatives like -0.001 because
  // `.toFixed(2)` rounds toward zero but preserves the sign. Traders saw
  // "-$0.00 PnL" — confusing and factually wrong. Round to two decimals
  // FIRST, then derive the sign from the rounded value.
  const rounded = Number(value.toFixed(2));
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(2)}`;
}

/** Format a percentage with sign: "+12.3%" or "-4.5%". */
export function formatPercent(value: number, decimals = 1): string {
  // 2026-05-15 (Audit-Round-6 / Agent #6 HOCH): same negative-zero fix as
  // formatPnl above. Round first, then sign.
  const rounded = Number(value.toFixed(decimals));
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(decimals)}%`;
}

/**
 * Date-formatter convention (Round 56 fix #5):
 *
 * Trade dates are stored as UTC ISO-8601 (with `Z`). The default render
 * here uses LOCAL-TZ getters, which means the dashboard table reads the
 * user's wall-clock — convenient day-to-day, but inconsistent with
 * aiAnalysis/WeeklySummary/DayOfWeekHeatmap (all UTC).
 *
 * Pass `{ displayInUTC: true }` to bucket the displayed value in UTC and
 * match the aggregation surfaces. Default behaviour is preserved so
 * existing screens (TradeTable, TradeDetailModal) do not visibly shift.
 *
 * If you are adding a new view that needs to reconcile with stats, prefer
 * `displayInUTC: true`.
 */
export interface DateFormatOptions {
  displayInUTC?: boolean;
}

/** Format a date for table display: "Jan 01, 14:30" (short, no year).
 *
 * R67-Final (R15-A3 perf): also accepts a pre-parsed epoch-ms `number`
 * so callers with a cached `trade.exitMs` skip the `new Date(string)`
 * parse on every render. Falls back to string-parse for legacy callers.
 */
export function formatTradeDate(
  date: Date | string | number,
  options: DateFormatOptions = {},
): string {
  const d =
    typeof date === "string"
      ? new Date(date)
      : typeof date === "number"
        ? new Date(date)
        : date;
  // 2026-05-16 Round 8 fix: guard against invalid Date — previously
  // `MONTHS_SHORT[NaN]` yielded "undefined NaN, NaN:NaN". formatShortDate
  // had this guard; mirror it here and in formatDetailDate.
  if (isNaN(d.getTime())) return typeof date === "string" ? date : "";
  const months = MONTHS_SHORT;
  const utc = options.displayInUTC === true;
  const month = months[utc ? d.getUTCMonth() : d.getMonth()];
  const day = String(utc ? d.getUTCDate() : d.getDate()).padStart(2, "0");
  const hours = String(utc ? d.getUTCHours() : d.getHours()).padStart(2, "0");
  const minutes = String(utc ? d.getUTCMinutes() : d.getMinutes()).padStart(
    2,
    "0",
  );
  return `${month} ${day}, ${hours}:${minutes}`;
}

/** Format a date for detail view: "Jan 01, 2024 14:30" (with year). */
export function formatDetailDate(
  dateStr: string,
  options: DateFormatOptions = {},
): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const months = MONTHS_SHORT;
  const utc = options.displayInUTC === true;
  const month = months[utc ? d.getUTCMonth() : d.getMonth()];
  const day = String(utc ? d.getUTCDate() : d.getDate()).padStart(2, "0");
  const year = utc ? d.getUTCFullYear() : d.getFullYear();
  const hours = String(utc ? d.getUTCHours() : d.getHours()).padStart(2, "0");
  const minutes = String(utc ? d.getUTCMinutes() : d.getMinutes()).padStart(
    2,
    "0",
  );
  return `${month} ${day}, ${year} ${hours}:${minutes}`;
}

/** Format a date for short display: "Jan 01, 2024" (date only). */
export function formatShortDate(
  dateStr: string,
  options: DateFormatOptions = {},
): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const months = MONTHS_SHORT;
  const utc = options.displayInUTC === true;
  const month = months[utc ? d.getUTCMonth() : d.getMonth()];
  const day = String(utc ? d.getUTCDate() : d.getDate()).padStart(2, "0");
  const year = utc ? d.getUTCFullYear() : d.getFullYear();
  return `${month} ${day}, ${year}`;
}
