// One sorting pattern for the app's tables (owner, 2026-11-17: "filter each column A–Z or new to old"). Click a heading to sort by it; click again to
// reverse. Text columns start A–Z; date columns start newest first. Empty values always go last. The choice lasts while the page is open.
import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";
export type SortValue = string | number | null | undefined;
export type SortKind = "text" | "number" | "date";
export interface SortColumn<T> { get: (row: T) => SortValue; kind?: SortKind }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareValues(a: SortValue, b: SortValue, kind: SortKind = "text"): number {
  const emptyA = a === null || a === undefined || a === "", emptyB = b === null || b === undefined || b === "";
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (kind === "date") return Date.parse(String(a)) - Date.parse(String(b));
  if (kind === "number" || (typeof a === "number" && typeof b === "number")) return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

export interface Sorting<K extends string> { key: K | null; dir: SortDir; toggle: (key: K) => void }

/** Sorts `rows` by the chosen column; stable, empty values last in both directions. Without a chosen column the server's order is kept. */
export function useSortedRows<T, K extends string>(rows: readonly T[], columns: Record<K, SortColumn<T>>, initial?: { key: K; dir: SortDir }): { rows: T[]; sort: Sorting<K> } {
  const [key, setKey] = useState<K | null>(initial?.key ?? null);
  const [dir, setDir] = useState<SortDir>(initial?.dir ?? "asc");
  const toggle = (next: K) => {
    if (next === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setKey(next); setDir(columns[next].kind === "date" ? "desc" : "asc"); }
  };
  const sorted = useMemo(() => {
    if (!key) return [...rows];
    const col = columns[key];
    return rows
      .map((row, i) => ({ row, i, v: col.get(row) }))
      .sort((a, b) => {
        const emptyA = a.v === null || a.v === undefined || a.v === "", emptyB = b.v === null || b.v === undefined || b.v === "";
        if (emptyA !== emptyB) return emptyA ? 1 : -1;   // empty last, whatever the direction
        const c = compareValues(a.v, b.v, col.kind);
        return (dir === "asc" ? c : -c) || a.i - b.i;
      })
      .map((x) => x.row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, key, dir]);
  return { rows: sorted, sort: { key, dir, toggle } };
}

