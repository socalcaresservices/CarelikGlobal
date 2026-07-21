import type { ReactNode } from "react";
import { Card } from "./card";

// Renders a real <table> on wider screens and a stacked card list on
// narrow ones, from the same row data - so list pages aren't a
// horizontally-scrolling spreadsheet on a phone or tablet, per the
// "usable on desktop, tablet, and mobile" and "avoid horizontal
// scrolling on ordinary forms" requirements. The caller still owns the
// actual table markup (so existing sortable/resizable headers keep
// working) and just supplies a second, compact per-row renderer for
// the mobile card.
export interface ResponsiveDataViewProps<T> {
  rows: T[];
  rowKey: (row: T) => string;
  renderTable: (rows: T[]) => ReactNode;
  renderCard: (row: T) => ReactNode;
  emptyMessage?: string;
}

export function ResponsiveDataView<T>({
  rows,
  rowKey,
  renderTable,
  renderCard,
  emptyMessage = "No records."
}: ResponsiveDataViewProps<T>) {
  if (rows.length === 0) {
    return <p className="py-4 text-center text-sm text-slate-400">{emptyMessage}</p>;
  }

  return (
    <>
      <div className="hidden md:block">{renderTable(rows)}</div>
      <div className="space-y-2 md:hidden">
        {rows.map((row) => (
          <Card key={rowKey(row)} className="p-3">
            {renderCard(row)}
          </Card>
        ))}
      </div>
    </>
  );
}
