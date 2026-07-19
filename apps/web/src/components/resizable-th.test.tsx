import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlainHeader } from "./resizable-th";
import { SortableHeader } from "./sortable-header";

function renderInTable(children: React.ReactNode) {
  return render(
    <table>
      <thead>
        <tr>{children}</tr>
      </thead>
    </table>
  );
}

describe("PlainHeader", () => {
  it("renders the label and applies the given width", () => {
    renderInTable(<PlainHeader label="Phone" width={140} onResizeStart={vi.fn()} />);
    const cell = screen.getByText("Phone").closest("th");
    expect(cell).toHaveStyle({ width: "140px" });
  });

  it("omits the resize handle when no onResizeStart is given", () => {
    renderInTable(<PlainHeader label="Phone" />);
    expect(screen.queryByLabelText("Resize Phone column")).not.toBeInTheDocument();
  });

  it("shows a resize handle when onResizeStart is given", () => {
    renderInTable(<PlainHeader label="Phone" onResizeStart={vi.fn()} />);
    expect(screen.getByLabelText("Resize Phone column")).toBeInTheDocument();
  });
});

describe("SortableHeader resizing", () => {
  it("applies the given width and shows a resize handle", () => {
    renderInTable(
      <SortableHeader
        label="Name"
        active={false}
        direction="asc"
        onClick={vi.fn()}
        width={220}
        onResizeStart={vi.fn()}
      />
    );
    const cell = screen.getByText("Name").closest("th");
    expect(cell).toHaveStyle({ width: "220px" });
    expect(screen.getByLabelText("Resize Name column")).toBeInTheDocument();
  });

  it("omits the resize handle when no onResizeStart is given", () => {
    renderInTable(<SortableHeader label="Name" active={false} direction="asc" onClick={vi.fn()} />);
    expect(screen.queryByLabelText("Resize Name column")).not.toBeInTheDocument();
  });
});
