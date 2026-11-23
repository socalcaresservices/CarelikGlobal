// R5: Schedule is calendar-first. Add shift opens in a side panel; one exceptions panel holds what needs action; repeating and limits are under More. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

const PERMS = ["shifts.manage", "visits.manage", "visits.read", "clients.names.read", "matching.read", "authorizations.read"];
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const at = (h: number) => new Date(Date.now() + h * 3600e3);
afterEach(() => cleanup());
const shift = (id: string, over: Record<string, unknown> = {}) => ({ shiftId: id, startsAt: at(3).toISOString(), endsAt: at(5).toISOString(), localDate: today, coverageState: "covered", clientId: "c1", clientCode: "CL-1", clientName: "Client One", serviceId: "sv1", serviceCode: "PCS", serviceName: "Personal care",
  caregiverRecordId: "r1", caregiverCode: "CG-1", caregiverName: "Alex Caregiver", hasSignIn: true, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null, ...over });
const quiet = { "GET /v1/shifts-to-reconcile": () => json(200, { shifts: [] }), "GET /v1/shift-pickups": () => json(200, { requests: [] }) };
const open = (id: string) => shift(id, { coverageState: "needs_coverage", caregiverRecordId: null, caregiverName: null, caregiverCode: null });

describe("Schedule layout (R5)", () => {
  it("Add shift is the single primary button; it opens a side panel (not an inline form) and Escape closes it, returning focus to the button", async () => {
    renderAws("/schedule", PERMS, { "GET /v1/shifts": () => json(200, { shifts: [shift("a")] }) });
    const add = await screen.findByRole("button", { name: "Add shift" }, { timeout: 15000 });
    add.focus();
    fireEvent.click(add);
    const panel = await screen.findByRole("dialog", { name: "Add shift" });
    expect(panel).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Close" })).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(add).toHaveFocus());
  }, 30000);

  it("repeating shifts are a choice inside the panel: the same panel switches to the repeat form", async () => {
    renderAws("/schedule", PERMS, { "GET /v1/shifts": () => json(200, { shifts: [shift("a")] }) });
    fireEvent.click(await screen.findByRole("button", { name: "Add shift" }, { timeout: 15000 }));
    const panel = await screen.findByRole("dialog", { name: "Add shift" });
    fireEvent.click(within(panel).getByRole("button", { name: "Repeating" }));
    expect(await screen.findByRole("dialog", { name: "Repeat visits" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repeating" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "One shift" }));
    expect(await screen.findByRole("dialog", { name: "Add shift" })).toBeInTheDocument();
  }, 30000);

  it("one exceptions panel: open with the count when something needs action, closed and saying so when nothing does; each item keeps its own single action", async () => {
    renderAws("/schedule", PERMS, { ...quiet, "GET /v1/shifts": () => json(200, { shifts: [open("o1"), shift("ok")] }) });
    const panel = await screen.findByTestId("exceptions-panel", {}, { timeout: 15000 });
    await waitFor(() => expect(panel).toHaveTextContent(/1 need action/), { timeout: 15000 });
    expect(panel).toHaveAttribute("open");
    expect(within(panel).getByRole("heading", { name: "Unfilled (1)" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Assign/ })).toBeInTheDocument();
    cleanup();
    renderAws("/schedule", PERMS, { ...quiet, "GET /v1/shifts": () => json(200, { shifts: [shift("ok")] }) });
    const calm = await screen.findByTestId("exceptions-panel", {}, { timeout: 15000 });
    await waitFor(() => expect(calm).toHaveTextContent("Nothing needs action"), { timeout: 15000 });
    expect(calm).not.toHaveAttribute("open");
  }, 30000);

  it("the three old controls beside the title are gone: no Repeat visits, series and limits sit under More", async () => {
    renderAws("/schedule", PERMS, { "GET /v1/shifts": () => json(200, { shifts: [shift("a")] }) });
    await screen.findByRole("button", { name: "Add shift" }, { timeout: 15000 });
    expect(screen.queryByRole("button", { name: "Repeat visits" })).toBeNull();
    const more = screen.getByText("More").closest("details")!;
    expect(within(more).getByRole("button", { name: "Manage repeating shifts" })).toBeInTheDocument();
    expect(within(more).getByRole("button", { name: "Hours and limits" })).toBeInTheDocument();
    expect(screen.queryByTestId("scheduling-overview")).toBeNull();   // the strip of five figures is gone
  }, 30000);

  it("someone who only reads visits sees no Add shift and no More", async () => {
    renderAws("/schedule", ["visits.manage", "visits.read", "clients.names.read"], { "GET /v1/shifts": () => json(200, { shifts: [shift("a")] }) });
    await screen.findByTestId("exceptions-panel", {}, { timeout: 15000 });
    expect(screen.queryByRole("button", { name: "Add shift" })).toBeNull();
    expect(screen.queryByText("More")).toBeNull();
  }, 30000);
});
