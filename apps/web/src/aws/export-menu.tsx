// CSV, Excel and Print for the rows a report screen is showing (directive 2026-11-27). The file is built from those rows in screen order (see report-export.ts).
import { Button } from "@carelik/ui";
import { exportRows, type ExportColumn } from "./report-export";

export function ExportMenu({ basename, sheet, columns, rows, disabled }: { basename: string; sheet: string; columns: readonly ExportColumn[]; rows: readonly object[]; disabled?: boolean }) {
  const off = disabled ?? rows.length === 0;
  return (
    <div className="flex flex-wrap gap-2 print:hidden" role="group" aria-label={`Export ${sheet}`}>
      <Button type="button" variant="secondary" disabled={off} onClick={() => exportRows("csv", basename, sheet, columns, rows)}>Export CSV</Button>
      <Button type="button" variant="secondary" disabled={off} onClick={() => exportRows("xlsx", basename, sheet.slice(0, 31), columns, rows)}>Export Excel</Button>
      <Button type="button" variant="secondary" onClick={() => window.print()}>Print</Button>
    </div>
  );
}
