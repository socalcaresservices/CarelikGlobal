// The compact-density primitives: the short form is what shows, the full text stays in the page and opens on demand. SYNTHETIC text only.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuditList } from "./audit-list";
import { CompactAlert } from "./compact-alert";
import { HelpLine } from "./help-line";
import { InfoTip } from "./info-tip";

afterEach(cleanup);

describe("compact density primitives", () => {
  it("CompactAlert: one line with a symbol and words; the explanation is inside a closed <details> until expanded; without details it is a plain status line", () => {
    const { container } = render(<><CompactAlert summary="Hire date missing">The 14-day period cannot be applied until a hire date is recorded.</CompactAlert><CompactAlert tone="danger" summary="Over limit" /></>);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(screen.getByText("Hire date missing")).toBeInTheDocument();
    expect(screen.getByText(/cannot be applied/)).toBeInTheDocument(); // in the page for screen readers, shown on expanding
    fireEvent.click(screen.getByText("Hire date missing"));
    details.open = true;
    expect(details.open).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("Over limit");
  });

  it("InfoTip: an icon button with an accessible name and the text referenced by aria-describedby; a click opens it and Escape closes it", () => {
    render(<InfoTip label="About this">Background explanation.</InfoTip>);
    const button = screen.getByRole("button", { name: "About this" });
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(tip.className).toContain("block");
    fireEvent.keyDown(button, { key: "Escape" });
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("HelpLine: an info icon only (the text stays in the page for screen readers); `important` keeps the short line visible", () => {
    const { container } = render(<HelpLine details="Longer explanation.">Short guidance.</HelpLine>);
    expect(container.querySelector("p")).toBeNull();
    expect(screen.getByRole("button", { name: "More information" })).toHaveAccessibleDescription("Short guidance. Longer explanation.");
    cleanup();
    const shown = render(<HelpLine important details="Longer explanation.">Short guidance.</HelpLine>);
    expect(shown.container.querySelector("p")).toHaveTextContent("Short guidance.");
    expect(screen.getByRole("button", { name: "More information" })).toBeInTheDocument();
  });

  it("AuditList: one row per event with when, who and a truncated summary; a row expands to its detail; the list scrolls and is keyboard reachable", () => {
    render(<AuditList label="History" rows={[{ id: "1", when: "10/19 3:00 PM", who: "Morgan", summary: "status changed", detail: "Full detail text" }, { id: "2", when: "10/18 9:00 AM", summary: "opened" }]} />);
    const list = screen.getByRole("list", { name: "History" });
    expect(list).toHaveAttribute("tabindex", "0");
    expect(list.className).toContain("overflow-y-auto");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Morgan")).toBeInTheDocument();
    expect(screen.getByText("Full detail text")).toBeInTheDocument();
  });
});
