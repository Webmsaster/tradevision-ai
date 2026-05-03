/**
 * BTC-ETF Flow Follow-Through signal (Mazur & Polyzos 2024, SSRN 5452994).
 *
 * Rule: Spot-BTC-ETF aggregate US net flows (IBIT + FBTC + ARKB etc.) for
 * two consecutive days:
 *   - Both > +500M USD  → long BTC at Day T+1 open, exit Day T+2 close
 *   - Both < -500M USD  → short BTC at Day T+1 open, exit Day T+2 close
 *
 * Since browser-side Farside scraping is blocked by CORS, this module
 * takes manual user input (paste from farside.co.uk) and computes the
 * signal. Simple 2-day rolling window.
 */

const STORAGE_KEY = "tradevision-etf-flow-history-v1";

export interface EtfFlowEntry {
  date: string; // YYYY-MM-DD
  netFlowUsd: number;
}

export interface EtfFlowSignal {
  latestDate: string;
  prevDate: string;
  latestFlow: number;
  prevFlow: number;
  signal: "long" | "short" | "flat";
  reason: string;
  action: string;
}

export function loadEtfFlowHistory(): EtfFlowEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as EtfFlowEntry[];
  } catch {
    return [];
  }
}

export function saveEtfFlowHistory(entries: EtfFlowEntry[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function addEtfFlowEntry(
  date: string,
  netFlowUsd: number,
): EtfFlowEntry[] {
  const all = loadEtfFlowHistory();
  const existing = all.findIndex((e) => e.date === date);
  if (existing >= 0) {
    all[existing]!.netFlowUsd = netFlowUsd;
  } else {
    all.push({ date, netFlowUsd });
  }
  all.sort((a, b) => (a.date < b.date ? -1 : 1));
  saveEtfFlowHistory(all);
  return all;
}

export function computeEtfFlowSignal(
  entries: EtfFlowEntry[],
  thresholdUsd = 500_000_000,
): EtfFlowSignal | null {
  if (entries.length < 2) return null;
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1));
  const latest = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];

  let signal: EtfFlowSignal["signal"] = "flat";
  let reason: string;
  let action: string;

  if (latest!.netFlowUsd > thresholdUsd && prev!.netFlowUsd > thresholdUsd) {
    signal = "long";
    reason = `2 consecutive days > +$${(thresholdUsd / 1e6).toFixed(0)}M (${(prev!.netFlowUsd / 1e6).toFixed(0)}M → ${(latest!.netFlowUsd / 1e6).toFixed(0)}M)`;
    action = `Long BTC at next-day open, exit 24h later. Target +1.5%, stop -1%.`;
  } else if (
    latest!.netFlowUsd < -thresholdUsd &&
    prev!.netFlowUsd < -thresholdUsd
  ) {
    signal = "short";
    reason = `2 consecutive days < -$${(thresholdUsd / 1e6).toFixed(0)}M (${(prev!.netFlowUsd / 1e6).toFixed(0)}M → ${(latest!.netFlowUsd / 1e6).toFixed(0)}M)`;
    action = `Short BTC at next-day open, exit 24h later. Target -1.5%, stop +1%.`;
  } else {
    reason = `Latest ${(latest!.netFlowUsd / 1e6).toFixed(0)}M + prev ${(prev!.netFlowUsd / 1e6).toFixed(0)}M — no 2-day confirmation in either direction`;
    action = `No trade — wait for 2 consecutive days above ±$${(thresholdUsd / 1e6).toFixed(0)}M`;
  }

  return {
    latestDate: latest!.date,
    prevDate: prev!.date,
    latestFlow: latest!.netFlowUsd,
    prevFlow: prev!.netFlowUsd,
    signal,
    reason,
    action,
  };
}

/**
 * Parse a user-pasted Farside-like table into entries. Accepts lines of
 * form "YYYY-MM-DD\t<number>" or "YYYY-MM-DD <number>" or CSV.
 */
export function parseEtfFlowPaste(raw: string): EtfFlowEntry[] {
  const out: EtfFlowEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line
      .trim()
      .match(/^(\d{4}-\d{2}-\d{2})[\s,\t]+(-?[\d,.]+)\s*([MmBb]?)/);
    if (!m) continue;
    const date = m[1]!;
    let value = parseFloat(m[2]!.replace(/,/g, ""));
    const suffix = (m[3] ?? "").toLowerCase();
    if (suffix === "b") value *= 1_000_000_000;
    else if (suffix === "m" || Math.abs(value) < 1_000_000) value *= 1_000_000;
    out.push({ date, netFlowUsd: value });
  }
  return out;
}
