// R11: the file parser. SYNTHETIC data only. XLSX files are generated in the test with the same library the API uses.
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { MAX_IMPORT_BYTES, parseCsv, parseImportFile } from "../src/import-file";

const buf = (s: string) => Buffer.from(s, "utf8");
const xlsx = async (table: unknown[][]) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("People");
  for (const r of table) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
};

/** A zip whose central directory DECLARES a huge uncompressed size: enough to test the pre-check without building a real bomb. */
const zipDeclaring = (sizes: number[]) => {
  const parts: Buffer[] = []; let cdLen = 0;
  for (const size of sizes) { const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt32LE(size, 24); parts.push(h); cdLen += 46; }
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(sizes.length, 8); e.writeUInt16LE(sizes.length, 10); e.writeUInt32LE(cdLen, 12); e.writeUInt32LE(0, 16);
  return Buffer.concat([...parts, e]);
};

describe("workbook size guard (zip bomb)", () => {
  it("refuses a workbook that declares more than 25 MB uncompressed, before decompressing anything", async () => {
    await expect(parseImportFile("people", "bomb.xlsx", zipDeclaring([200_000_000]))).rejects.toMatchObject({ status: 422, message: expect.stringContaining("too large once opened") });
    await expect(parseImportFile("people", "bomb.xlsx", zipDeclaring([20_000_000, 20_000_000]))).rejects.toMatchObject({ status: 422 });
  });
  it("refuses a zip with an unreasonable number of parts, and accepts a normal generated workbook", async () => {
    await expect(parseImportFile("people", "many.xlsx", zipDeclaring(Array.from({ length: 301 }, () => 10)))).rejects.toMatchObject({ status: 422 });
    const ok = await parseImportFile("people", "ok.xlsx", await xlsx([["first_name", "last_name"], ["Eve", "Excel"]]));
    expect(ok.rows).toHaveLength(1);
  });
});

describe("CSV", () => {
  it("handles quotes, doubled quotes, commas and newlines inside a field, CRLF and a byte-order mark", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n"line1\nline2",z\r\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"'], ["line1\nline2", "z"]]);
  });
  it("an unclosed quote is refused with a plain message", () => {
    expect(() => parseCsv('a,b\n"oops,1\n')).toThrow(/never closed/);
  });
});

describe("parseImportFile", () => {
  it("maps header aliases, trims, skips blank rows and numbers rows by their place in the file (header = row 1)", async () => {
    const r = await parseImportFile("people", "team.csv", buf("First Name,Surname,Role,E-mail,Mobile,Notes\nAda,Lovelace,Caregiver,ada@example.com,555-0100,x\n,,,,,\nBo,Peep,Scheduler,,,\n"));
    expect(r.rows).toEqual([
      { _row: "2", first_name: "Ada", last_name: "Lovelace", type: "Caregiver", email: "ada@example.com", phone: "555-0100" },
      { _row: "4", first_name: "Bo", last_name: "Peep", type: "Scheduler", email: "", phone: "" },
    ]);
    expect(r.ignoredColumns).toEqual(["Notes"]);
  });
  it("clients use city and client type", async () => {
    const r = await parseImportFile("clients", "c.csv", buf("first_name,last_name,city,client type\nCy,Sample,Springfield,Respite\n"));
    expect(r.rows[0]).toMatchObject({ first_name: "Cy", last_name: "Sample", city: "Springfield", client_type: "Respite" });
  });
  it("reads an .xlsx workbook, including a formula cell as its stored result (never evaluated)", async () => {
    const bytes = await xlsx([["first_name", "last_name"], ["Eve", "Excel"], [{ formula: "1+1", result: 2 }, "Formula"]]);
    const r = await parseImportFile("people", "people.xlsx", bytes);
    expect(r.rows.map((x) => [x.first_name, x.last_name])).toEqual([["Eve", "Excel"], ["2", "Formula"]]);
  });
  it("is decided by the content, not the name: a zip renamed .csv is still read as a workbook", async () => {
    const r = await parseImportFile("people", "renamed.csv", await xlsx([["first_name", "last_name"], ["Zed", "Zip"]]));
    expect(r.rows).toHaveLength(1);
  });
  it("malformed or wrong files are refused with a plain message", async () => {
    await expect(parseImportFile("people", "x.csv", Buffer.alloc(0))).rejects.toMatchObject({ status: 422 });
    await expect(parseImportFile("people", "x.pdf", buf("%PDF-1.4"))).rejects.toThrow(/\.csv or \.xlsx/);
    await expect(parseImportFile("people", "x.csv", buf("first_name\nA\n"))).rejects.toThrow(/missing: last name/);
    await expect(parseImportFile("people", "x.csv", buf("first_name,last_name\n"))).rejects.toThrow(/header row and at least one data row/);
    await expect(parseImportFile("people", "x.xlsx", Buffer.from("PK not really a workbook"))).rejects.toThrow(/could not be read/);
    await expect(parseImportFile("people", "big.csv", Buffer.alloc(MAX_IMPORT_BYTES + 1, 97))).rejects.toMatchObject({ status: 413 });
  });
  it("more than 2,000 data rows is refused", async () => {
    const csv = "first_name,last_name\n" + Array.from({ length: 2001 }, (_, i) => `A${i},B`).join("\n");
    await expect(parseImportFile("people", "many.csv", buf(csv))).rejects.toThrow(/more than 2,000/);
  });
});
