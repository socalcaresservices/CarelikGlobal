// Shared table sorting (owner, 2026-11-17: every column A–Z or new to old).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SortTh } from "./sort-th";
import { compareValues, useSortedRows } from "./table-sort";

type Row = { name: string | null; at: string | null; n: number | null };
const ROWS: Row[] = [
  { name: "beth", at: "2026-11-02T10:00:00Z", n: 10 },
  { name: "Adam", at: "2026-11-15T10:00:00Z", n: 2 },
  { name: null, at: null, n: null },
  { name: "carl 10", at: "2026-10-30T10:00:00Z", n: 9 },
  { name: "carl 9", at: "2026-11-01T10:00:00Z", n: 9 },
];
function Table() {
  const { rows, sort } = useSortedRows(ROWS, { name: { get: (r) => r.name }, at: { get: (r) => r.at, kind: "date" }, n: { get: (r) => r.n, kind: "number" } });
  return (
    <table>
      <thead><tr><SortTh sort={sort} column="name">Name</SortTh><SortTh sort={sort} column="at" kind="date">Date</SortTh><SortTh sort={sort} column="n" kind="number">Hours</SortTh></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td>{r.name ?? "—"}</td><td>{r.at ?? "—"}</td><td>{r.n ?? "—"}</td></tr>)}</tbody>
    </table>
  );
}
const col = (i: number) => within(screen.getAllByRole("rowgroup")[1]!).getAllByRole("row").map((r) => within(r).getAllByRole("cell")[i]!.textContent);

describe("table sorting", () => {
  it("keeps the server's order until a heading is clicked", () => {
    render(<Table />);
    expect(col(0)).toEqual(["beth", "Adam", "—", "carl 10", "carl 9"]);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "none");
  });
  it("text sorts A–Z ignoring case and with numbers in order, then Z–A; empty values stay last", () => {
    render(<Table />);
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(col(0)).toEqual(["Adam", "beth", "carl 9", "carl 10", "—"]);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(col(0)).toEqual(["carl 10", "carl 9", "beth", "Adam", "—"]);
  });
  it("dates start newest first, then oldest first", () => {
    render(<Table />);
    fireEvent.click(screen.getByRole("button", { name: /Date/ }));
    expect(col(1)).toEqual(["2026-11-15T10:00:00Z", "2026-11-02T10:00:00Z", "2026-11-01T10:00:00Z", "2026-10-30T10:00:00Z", "—"]);
    expect(screen.getByRole("columnheader", { name: /Date/ })).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(screen.getByRole("button", { name: /Date/ }));
    expect(col(1)[0]).toBe("2026-10-30T10:00:00Z");
  });
  it("numbers sort numerically and ties keep their original order", () => {
    render(<Table />);
    fireEvent.click(screen.getByRole("button", { name: /Hours/ }));
    expect(col(2)).toEqual(["2", "9", "9", "10", "—"]);
    expect(col(0).slice(1, 3)).toEqual(["carl 10", "carl 9"]);
  });
  it("compareValues", () => {
    expect(compareValues("a", "B")).toBeLessThan(0);
    expect(compareValues(null, "a")).toBeGreaterThan(0);
    expect(compareValues("2026-01-02", "2026-01-01", "date")).toBeGreaterThan(0);
  });
});
