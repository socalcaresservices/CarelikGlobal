import { useMemo, useState } from "react";

// Generic client-side search + sort for the plain-array tables used
// across Clients/Schedule/Access/Audit. Per docs/design-system.md,
// "every list is sortable, filterable" - this is the shared
// implementation so each page doesn't reinvent it slightly differently.
// Deliberately client-side only: every list in this app today is small
// enough (single organization's clients/shifts/members/recent audit
// entries) that fetching everything and filtering in memory is simpler
// and faster than a server round-trip per keystroke. Revisit if a list
// ever needs to handle thousands of rows.

export type SortDirection = "asc" | "desc";

export interface TableControls<T, SortKey extends string> {
  search: string;
  setSearch: (value: string) => void;
  sortKey: SortKey | null;
  direction: SortDirection;
  toggleSort: (key: SortKey) => void;
  rows: T[];
}

export function useTableControls<T, SortKey extends string>(
  rows: T[] | undefined,
  options: {
    matchesSearch: (row: T, query: string) => boolean;
    sorters: Record<SortKey, (a: T, b: T) => number>;
    defaultSort?: SortKey;
  }
): TableControls<T, SortKey> {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey | null>(options.defaultSort ?? null);
  const [direction, setDirection] = useState<SortDirection>("asc");

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDirection("asc");
    }
  }

  const result = useMemo(() => {
    const source = rows ?? [];
    const query = search.trim().toLowerCase();
    const filtered = query ? source.filter((row) => options.matchesSearch(row, query)) : source;

    if (!sortKey) return filtered;

    const sorter = options.sorters[sortKey];
    const sorted = [...filtered].sort(sorter);
    return direction === "asc" ? sorted : sorted.reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, sortKey, direction]);

  return { search, setSearch, sortKey, direction, toggleSort, rows: result };
}
