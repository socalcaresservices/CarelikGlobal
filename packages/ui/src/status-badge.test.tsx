import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./status-badge";

describe("StatusBadge", () => {
  it("renders the label", () => {
    render(<StatusBadge label="active" tone="success" />);
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("applies tone-specific classes", () => {
    render(<StatusBadge label="expired" tone="danger" />);
    expect(screen.getByText("expired")).toHaveClass("bg-red-50");
  });

  it("defaults to neutral tone", () => {
    render(<StatusBadge label="unknown" />);
    expect(screen.getByText("unknown")).toHaveClass("bg-slate-100");
  });
});
