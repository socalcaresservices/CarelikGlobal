// The Caregiver holds page (compliance holds and the admin-approved exceptions of 0123) has its own menu entry under Operations for people who may read compliance, so it opens even when
// the action queue and the holds list are empty. SYNTHETIC data only.
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws, type Handler } from "./test-support";

afterEach(() => cleanup());
const EMPTY_HOLDS = { holds: [], totals: { holds: 0, affectedShifts: 0, affectedAssignments: 0, inProgressVisits: 0 }, shiftsAtRisk: [] };
const handlers = (overrides = true): Record<string, Handler> => ({
  "GET /v1/compliance/holds": () => json(200, EMPTY_HOLDS),
  ...(overrides ? { "GET /v1/readiness-overrides": () => json(200, { overrides: [] }) } : {}),
});
const STAFF = ["visits.read", "visits.manage", "caregivers.manage", "readiness.read", "staff.read", "documents.read"];

describe("Caregiver holds menu entry", () => {
  it("is listed under Operations for a user who may read compliance and opens the page with Admin-approved exceptions, with no holds and an empty queue", async () => {
    renderAws("/", STAFF, handlers(), "organization_owner");
    const nav = await screen.findByRole("navigation", {}, { timeout: 15000 });
    const group = within(nav).queryByRole("button", { name: /Operations/ });
    if (group && group.getAttribute("aria-expanded") === "false") fireEvent.click(group);
    const link = await within(nav).findByRole("link", { name: "Caregiver holds" });
    expect(link).toHaveAttribute("href", "/compliance");
    fireEvent.click(link);
    expect(await screen.findByText("No caregiver is on a compliance hold.", undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(await screen.findByTestId("overrides-report")).toHaveTextContent("Admin-approved exceptions");
    expect(screen.getByTestId("overrides-report")).toHaveTextContent("None.");
  });

  it("is not listed for a user who may not read compliance", async () => {
    renderAws("/", ["visits.read", "visits.manage"], handlers(), "scheduler");
    const nav = await screen.findByRole("navigation", {}, { timeout: 15000 });
    const group = within(nav).queryByRole("button", { name: /Operations/ });
    if (group && group.getAttribute("aria-expanded") === "false") fireEvent.click(group);
    expect(within(nav).queryByRole("link", { name: "Caregiver holds" })).not.toBeInTheDocument();
  });
});
