import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SectionCard } from "./section-card";

describe("SectionCard", () => {
  it("renders title, description, actions, and children", () => {
    render(
      <SectionCard title="Credentials" description="Compliance tracking" actions={<button>Add</button>}>
        <p>Body content</p>
      </SectionCard>
    );
    expect(screen.getByText("Credentials")).toBeInTheDocument();
    expect(screen.getByText("Compliance tracking")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(screen.getByText("Body content")).toBeInTheDocument();
  });
});
