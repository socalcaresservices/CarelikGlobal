import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FormSection } from "./form-section";

describe("FormSection", () => {
  it("renders title, description, and children", () => {
    render(
      <FormSection title="Contact Information" description="How to reach this client">
        <label htmlFor="phone">Phone</label>
      </FormSection>
    );
    expect(screen.getByText("Contact Information")).toBeInTheDocument();
    expect(screen.getByText("How to reach this client")).toBeInTheDocument();
    expect(screen.getByText("Phone")).toBeInTheDocument();
  });
});
