import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState, ErrorState, LoadingState } from "./states";

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
});
