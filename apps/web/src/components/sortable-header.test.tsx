import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SortableHeader } from "./sortable-header";

// resizable-th.test.tsx already covers SortableHeader's shared width/resize-
// handle behavior (it's the same ColumnResizeHandle both header components
// use). What's untested is the logic unique to this component: which of the
// three lucide icons renders for a given active/direction combination, and
// that clicking the header still fires onClick. lucide-react gives every
// icon a predictable `lucide-<kebab-name>` class (see createLucideIcon.js),
// so that's used here instead of relying on any accessible name (these
// icons are decorative, with no aria-label of their own).
function renderInTable(children: React.ReactNode) {
  return render(
    <table>
      <thead>
        <tr>{children}</tr>
      </thead>
    </table>
  );
}

describe("SortableHeader", () => {
  it("shows a neutral icon when not the active sort column", () => {
    renderInTable(<SortableHeader label="Category" active={false} direction="asc" onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Category" });
    expect(button.querySelector(".lucide-chevrons-up-down")).toBeInTheDocument();
    expect(button.querySelector(".lucide-chevron-up")).not.toBeInTheDocument();
    expect(button.querySelector(".lucide-chevron-down")).not.toBeInTheDocument();
  });

  it("shows an up chevron when active and sorted ascending", () => {
    renderInTable(<SortableHeader label="Category" active direction="asc" onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Category" });
    expect(button.querySelector(".lucide-chevron-up")).toBeInTheDocument();
  });

  it("shows a down chevron when active and sorted descending", () => {
    renderInTable(<SortableHeader label="Category" active direction="desc" onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Category" });
    expect(button.querySelector(".lucide-chevron-down")).toBeInTheDocument();
  });

  it("calls onClick when the header is clicked", () => {
    const onClick = vi.fn();
    renderInTable(<SortableHeader label="Category" active={false} direction="asc" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Category" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
