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
export function formatFinite(value: number | undefined, decimals = 2): string {
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
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

/** Format a percentage with sign: "+12.3%" or "-4.5%". */
export function formatPercent(value: number, decimals = 1): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

/** Format a date for table display: "Jan 01, 14:30" (short, no year). */
export function formatTradeDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const months = MONTHS_SHORT;
  const month = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${month} ${day}, ${hours}:${minutes}`;
}

/** Format a date for detail view: "Jan 01, 2024 14:30" (with year). */
export function formatDetailDate(dateStr: string): string {
  const d = new Date(dateStr);
  const months = MONTHS_SHORT;
  const month = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, "0");
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${month} ${day}, ${year} ${hours}:${minutes}`;
}

/** Format a date for short display: "Jan 01, 2024" (date only). */
export function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const months = MONTHS_SHORT;
  const month = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, "0");
  const year = d.getFullYear();
  return `${month} ${day}, ${year}`;
}
