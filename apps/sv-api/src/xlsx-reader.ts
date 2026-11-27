// R11: a small, defensive .xlsx reader (Release Train 2, priority C). It reads the FIRST worksheet's cell text only. Cells are never evaluated: a formula is ignored and
// only its stored value is read; macros, external links, images and every other part of the workbook are never opened.
// Limits: the compressed file is capped by the caller (2 MB); here the archive may hold at most 60 entries, and the parts we read may inflate to at most 8 MB in total
// (a zip bomb is refused BEFORE inflating, from the sizes declared in the archive, and again after).
import { unzipSync, type UnzipFileInfo } from "fflate";
import { ApiError } from "./errors";

const MAX_ENTRIES = 60;
const MAX_INFLATED = 8 * 1024 * 1024;
const WANTED = new Set(["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml"]);
const MAX_COLUMNS = 40;
const MAX_ROWS = 2100;

const bad = (message: string) => new ApiError(422, "invalid_file", message);
const decoder = new TextDecoder("utf-8");

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === "amp") return "&"; if (e === "lt") return "<"; if (e === "gt") return ">"; if (e === "quot") return '"'; if (e === "apos") return "'";
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}
/** Concatenated text of every <t> element in a fragment (shared strings and inline strings can hold several runs). */
function textOf(fragment: string): string {
  let out = ""; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) out += decodeEntities(m[1]!);
  return out;
}
const columnIndex = (ref: string): number => { let n = 0; for (const ch of ref.replace(/[^A-Z]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export function readXlsxTable(bytes: Uint8Array): string[][] {
  let declared = 0; let entries = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f: UnzipFileInfo) => {
        entries += 1;
        if (entries > MAX_ENTRIES) throw bad("The workbook has too many parts. Save it again as a plain .xlsx or as CSV.");
        const wanted = WANTED.has(f.name) || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name);
        if (wanted) { declared += f.originalSize; if (declared > MAX_INFLATED) throw bad("The workbook is too large when opened. Split it, or save it as CSV."); }
        return wanted;
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw bad("The .xlsx file could not be read. Save it again from your spreadsheet, or save it as CSV.");
  }
  if (Object.values(files).reduce((n, b) => n + b.length, 0) > MAX_INFLATED) throw bad("The workbook is too large when opened. Split it, or save it as CSV.");
  const text = (name: string) => (files[name] ? decoder.decode(files[name]) : null);
  const workbook = text("xl/workbook.xml");
  if (workbook === null) throw bad("This does not look like an Excel workbook. Save it as .xlsx or CSV.");

  // the first sheet in the workbook's own order -> its part name through the relationships file
  const first = /<sheet\s[^>]*?r:id="([^"]+)"/.exec(workbook);
  const rels = text("xl/_rels/workbook.xml.rels");
  let sheetPath: string | null = null;
  if (first && rels) {
    const rel = new RegExp(`<Relationship\\s[^>]*?Id="${first[1]!.replace(/[^A-Za-z0-9_-]/g, "")}"[^>]*>`).exec(rels);
    const target = rel ? /Target="([^"]+)"/.exec(rel[0])?.[1] : undefined;
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  sheetPath ??= Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0] ?? null;
  const sheet = sheetPath ? text(sheetPath) : null;
  if (sheet === null) throw bad("The workbook has no worksheet.");

  const shared: string[] = [];
  const sst = text("xl/sharedStrings.xml");
  if (sst) { const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g; let m: RegExpExecArray | null; while ((m = re.exec(sst)) && shared.length < 200_000) shared.push(textOf(m[1]!)); }

  const table: string[][] = [];
  const rowRe = /<row(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null; let rowNo = 0;
  while ((rm = rowRe.exec(sheet))) {
    const rAttr = /\sr="(\d+)"/.exec(rm[0]!.slice(0, rm[0]!.indexOf(">") + 1));
    rowNo = rAttr ? parseInt(rAttr[1]!, 10) : rowNo + 1;
    if (rowNo > MAX_ROWS) throw bad("The workbook has more than 2,000 rows. Split it and import the parts.");
    const cells: string[] = [];
    const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1] ?? ""))) {
      const attrs = cm[1]!; const body = cm[2] ?? "";
      const ref = /\sr="([A-Z]+\d+)"/.exec(" " + attrs)?.[1]; const type = /\st="([^"]+)"/.exec(" " + attrs)?.[1];
      const col = ref ? columnIndex(ref) : cells.length;
      if (col < 0 || col >= MAX_COLUMNS) { if (col >= MAX_COLUMNS) continue; throw bad("The workbook has a malformed cell reference."); }
      let value = "";
      if (type === "s") { const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]; value = v !== undefined ? shared[parseInt(v, 10)] ?? "" : ""; }
      else if (type === "inlineStr") value = textOf(body);
      else if (type === "b") value = /<v>1<\/v>/.test(body) ? "TRUE" : "FALSE";
      else if (type === "e") value = "";   // an error value is not data
      else { const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]; value = v !== undefined ? decodeEntities(v) : ""; }
      while (cells.length <= col) cells.push("");
      cells[col] = value;
    }
    while (table.length < rowNo - 1) table.push([]);   // keep blank rows so each data row keeps its row number in the file
    table[rowNo - 1] = cells;
  }
  if (table.length === 0) throw bad("The worksheet is empty.");
  return table;
}
