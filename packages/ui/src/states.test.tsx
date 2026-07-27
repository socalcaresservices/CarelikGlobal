import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState, ErrorState, LoadingState, Skeleton, SkeletonCard } from "./states";

describe("LoadingState", () => {
  it("shows a default label", () => {
    render(<LoadingState />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows a custom label", () => {
    render(<LoadingState label="Fetching clients…" />);
    expect(screen.getByText("Fetching clients…")).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("shows a default message", () => {
    render(<ErrorState />);
    expect(screen.getByText("Something went wrong. Try again.")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("shows the message and an optional action", () => {
    render(<EmptyState message="No clients yet." action={<button>Add a client</button>} />);
    expect(screen.getByText("No clients yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a client" })).toBeInTheDocument();
  });

  it("shows an optional icon above the message", () => {
    render(<EmptyState message="No clients yet." icon={<span data-testid="empty-icon" />} />);
    expect(screen.getByTestId("empty-icon")).toBeInTheDocument();
  });
});

describe("Skeleton", () => {
  it("renders a shimmer placeholder block", () => {
    const { container } = render(<Skeleton className="h-4 w-full" />);
    expect(container.firstChild).toHaveClass("animate-pulse");
  });
});

describe("SkeletonCard", () => {
  it("renders a title line plus the requested number of body lines", () => {
    const { container } = render(<SkeletonCard lines={2} />);
    expect(container.querySelectorAll(".animate-pulse").length).toBe(3);
  });
});
