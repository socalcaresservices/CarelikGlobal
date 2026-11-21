import { describe, expect, it } from "vitest";
import { MAX_IMPORT_BYTES, parseCsv, parseImportFile } from "../src/import-file";

const buf = (s: string) => Buffer.from(s, "utf8");
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
  it("refuses Excel, text and archives even when renamed CSV", async () => {
    for (const [name, content] of [["people.xlsx", "first_name,last_name\nA,B"], ["people.txt", "first_name,last_name\nA,B"], ["renamed.csv", "PK archive"], ["binary.csv", "first_name,last_name\nA,\0B"]]) {
      await expect(parseImportFile("people", name!, buf(content!))).rejects.toMatchObject({ status: 422, code: "invalid_file" });
    }
  });
  it("malformed or wrong files are refused with a plain message", async () => {
    await expect(parseImportFile("people", "x.csv", Buffer.alloc(0))).rejects.toMatchObject({ status: 422 });
    await expect(parseImportFile("people", "x.pdf", buf("%PDF-1.4"))).rejects.toThrow(/Upload a \.csv file/);
    await expect(parseImportFile("people", "x.csv", buf("first_name\nA\n"))).rejects.toThrow(/missing: last name/);
    await expect(parseImportFile("people", "x.csv", buf("first_name,last_name\n"))).rejects.toThrow(/header row and at least one data row/);
    await expect(parseImportFile("people", "x.xlsx", Buffer.from("PK not really a workbook"))).rejects.toThrow(/Upload a \.csv file/);
    await expect(parseImportFile("people", "big.csv", Buffer.alloc(MAX_IMPORT_BYTES + 1, 97))).rejects.toMatchObject({ status: 413 });
  });
  it("more than 2,000 data rows is refused", async () => {
    const csv = "first_name,last_name\n" + Array.from({ length: 2001 }, (_, i) => `A${i},B`).join("\n");
    await expect(parseImportFile("people", "many.csv", buf(csv))).rejects.toThrow(/more than 2,000/);
  });
});
