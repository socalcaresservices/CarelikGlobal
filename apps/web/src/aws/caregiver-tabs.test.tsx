// R20: on a phone a caregiver navigates with four bottom tabs; on a wide screen the sidebar is unchanged. SYNTHETIC data only.
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAws } from "./test-support";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const CG = ["availability.manage_own", "documents.manage_own"];
const phone = (on: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: on && /max-width/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }));

describe("caregiver bottom tabs", () => {
  it("on a phone: four tabs in order, the current one marked, each at least 64 px tall, no strip of tabs and no menu of the same pages", async () => {
    phone(true);
    renderAws("/my-shifts", CG, {}, "caregiver");
    const bar = await screen.findByTestId("caregiver-tabs", {}, { timeout: 15000 });
    const links = within(bar).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["My Schedule", "Verify Visit", "Availability", "My documents"]);
    expect(links.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent)).toEqual(["My Schedule"]);
    expect(links.every((a) => a.className.includes("min-h-[64px]"))).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Section tabs" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Main", hidden: true })).queryAllByRole("link", { hidden: true })).toHaveLength(0);   // the drawer does not repeat the four pages
    expect(screen.getByRole("button", { name: /Account/ })).toBeInTheDocument();
  }, 30000);

  it("on a wide screen: no bottom bar; the sidebar lists the four pages as before", async () => {
    phone(false);
    renderAws("/my-shifts", CG, {}, "caregiver");
    const nav = await screen.findByRole("navigation", { name: "Main" }, { timeout: 15000 });
    expect(screen.queryByTestId("caregiver-tabs")).toBeNull();
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["My Schedule", "Verify Visit", "Availability", "My documents"]);
  }, 30000);

  it("office roles never get the bottom bar, even on a phone", async () => {
    phone(true);
    renderAws("/", ["visits.read", "shifts.manage", "clients.names.read"], {}, "manager");
    await screen.findByRole("navigation", { name: "Main", hidden: true }, { timeout: 15000 });
    expect(screen.queryByTestId("caregiver-tabs")).toBeNull();
  }, 30000);
});
