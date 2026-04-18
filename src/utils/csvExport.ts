import { Trade } from "@/types/trade";

const COLUMNS: { key: keyof Trade; header: string }[] = [
  { key: "id", header: "ID" },
  { key: "pair", header: "Pair" },
  { key: "direction", header: "Direction" },
  { key: "entryPrice", header: "Entry Price" },
  { key: "exitPrice", header: "Exit Price" },
  { key: "quantity", header: "Quantity" },
  { key: "entryDate", header: "Entry Date" },
  { key: "exitDate", header: "Exit Date" },
  { key: "pnl", header: "PnL" },
  { key: "pnlPercent", header: "PnL %" },
  { key: "fees", header: "Fees" },
  { key: "leverage", header: "Leverage" },
  { key: "strategy", header: "Strategy" },
  { key: "emotion", header: "Emotion" },
  { key: "confidence", header: "Confidence" },
  { key: "setupType", header: "Setup Type" },
  { key: "timeframe", header: "Timeframe" },
  { key: "marketCondition", header: "Market Condition" },
  { key: "tags", header: "Tags" },
  { key: "notes", header: "Notes" },
];

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str: string;
  if (Array.isArray(value)) {
    str = value.join(";");
  } else if (typeof value === "object") {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  const needsQuoting = /[",\n\r]/.test(str);
  if (needsQuoting) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function tradesToCsv(trades: Trade[]): string {
  const header = COLUMNS.map((c) => escapeCell(c.header)).join(",");
  const rows = trades.map((t) =>
    COLUMNS.map((c) => escapeCell(t[c.key])).join(","),
  );
  return [header, ...rows].join("\n");
}

export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportTradesToCsv(
  trades: Trade[],
  filenamePrefix = "trades",
): void {
  const csv = tradesToCsv(trades);
  const ts = new Date().toISOString().slice(0, 10);
  downloadCsv(`${filenamePrefix}-${ts}.csv`, csv);
}
