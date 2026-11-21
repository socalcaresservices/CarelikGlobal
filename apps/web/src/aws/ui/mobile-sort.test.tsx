import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobileSortControl } from "./sort-th";
import { useSortedRows } from "./table-sort";

type Row = { name: string; updated: string | null; hours: number };
const ROWS: Row[] = [
  { name: "Mia", updated: "2026-03-01", hours: 5 },
  { name: "Zed", updated: "2026-05-01", hours: 2 },
  { name: "Amy", updated: null, hours: 9 },
];

function Harness() {
  const { rows, sort } = useSortedRows(ROWS, { name: { get: (r) => r.name }, updated: { get: (r) => r.updated, kind: "date" }, hours: { get: (r) => r.hours, kind: "number" } });
  return (
    <>
      <MobileSortControl sort={sort} options={[{ column: "name", label: "Name" }, { column: "updated", label: "Last upload", kind: "date" }, { column: "hours", label: "Hours", kind: "number" }]} />
      <ol aria-label="rows">{rows.map((r) => <li key={r.name}>{r.name}</li>)}</ol>
    </>
  );
}
const order = () => screen.getAllByRole("listitem").map((li) => li.textContent);

describe("MobileSortControl", () => {
  it("starts with no chosen column and the list in its given order, with no direction button", () => {
    render(<Harness />);
    expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveValue("");
    expect(screen.queryByRole("button")).toBeNull();
    expect(order()).toEqual(["Mia", "Zed", "Amy"]);
  });

  it("choosing a column sorts by it (text A to Z, dates newest first, empty last), and the button reverses it", () => {
    render(<Harness />);
    const select = screen.getByRole("combobox", { name: "Sort by" });
    fireEvent.change(select, { target: { value: "name" } });
    expect(order()).toEqual(["Amy", "Mia", "Zed"]);
    fireEvent.click(screen.getByRole("button", { name: /Order: A to Z/ }));
    expect(order()).toEqual(["Zed", "Mia", "Amy"]);
    fireEvent.change(select, { target: { value: "updated" } });
    expect(order()).toEqual(["Zed", "Mia", "Amy"]); // newest first; the empty date stays last
    expect(screen.getByRole("button", { name: /Order: newest first/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Order: newest first/ }));
    expect(order()).toEqual(["Mia", "Zed", "Amy"]); // oldest first; the empty date still last
  });

  it("numbers sort smallest first and can be reversed; both controls are at least 44px tall on a phone", () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "hours" } });
    expect(order()).toEqual(["Zed", "Mia", "Amy"]);
    fireEvent.click(screen.getByRole("button", { name: /Order: smallest first/ }));
    expect(order()).toEqual(["Amy", "Mia", "Zed"]);
    expect(screen.getByRole("combobox", { name: "Sort by" }).className).toContain("min-h-[44px]");
    expect(screen.getByRole("button", { name: /Tap to reverse/ }).className).toContain("min-h-[44px]");
  });

  it("is hidden from the md breakpoint up, where the column headings carry the sort", () => {
    render(<Harness />);
    expect(screen.getByTestId("mobile-sort").className).toContain("md:hidden");
  });
});
