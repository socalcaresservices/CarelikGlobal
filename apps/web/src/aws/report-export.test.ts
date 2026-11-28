// The shared export helper: CSV and Excel from the rows on screen, formula-safe, in screen order. SYNTHETIC only.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// fflate is a dependency of @carelik/shared (which builds the workbook); the test reads the file back through it.
const { unzipSync, strFromU8 } = createRequire(resolve(process.cwd(), "../../packages/shared/package.json"))("fflate") as { unzipSync(data: Uint8Array): Record<string, Uint8Array>; strFromU8(data: Uint8Array): string };
import { exportTable, toCsv, toXlsx } from "./report-export";
import { WORKLIST_COLUMNS } from "./authorization-worklist-data";

const rows = [
  { status: "missing", clientCode: "CL-1", serviceName: "Respite", authorizedMinutes: null },
  { status: "nearly_exhausted", clientCode: "=HYPERLINK(\"x\")", serviceName: "Res, pite", program: "A \"quoted\" program", authorizedMinutes: 90, usedMinutes: 75, scheduledMinutes: 0, remainingMinutes: 15, percentCommitted: 83, periodEnd: "2026-12-15T00:00:00.000Z" },
];
describe("export helper", () => {
  it("keeps the screen's column order and row order, turns minutes into hours and status codes into words", () => {
    const t = exportTable(WORKLIST_COLUMNS, rows);
    expect(t[0]).toEqual(["Status", "Client", "Office", "Service", "Program", "Authorization number", "Period start", "Period end", "Days to expiry", "Authorized (hours)", "Used (hours)", "Scheduled (hours)", "Remaining (hours)", "Committed (%)"]);
    expect(t[1]![0]).toBe("Missing"); expect(t[2]![0]).toBe("Nearly exhausted");
    expect(t[2]![7]).toBe("2026-12-15"); expect(t[2]![9]).toBe("1.5"); expect(t[2]![12]).toBe("0.3");
  });
  it("neutralizes spreadsheet formulas and escapes quotes and commas", () => {
    const csv = toCsv(exportTable(WORKLIST_COLUMNS, rows));
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"Res, pite"`);
    expect(csv).toContain(`"A ""quoted"" program"`);
    expect(csv.split("\r\n")).toHaveLength(3);
  });
  it("builds a valid .xlsx (a zip with a workbook and one sheet holding the same cells)", () => {
    const bytes = toXlsx("Authorizations", exportTable(WORKLIST_COLUMNS, rows));
    expect(strFromU8(bytes.subarray(0, 2))).toBe("PK");
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["xl/workbook.xml", "xl/worksheets/sheet1.xml"]));
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain("Authorized (hours)"); expect(sheet).toContain("Nearly exhausted"); expect(sheet).toContain("&quot;x&quot;");
  });
});
