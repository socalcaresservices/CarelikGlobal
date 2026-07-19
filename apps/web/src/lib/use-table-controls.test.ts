import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTableControls } from "./use-table-controls";

interface Row {
  id: string;
  name: string;
  age: number;
}

const rows: Row[] = [
  { id: "1", name: "Charlie", age: 40 },
  { id: "2", name: "Alice", age: 20 },
  { id: "3", name: "Bob", age: 30 }
];

function setup() {
  return renderHook(() =>
    useTableControls<Row, "name" | "age">(rows, {
      matchesSearch: (row, query) => row.name.toLowerCase().includes(query),
      sorters: {
        name: (a, b) => a.name.localeCompare(b.name),
        age: (a, b) => a.age - b.age
      }
    })
  );
}

describe("useTableControls", () => {
  it("returns rows unsorted and unfiltered by default", () => {
    const { result } = setup();
    expect(result.current.rows.map((row) => row.name)).toEqual(["Charlie", "Alice", "Bob"]);
  });

  it("filters rows by the search query, case-insensitively", () => {
    const { result } = setup();
    act(() => result.current.setSearch("ali"));
    expect(result.current.rows.map((row) => row.name)).toEqual(["Alice"]);
  });

  it("sorts ascending on first toggle and descending on second toggle of the same key", () => {
    const { result } = setup();
    act(() => result.current.toggleSort("name"));
    expect(result.current.rows.map((row) => row.name)).toEqual(["Alice", "Bob", "Charlie"]);

    act(() => result.current.toggleSort("name"));
    expect(result.current.rows.map((row) => row.name)).toEqual(["Charlie", "Bob", "Alice"]);
  });

  it("resets to ascending when switching to a different sort key", () => {
    const { result } = setup();
    act(() => result.current.toggleSort("age"));
    act(() => result.current.toggleSort("age"));
    expect(result.current.direction).toBe("desc");

    act(() => result.current.toggleSort("name"));
    expect(result.current.direction).toBe("asc");
    expect(result.current.rows.map((row) => row.name)).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("combines search and sort", () => {
    const { result } = setup();
    act(() => result.current.setSearch("li"));
    act(() => result.current.toggleSort("age"));
    expect(result.current.rows.map((row) => row.name)).toEqual(["Alice", "Charlie"]);
  });
});
