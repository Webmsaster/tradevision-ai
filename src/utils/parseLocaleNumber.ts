/**
 * Shared locale-aware UI input parser.
 *
 * R67-RR3 (Regression Hunt): the previous in-file `parseLocaleNum` helpers in
 * `src/app/calculator/page.tsx` (R14) and `src/components/TradeForm.tsx` (R18)
 * used the naive `raw.replace(",", ".")` strategy which silently corrupted any
 * input containing thousand-separators:
 *
 *   "1,234.56" (US grouping)  → "1.234.56" → parseFloat ⇒ 1.234   (1000× too small)
 *   "1.234,56" (DE grouping)  → "1.234.56" → parseFloat ⇒ 1.234   (1000× too small)
 *
 * For Calculator this silently under-sized risk-amount by 1000×; for TradeForm
 * it produced a 1000× wrong PnL preview AND persisted entryPrice / quantity.
 *
 * Fix: delegate to the audited `parseLocaleNumber` in `csvParser.ts` which has
 * full thousand-separator handling (Phase 46 strict validation). Keep the
 * UI-specific 0-fallback semantics so existing call-sites remain compatible.
 *
 *   parseLocaleNumberUI("")          → 0
 *   parseLocaleNumberUI("abc")       → 0
 *   parseLocaleNumberUI("1,5")       → 1.5      (DE decimal comma)
 *   parseLocaleNumberUI("1.5")       → 1.5
 *   parseLocaleNumberUI("1,234.56")  → 1234.56  (US grouping — was broken)
 *   parseLocaleNumberUI("1.234,56")  → 1234.56  (DE grouping — was broken)
 *   parseLocaleNumberUI("1,234,567") → 1234567  (US grouping — was broken)
 */
import { parseLocaleNumber as parseStrict } from "@/utils/csvParser";

export function parseLocaleNumberUI(raw: string | undefined): number {
  if (!raw) return 0;
  const v = parseStrict(raw);
  return Number.isFinite(v) ? v : 0;
}
