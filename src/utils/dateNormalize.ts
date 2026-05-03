/**
 * Date normalisation helpers used by the CSV import path and elsewhere.
 *
 * Round 54: all incoming date strings should be normalised to a UTC
 * ISO-8601 string with a `Z` suffix before being stored. Local-time-only
 * strings (e.g. "2026-04-15 14:30") are coerced to UTC explicitly and the
 * caller is told it happened so the UI can surface a warning.
 */

export type DateNormalizeWarning =
  | "naive-iso-assumed-utc"
  | "date-only-assumed-utc-midnight";

export interface DateNormalizeResult {
  iso: string | null; // null when the input is unparseable
  warning?: DateNormalizeWarning;
}

// "2026-04-15T14:30:00Z" / "...+02:00" / "...+0200" / "...+02"
const HAS_TZ_REGEX = /(Z|[+-]\d{2}(:?\d{2})?)$/;
// "YYYY-MM-DD" only
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// "YYYY-MM-DD[T| ]HH:MM(:SS(.fff)?)?" without TZ marker
const NAIVE_DATETIME_REGEX =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * Normalise a raw date string to a UTC ISO-8601 string.
 *
 *   "2026-04-15T14:30:00Z"   → { iso: "2026-04-15T14:30:00.000Z" }                       (passthrough)
 *   "2026-04-15T14:30:00"    → { iso: "...Z", warning: "naive-iso-assumed-utc" }
 *   "2026-04-15 14:30"       → { iso: "...Z", warning: "naive-iso-assumed-utc" }
 *   "2026-04-15"             → { iso: "...T00:00:00.000Z", warning: "date-only-assumed-utc-midnight" }
 *   "garbage"                → { iso: null }
 */
export function normalizeDateToUTC(raw: unknown): DateNormalizeResult {
  if (typeof raw !== "string") return { iso: null };
  const trimmed = raw.trim();
  if (!trimmed) return { iso: null };

  // Date-only → assume UTC midnight, warn caller.
  if (DATE_ONLY_REGEX.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return { iso: null };
    return {
      iso: d.toISOString(),
      warning: "date-only-assumed-utc-midnight",
    };
  }

  // Naive datetime ("YYYY-MM-DDTHH:MM" or "YYYY-MM-DD HH:MM[:SS[.fff]]") → coerce to UTC.
  const naive = NAIVE_DATETIME_REGEX.exec(trimmed);
  if (naive) {
    const [, datePart, timePart] = naive;
    // Pad seconds if missing so JS parses uniformly.
    const fullTime =
      timePart!.length === 5 ? `${timePart}:00` : (timePart as string);
    const d = new Date(`${datePart}T${fullTime}Z`);
    if (Number.isNaN(d.getTime())) return { iso: null };
    return { iso: d.toISOString(), warning: "naive-iso-assumed-utc" };
  }

  // Has explicit TZ marker (Z or ±HH:MM) — let JS parse natively, then re-emit as UTC.
  if (HAS_TZ_REGEX.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return { iso: null };
    return { iso: d.toISOString() };
  }

  // Last-resort fallback: let Date attempt to parse it (handles e.g.
  // "Mon, 15 Apr 2026 14:30:00 GMT"). Warn as naive — caller should treat
  // result as UTC.
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return { iso: null };
  return { iso: d.toISOString(), warning: "naive-iso-assumed-utc" };
}
