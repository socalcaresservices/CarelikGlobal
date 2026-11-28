// One export helper for every operational report screen (directive 2026-11-27: CSV and Excel everywhere, print where practical). The file is built in the browser from the rows
// already on screen, in screen order, so an export never shows a row the person could not see and keeps the order they were looking at.
import { buildXlsx, XLSX_CONTENT_TYPE } from "@carelik/shared";

export type ExportColumn = readonly [header: string, key: string, format?: (value: unknown, row: Record<string, unknown>) => string];
export type ExportFormat = "csv" | "xlsx";

const text = (value: unknown): string => (value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : typeof value === "boolean" ? (value ? "Yes" : "No") : Array.isArray(value) ? value.join("; ") : String(value));
/** A cell that starts with = + - @ or a control character gets a leading apostrophe so a spreadsheet never runs it as a formula (same rule as the server exports). */
const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
export function exportTable(columns: readonly ExportColumn[], rows: readonly object[]): string[][] {
  return [columns.map(([h]) => h), ...rows.map((r) => { const o = r as Record<string, unknown>; return columns.map(([, k, f]) => safe(f ? f(o[k], o) : text(o[k]))); })];
}
export const toCsv = (table: readonly (readonly string[])[]) => table.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n");
export const toXlsx = (sheet: string, table: string[][]) => buildXlsx([{ name: sheet, rows: table }]);

export function downloadFile(filename: string, data: BlobPart, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}
/** Download the table as CSV or Excel (the Excel file has one sheet; at most 26 columns). */
export function exportRows(format: ExportFormat, basename: string, sheet: string, columns: readonly ExportColumn[], rows: readonly object[]) {
  const table = exportTable(columns, rows);
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "csv") downloadFile(`${basename}-${stamp}.csv`, toCsv(table), "text/csv");
  else downloadFile(`${basename}-${stamp}.xlsx`, toXlsx(sheet, table) as BlobPart, XLSX_CONTENT_TYPE);
}
