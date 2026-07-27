import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AlertCard } from "./alert-card";

describe("AlertCard", () => {
  it("renders the value, label, and status text", () => {
    render(<AlertCard value={3} label="Credentials expiring or expired" statusText="Review" tone="danger" />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Credentials expiring or expired")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("adds hover-affordance classes when linkable", () => {
    const { container } = render(<AlertCard value={1} label="Pending invitations" statusText="Review" tone="warning" linkable />);
    expect(container.firstChild).toHaveClass("hover:shadow-md");
  });
});
