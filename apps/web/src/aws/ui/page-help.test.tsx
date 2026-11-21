// One help control per page: inside the app shell every InfoTip joins one panel opened by the "?" in the header. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderAws } from "../test-support";

afterEach(cleanup);
const PERMS = ["authorizations.read", "shifts.manage", "visits.read", "clients.names.read", "continuity.export", "organization.update"];

describe("page help", () => {
  it("shows no floating info icons: the tips of a page are behind ONE '?' in the header", async () => {
    renderAws("/continuity", PERMS);
    const button = await screen.findByTestId("page-help-button");
    expect(screen.getAllByRole("button", { name: "Help for this page" })).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: /^(More information|About )/ })).toHaveLength(0);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("page-help-panel")).toHaveClass("hidden");
  });

  it("opens the panel with the page's help, and Escape, a second press and a tap elsewhere close it", async () => {
    renderAws("/continuity", PERMS);
    const button = await screen.findByTestId("page-help-button");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByTestId("page-help-panel");
    expect(panel).not.toHaveClass("hidden");
    expect(within(panel).getAllByRole("region").length + panel.querySelectorAll("section").length).toBeGreaterThan(0);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(button).toHaveAttribute("aria-expanded", "false"));
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(button).toHaveAttribute("aria-expanded", "false"));
  });

  it("a page with no help has no '?'", async () => {
    renderAws("/profile", ["visits.read"]);
    await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByTestId("page-help-button")).toBeNull();
  });
});
