/**
 * Shared formatting utilities used across dashboard, report, charts, and tables.
 */

/** Format a number as $1,234.56 with sign handling. */
export function formatCurrency(n: number): string {
  const isNegative = n < 0;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return isNegative ? `-$${formatted}` : `$${formatted}`;
}

/** Format a number that might be Infinity or NaN as a safe string. */
export function formatFinite(value: number | undefined, decimals = 2): string {
  if (value === undefined || value === null) return 'N/A';
  if (!Number.isFinite(value)) return 'N/A';
  return value.toFixed(decimals);
}
