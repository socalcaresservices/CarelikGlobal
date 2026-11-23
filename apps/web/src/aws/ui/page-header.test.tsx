import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("shows the title and the action, and lets a wide action row wrap inside a phone's width (it may not grow past its container)", () => {
    render(<PageHeader title="Staff" action={<div data-testid="actions" className="flex flex-wrap gap-3"><button type="button">Import from a file</button><button type="button">Add office staff</button></div>} />);
    expect(screen.getByRole("heading", { name: "Staff" })).toBeInTheDocument();
    const wrapper = screen.getByTestId("actions").parentElement!;
    expect(wrapper.className).toContain("max-w-full"); // without it the action row never wraps and the page scrolls sideways at 390 px
    expect(wrapper.className).toContain("shrink-0");
  });

  it("renders no action wrapper when there is no action", () => {
    const { container } = render(<PageHeader title="Staff Types" />);
    expect(container.querySelectorAll("header > div")).toHaveLength(1);
  });
});
