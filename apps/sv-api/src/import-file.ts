// R11 bulk import: turns an uploaded CSV or XLSX file into plain rows for ogevia_api.import_rows. Nothing here talks to the database or the network, and nothing
// in a cell is ever evaluated (a formula cell is read as its stored text/result; text that starts with = + - @ is later refused by the name rule).
import { ApiError } from "./errors";

export type ImportKind = "people" | "clients";
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;

const FIELDS: Record<ImportKind, Array<{ key: string; aliases: string[]; required?: boolean }>> = {
  people: [
    { key: "first_name", aliases: ["firstname", "first", "givenname"], required: true },
    { key: "last_name", aliases: ["lastname", "last", "surname", "familyname"], required: true },
    { key: "type", aliases: ["type", "role", "stafftype"] },
    { key: "email", aliases: ["email", "emailaddress"] },
    { key: "phone", aliases: ["phone", "phonenumber", "mobile", "cell"] },
  ],
  clients: [
    { key: "first_name", aliases: ["firstname", "first", "givenname"], required: true },
    { key: "last_name", aliases: ["lastname", "last", "surname", "familyname"], required: true },
    { key: "city", aliases: ["city", "town"] },
    { key: "client_type", aliases: ["clienttype", "type"] },
  ],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** RFC 4180 style CSV: quoted fields, doubled quotes, CRLF or LF, a leading byte-order mark. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const out: string[][] = [];
  let row: string[] = [], field = "", quoted = false, i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (quoted) throw new ApiError(422, "invalid_file", "The CSV file has a quote that is never closed. Re-save it from your spreadsheet as CSV and try again.");
  if (field !== "" || row.length > 0) { row.push(field); out.push(row); }
  return out;
}

/** A workbook is a zip. A small file can expand to gigabytes (a "zip bomb") and kill the Lambda, so the sizes the zip itself declares are checked BEFORE anything is decompressed. */
export const MAX_XLSX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 300;
export function assertWorkbookNotTooLarge(bytes: Buffer): void {
  const refuse = () => { throw new ApiError(422, "invalid_file", "That workbook is too large once opened. Remove unused sheets and formatting, or save it as .csv."); };
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ApiError(422, "invalid_file", "That file could not be read as an Excel workbook. Save it as .xlsx or .csv and try again.");
  const entries = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  if (entries > MAX_XLSX_ENTRIES || entries === 0xffff || at === 0xffffffff) refuse();   // zip64 or an unreasonable number of parts
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) refuse();
    const size = bytes.readUInt32LE(at + 24);
    if (size === 0xffffffff) refuse();
    total += size;
    if (total > MAX_XLSX_UNCOMPRESSED_BYTES) refuse();
    at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
}

async function xlsxRows(bytes: Buffer): Promise<string[][]> {
  assertWorkbookNotTooLarge(bytes);
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new ApiError(422, "invalid_file", "That file could not be read as an Excel workbook. Save it as .xlsx or .csv and try again.");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new ApiError(422, "invalid_file", "The workbook has no sheets.");
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    const n = Math.min(row.cellCount, 30);
    for (let c = 1; c <= n; c++) {
      const cell = row.getCell(c);
      const v: unknown = cell.value;
      // A formula cell is read as its stored result, never evaluated; a rich-text or hyperlink cell as its visible text.
      const text = v !== null && typeof v === "object" && "result" in (v as object) ? String((v as { result?: unknown }).result ?? "") : cell.text;
      cells.push(typeof text === "string" ? text : String(text ?? ""));
    }
    rows.push(cells);
  });
  return rows;
}

export type ParsedImport = { rows: Array<Record<string, string>>; ignoredColumns: string[] };

/** Reads the file, maps the header row to the known columns, drops fully blank rows, and numbers each row by its row in the file (header = row 1). */
export async function parseImportFile(kind: ImportKind, fileName: string, bytes: Buffer): Promise<ParsedImport> {
  if (bytes.length === 0) throw new ApiError(422, "invalid_file", "The file is empty.");
  if (bytes.length > MAX_IMPORT_BYTES) throw new ApiError(413, "file_too_large", "The file is larger than 2 MB. Split it and import the parts.");
  const lower = fileName.toLowerCase();
  const isXlsx = bytes[0] === 0x50 && bytes[1] === 0x4b;   // a zip container, whatever the file is called
  if (!isXlsx && !lower.endsWith(".csv") && !lower.endsWith(".txt")) throw new ApiError(422, "invalid_file", "Upload a .csv or .xlsx file.");
  const table = isXlsx ? await xlsxRows(bytes) : parseCsv(bytes.toString("utf8"));
  if (table.length < 2) throw new ApiError(422, "invalid_file", "The file needs a header row and at least one data row.");
  const header = (table[0] ?? []).map(norm);
  const spec = FIELDS[kind];
  const colOf = new Map<string, number>();
  for (const f of spec) {
    const idx = header.findIndex((h) => f.aliases.includes(h));
    if (idx >= 0) colOf.set(f.key, idx);
  }
  const missing = spec.filter((f) => f.required && !colOf.has(f.key)).map((f) => f.key.replace("_", " "));
  if (missing.length > 0) throw new ApiError(422, "invalid_file", `The header row is missing: ${missing.join(", ")}. Use the template.`);
  const used = new Set(colOf.values());
  const ignoredColumns = (table[0] ?? []).filter((h, i) => !used.has(i) && h.trim() !== "").map((h) => h.trim().slice(0, 40));
  const rows: Array<Record<string, string>> = [];
  for (let r = 1; r < table.length; r++) {
    const line = table[r]!;
    if (line.every((c) => c.trim() === "")) continue;
    const obj: Record<string, string> = { _row: String(r + 1) };
    for (const [key, idx] of colOf) obj[key] = (line[idx] ?? "").trim();
    rows.push(obj);
    if (rows.length > MAX_IMPORT_ROWS) throw new ApiError(422, "invalid_file", "The file has more than 2,000 rows. Split it and import the parts.");
  }
  if (rows.length === 0) throw new ApiError(422, "invalid_file", "The file has no data rows.");
  return { rows, ignoredColumns };
}
