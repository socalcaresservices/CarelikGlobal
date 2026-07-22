import { useMemo, useState } from "react";

// Generic client-side filtering, meant to compose with useTableControls
// (search + sort) the same way every list page already composes search
// and sort: apply useFilters first, then feed its `rows` into
// useTableControls. Kept as a separate hook rather than folded into
// useTableControls so pages that don't need filters (there are none
// left, but future ones might) aren't forced to pass an empty object,
// and so the existing, already-tested useTableControls API doesn't
// have to change.
//
// A filter is "active" when its value is a non-empty string. Filters
// are AND-ed together. Each page defines its own matchers (e.g.
// `status: (row, value) => row.status === value`) since only the page
// knows its row shape.

export type FilterMatchers<T> = Record<string, (row: T, value: string) => boolean>;

export interface UseFiltersResult<T> {
  values: Record<string, string>;
  setFilter: (key: string, value: string) => void;
  clearAll: () => void;
  rows: T[];
}

export function useFilters<T>(rows: T[] | undefined, matchers: FilterMatchers<T>): UseFiltersResult<T> {
  const [values, setValues] = useState<Record<string, string>>({});

  function setFilter(key: string, value: string) {
    setValues((current) => {
      if (!value) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: value };
    });
  }

  function clearAll() {
    setValues({});
  }

  const filtered = useMemo(() => {
    const source = rows ?? [];
    const activeKeys = Object.keys(values).filter((key) => values[key]);
    if (activeKeys.length === 0) return source;
    return source.filter((row) => activeKeys.every((key) => matchers[key]?.(row, values[key]!) ?? true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, values]);

  return { values, setFilter, clearAll, rows: filtered };
}
