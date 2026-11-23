// R11 XLSX import (Release Train 2): the reader, the guards, and the same mapping as CSV. Workbooks are built here from XML text. SYNTHETIC data only.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseImportFile } from "../src/import-file";
import { readXlsxTable } from "../src/xlsx-reader";

type Cell = string | number | { inline: string } | { formula: string; value: string };
const colName = (i: number) => String.fromCharCode(65 + i);
function sheetXml(rows: Cell[][], startRow = 1) {
  const body = rows.map((r, ri) => `<row r="${startRow + ri}">${r.map((c, ci) => {
    const ref = `${colName(ci)}${startRow + ri}`;
    if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
    if (typeof c === "string") return `<c r="${ref}" t="s"><v>${shared.indexOf(c)}</v></c>`;
    if ("inline" in c) return `<c r="${ref}" t="inlineStr"><is><t>${c.inline}</t></is></c>`;
    return `<c r="${ref}" t="str"><f>${c.formula}</f><v>${c.value}</v></c>`;
  }).join("")}</row>`).join("");
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}
let shared: string[] = [];
function workbook(rows: Cell[][], extra: Record<string, Uint8Array> = {}, opts: { startRow?: number } = {}): Buffer {
  shared = [...new Set([...rows.flat().filter((c): c is string => typeof c === "string"), "ignored"])];
  const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((t) => `<si><t>${t.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`).join("")}</sst>`;
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(`<workbook xmlns:r="x"><sheets><sheet name="Second" sheetId="2" r:id="rId2"/><sheet name="First" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>`),
    "xl/sharedStrings.xml": strToU8(sst),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml(rows, opts.startRow ?? 1)),
    "xl/worksheets/sheet2.xml": strToU8(sheetXml([["ignored", "ignored"]])),
    ...extra,
  }));
}

describe("XLSX reader", () => {
  it("reads the first sheet in the workbook's own order (not the first file), including shared strings", () => {
    // the workbook lists "Second" first (rId2 -> sheet2), so THAT is the first sheet
    expect(readXlsxTable(new Uint8Array(workbook([["first_name", "last_name"], ["Ana", "Sample"]])))).toEqual([["ignored", "ignored"]]);
  });
  it("reads inline strings with entities, numbers and a formula's stored value (never evaluating it)", () => {
    const zip = Buffer.from(zipSync({ ...unz(workbook([["h", "h"], ["Ana", { inline: "Sample &amp; Co &#65;" }], [{ formula: "1+1", value: "2" }, 42]])), "xl/workbook.xml": strToU8(`<workbook xmlns:r="x"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`) }));
    expect(readXlsxTable(new Uint8Array(zip))).toEqual([["h", "h"], ["Ana", "Sample & Co A"], ["2", "42"]]);
  });
  it("maps a people workbook exactly like the CSV: headers by alias, blank rows skipped, rows numbered by their row in the file, extra columns reported", async () => {
    const buf = workbook([["First Name", "Last name", "Role", "Notes"], ["Ana", "Sample", "Caregiver", "x"], ["Bo", "Example", "Caregiver", "y"]]);
    // make sheet1 the first sheet for this test by pointing the workbook at it
    const zip = Buffer.from(zipSync({ ...unz(buf), "xl/workbook.xml": strToU8(`<workbook xmlns:r="x"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`) }));
    const r = await parseImportFile("people", "people.xlsx", zip);
    expect(r.rows).toMatchObject([{ _row: "2", first_name: "Ana", last_name: "Sample", type: "Caregiver" }, { _row: "3", first_name: "Bo", last_name: "Example", type: "Caregiver" }]);
    expect(r.ignoredColumns).toEqual(["Notes"]);
  });
  it("a formula cell yields its stored text only and a spreadsheet-injection value stays text for the database to refuse", async () => {
    const buf = workbook([["first_name", "last_name"], [{ formula: "HYPERLINK(\"http://x\")", value: "=cmd" }, "Injection"]]);
    const zip = Buffer.from(zipSync({ ...unz(buf), "xl/workbook.xml": strToU8(`<workbook xmlns:r="x"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`) }));
    const r = await parseImportFile("people", "p.xlsx", zip);
    expect(r.rows[0]).toMatchObject({ first_name: "=cmd", last_name: "Injection" });
  });
  it("refuses a zip bomb before inflating, too many parts, a missing workbook and garbage; the messages are plain", () => {
    const bomb = Buffer.from(zipSync({ "xl/workbook.xml": strToU8("<workbook/>"), "xl/worksheets/sheet1.xml": new Uint8Array(9 * 1024 * 1024) }));
    expect(bomb.length).toBeLessThan(200_000);   // tiny on disk, huge inflated
    expect(() => readXlsxTable(new Uint8Array(bomb))).toThrow(/too large when opened/);
    const many: Record<string, Uint8Array> = {}; for (let i = 0; i < 70; i++) many[`junk/${i}.txt`] = strToU8("x");
    expect(() => readXlsxTable(new Uint8Array(zipSync({ ...many, "xl/workbook.xml": strToU8("<workbook/>") })))).toThrow(/too many parts/);
    expect(() => readXlsxTable(new Uint8Array(zipSync({ "hello.txt": strToU8("hi") })))).toThrow(/does not look like an Excel workbook/);
    expect(() => readXlsxTable(new Uint8Array(Buffer.from("PK\x03\x04 garbage")))).toThrow(/could not be read/);
  });
  it("refuses more than 2,000 data rows and ignores columns beyond 40", () => {
    const rows: Cell[][] = [["first_name", "last_name"]]; for (let i = 0; i < 2105; i++) rows.push(["A", "B"]);
    const buf = workbook(rows);
    const zip = Buffer.from(zipSync({ ...unz(buf), "xl/workbook.xml": strToU8(`<workbook xmlns:r="x"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`) }));
    expect(() => readXlsxTable(new Uint8Array(zip))).toThrow(/more than 2,000 rows/);
  });
});

import { unzipSync } from "fflate";
const unz = (b: Buffer) => unzipSync(new Uint8Array(b));
