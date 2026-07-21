import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("renders the eyebrow, title, and description", () => {
    render(<PageHeader eyebrow="Team" title="Acme" description="Your caregiver roster" />);
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Your caregiver roster")).toBeInTheDocument();
  });

  it("renders actions when given", () => {
    render(<PageHeader eyebrow="Team" title="Acme" actions={<button>Add</button>} />);
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("omits the description when not given", () => {
    render(<PageHeader eyebrow="Team" title="Acme" />);
    expect(screen.queryByText("Your caregiver roster")).not.toBeInTheDocument();
  });
});
