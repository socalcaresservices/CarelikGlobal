import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFilters } from "./use-filters";

interface Row {
  id: string;
  status: "active" | "inactive";
  role: string;
}

const rows: Row[] = [
  { id: "1", status: "active", role: "staff" },
  { id: "2", status: "inactive", role: "staff" },
  { id: "3", status: "active", role: "manager" }
];

const matchers = {
  status: (row: Row, value: string) => row.status === value,
  role: (row: Row, value: string) => row.role === value
};

describe("useFilters", () => {
  it("returns all rows when no filters are set", () => {
    const { result } = renderHook(() => useFilters(rows, matchers));
    expect(result.current.rows).toHaveLength(3);
    expect(result.current.values).toEqual({});
  });

  it("filters by a single active value", () => {
    const { result } = renderHook(() => useFilters(rows, matchers));
    act(() => result.current.setFilter("status", "active"));
    expect(result.current.rows.map((row) => row.id)).toEqual(["1", "3"]);
  });

  it("ANDs multiple active filters together", () => {
    const { result } = renderHook(() => useFilters(rows, matchers));
    act(() => result.current.setFilter("status", "active"));
    act(() => result.current.setFilter("role", "manager"));
    expect(result.current.rows.map((row) => row.id)).toEqual(["3"]);
  });

  it("clears a single filter by setting an empty value", () => {
    const { result } = renderHook(() => useFilters(rows, matchers));
    act(() => result.current.setFilter("status", "active"));
    act(() => result.current.setFilter("status", ""));
    expect(result.current.rows).toHaveLength(3);
    expect(result.current.values).toEqual({});
  });

  it("clearAll resets every filter", () => {
    const { result } = renderHook(() => useFilters(rows, matchers));
    act(() => result.current.setFilter("status", "active"));
    act(() => result.current.setFilter("role", "manager"));
    act(() => result.current.clearAll());
    expect(result.current.rows).toHaveLength(3);
    expect(result.current.values).toEqual({});
  });

  it("handles undefined rows gracefully", () => {
    const { result } = renderHook(() => useFilters<Row>(undefined, matchers));
    expect(result.current.rows).toEqual([]);
  });
});
