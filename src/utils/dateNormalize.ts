/**
 * Date normalisation helpers used by the CSV import path and elsewhere.
 *
 * Round 54: all incoming date strings should be normalised to a UTC
 * ISO-8601 string with a `Z` suffix before being stored. Local-time-only
 * strings (e.g. "2026-04-15 14:30") are coerced to UTC explicitly and the
 * caller is told it happened so the UI can surface a warning.
 *
 * Round 57: extended to handle EU (`15/04/2026`, `15.04.2026`,
 * `15-04-2026`), US (`04/15/2026`) and MT4 (`2026.04.15 14:30`) date
 * formats. Previously these all fell through to `new Date(trimmed)` which
 * is engine-dependent and silently produced `Invalid Date` on most
 * runtimes — entire CSV imports were dropped without any warning.
 */

export type DateNormalizeWarning =
  | "naive-iso-assumed-utc"
  | "date-only-assumed-utc-midnight"
  | "ambiguous-slash-date-assumed-dmy"
  | "mt4-date-assumed-utc"
  | "eu-date-assumed-utc"
  | "us-date-assumed-utc";

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

// Round 57 fix #1: explicit format regexes BEFORE the new Date() fallback.
// MT4 / MetaTrader 4 export format: yyyy.mm.dd[ HH:MM[:SS]]
const MT4_REGEX =
  /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/;
// Slash-separated, ambiguous between dd/mm/yyyy (EU) and mm/dd/yyyy (US).
const SLASH_REGEX =
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/;
// Dot-separated EU: dd.mm.yyyy[ HH:MM[:SS]]
const EU_DOT_REGEX =
  /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/;
// Dash-separated EU: dd-mm-yyyy[ HH:MM[:SS]] (note: yyyy-mm-dd is handled
// by NAIVE_DATETIME_REGEX above, so the year-trailing form is unambiguous.)
const EU_DASH_REGEX =
  /^(\d{1,2})-(\d{1,2})-(\d{4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/;

function inRange(
  year: number,
  month: number,
  day: number,
  hour: number,
  min: number,
  sec: number,
): boolean {
  if (year < 1900 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour < 0 || hour > 23) return false;
  if (min < 0 || min > 59) return false;
  if (sec < 0 || sec > 59) return false;
  return true;
}

function buildUTC(
  year: number,
  month: number,
  day: number,
  hour: number,
  min: number,
  sec: number,
): string | null {
  if (!inRange(year, month, day, hour, min, sec)) return null;
  // Date.UTC clamps invalid combinations silently (Feb 30 → Mar 2). Verify
  // round-trip equality so we reject Feb 30 etc.
  const ms = Date.UTC(year, month - 1, day, hour, min, sec);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d.toISOString();
}

/**
 * Normalise a raw date string to a UTC ISO-8601 string.
 *
 *   "2026-04-15T14:30:00Z"   → { iso: "2026-04-15T14:30:00.000Z" }                       (passthrough)
 *   "2026-04-15T14:30:00"    → { iso: "...Z", warning: "naive-iso-assumed-utc" }
 *   "2026-04-15 14:30"       → { iso: "...Z", warning: "naive-iso-assumed-utc" }
 *   "2026-04-15"             → { iso: "...T00:00:00.000Z", warning: "date-only-assumed-utc-midnight" }
 *   "2026.04.15 14:30"       → { iso: "...Z", warning: "mt4-date-assumed-utc" }
 *   "15.04.2026 14:30"       → { iso: "...Z", warning: "eu-date-assumed-utc" }
 *   "15-04-2026"             → { iso: "...Z", warning: "eu-date-assumed-utc" }
 *   "13/04/2026"             → { iso: "...Z", warning: "eu-date-assumed-utc" }   (day>12 → must be dmy)
 *   "04/13/2026"             → { iso: "...Z", warning: "us-date-assumed-utc" }   (second>12 → must be mdy)
 *   "04/05/2026"             → { iso: "...Z", warning: "ambiguous-slash-date-assumed-dmy" }
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

  // Round 57: TZ marker check should not fire for dd-mm-yyyy strings —
  // "15-04-2026" ends in `-2026` which superficially looks like a `±HHMM`
  // offset. Require a `:` (time separator) anywhere in the string to count
  // it as a TZ-marked datetime.
  if (HAS_TZ_REGEX.test(trimmed) && trimmed.includes(":")) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return { iso: null };
    return { iso: d.toISOString() };
  }

  // -- Round 57 fix #1 / Round 58 (DRY): explicit handling for MT4 / EU / US.
  // Shared logic across MT4 (ymd) and EU dot/dash (dmy) — the slash form
  // needs ambiguity resolution and is handled separately below.
  const fixedFormats: Array<{
    re: RegExp;
    order: "ymd" | "dmy";
    warning: DateNormalizeWarning;
  }> = [
    { re: MT4_REGEX, order: "ymd", warning: "mt4-date-assumed-utc" },
    { re: EU_DOT_REGEX, order: "dmy", warning: "eu-date-assumed-utc" },
    { re: EU_DASH_REGEX, order: "dmy", warning: "eu-date-assumed-utc" },
  ];
  for (const { re, order, warning } of fixedFormats) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const [, p1, p2, p3, h, mi, s] = m;
    // ymd: (y, m, d) — MT4. dmy: (d, m, y) — EU. Month is always p2.
    const year = Number(order === "ymd" ? p1 : p3);
    const month = Number(p2);
    const day = Number(order === "ymd" ? p3 : p1);
    const iso = buildUTC(
      year,
      month,
      day,
      h ? Number(h) : 0,
      mi ? Number(mi) : 0,
      s ? Number(s) : 0,
    );
    if (!iso) return { iso: null };
    return { iso, warning };
  }

  // Slash-separated: ambiguous dd/mm/yyyy vs mm/dd/yyyy.
  // Heuristic:
  //   - first part > 12 → must be dmy (EU)
  //   - second part > 12 → must be mdy (US)
  //   - otherwise default to dmy (EU) and emit ambiguous warning.
  const slash = SLASH_REGEX.exec(trimmed);
  if (slash) {
    const [, a, b, y, h, mi, s] = slash;
    const aN = Number(a);
    const bN = Number(b);
    let day: number;
    let month: number;
    let warning: DateNormalizeWarning;
    if (aN > 12 && bN <= 12) {
      day = aN;
      month = bN;
      warning = "eu-date-assumed-utc";
    } else if (bN > 12 && aN <= 12) {
      month = aN;
      day = bN;
      warning = "us-date-assumed-utc";
    } else if (aN > 12 && bN > 12) {
      // Both > 12 — neither dmy nor mdy is a valid date. Reject.
      return { iso: null };
    } else {
      // Both ≤ 12 → genuinely ambiguous. Default to dmy (EU) and warn.
      day = aN;
      month = bN;
      warning = "ambiguous-slash-date-assumed-dmy";
    }
    const iso = buildUTC(
      Number(y),
      month,
      day,
      h ? Number(h) : 0,
      mi ? Number(mi) : 0,
      s ? Number(s) : 0,
    );
    if (!iso) return { iso: null };
    return { iso, warning };
  }

  // Last-resort fallback: only accept strings that have an EXPLICIT TZ
  // marker. `new Date("Apr 15, 2026 14:30")` parses as host-local, then
  // `.toISOString()` shifts it — silently host-TZ-dependent. Round 60
  // audit fix: reject if no TZ marker so output stays deterministic.
  if (!HAS_TZ_REGEX.test(trimmed)) return { iso: null };
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return { iso: null };
  return { iso: d.toISOString() };
}
