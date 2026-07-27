import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusChip } from "./status-chip";

describe("StatusChip", () => {
  it("renders a named preset's label and tone color", () => {
    render(<StatusChip status="expired" />);
    expect(screen.getByText("Expired")).toHaveClass("text-red-700");
  });

  it("renders a custom label/tone when given, ignoring the preset", () => {
    render(<StatusChip status="active" label="On leave" tone="warning" />);
    expect(screen.getByText("On leave")).toHaveClass("text-amber-700");
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });

  it("shows a tone-colored dot by default", () => {
    const { container } = render(<StatusChip status="verified" />);
    expect(container.querySelector(".bg-emerald-500")).not.toBeNull();
  });
});
