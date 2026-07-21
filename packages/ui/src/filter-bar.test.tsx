import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterBar, FilterChip } from "./filter-bar";

describe("FilterChip", () => {
  it("calls onRemove when the remove button is clicked", () => {
    const onRemove = vi.fn();
    render(<FilterChip label="Status: active" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Status: active" }));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe("FilterBar", () => {
  it("renders its filter controls", () => {
    render(
      <FilterBar>
        <input aria-label="Search" />
      </FilterBar>
    );
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
  });

  it("renders active filter chips and a clear-all action", () => {
    const onRemove = vi.fn();
    const onClearAll = vi.fn();
    render(
      <FilterBar
        activeFilters={[{ key: "status", label: "Status: active", onRemove }]}
        onClearAll={onClearAll}
      >
        <input aria-label="Search" />
      </FilterBar>
    );
    expect(screen.getByText("Status: active")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Clear all"));
    expect(onClearAll).toHaveBeenCalled();
  });

  it("shows no chip row when there are no active filters", () => {
    render(
      <FilterBar>
        <input aria-label="Search" />
      </FilterBar>
    );
    expect(screen.queryByText("Clear all")).not.toBeInTheDocument();
  });
});
