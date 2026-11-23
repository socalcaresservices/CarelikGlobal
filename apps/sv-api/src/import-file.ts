// R11: CSV-only import; no archive parsing. Cells are never evaluated.
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

export type ParsedImport = { rows: Array<Record<string, string>>; ignoredColumns: string[] };

/** Reads the file, maps the header row to the known columns, drops fully blank rows, and numbers each row by its row in the file (header = row 1). */
export async function parseImportFile(kind: ImportKind, fileName: string, bytes: Buffer): Promise<ParsedImport> {
  if (bytes.length === 0) throw new ApiError(422, "invalid_file", "The file is empty.");
  if (bytes.length > MAX_IMPORT_BYTES) throw new ApiError(413, "file_too_large", "The file is larger than 2 MB. Split it and import the parts.");
  const lower = fileName.toLowerCase();
  if (!lower.endsWith(".csv") || (bytes[0] === 0x50 && bytes[1] === 0x4b) || bytes.includes(0)) {
    throw new ApiError(422, "invalid_file", "Upload a .csv file. Save Excel workbooks as CSV first.");
  }
  const table = parseCsv(bytes.toString("utf8"));
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
