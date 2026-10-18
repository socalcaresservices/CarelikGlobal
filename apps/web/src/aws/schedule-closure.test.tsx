/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies are free-form JSON */
// The schedule (Board 3): day, week and month views; the overview; filters; what happened to a shift; prefill from the client's record; suggested replacements from the
// matching rule (the office still chooses); links from Action needed land on the right shift. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyFilters, filterOptions, monthEnd, monthGrid, stepAnchor, viewRange, NO_FILTERS } from "./schedule-model";
import { json, renderAws } from "./test-support";

const PERMS = ["shifts.manage", "visits.manage", "visits.read", "clients.names.read", "matching.read", "authorizations.read"];
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const at = (h: number) => new Date(Date.now() + h * 3600e3);
afterEach(() => cleanup());
const shift = (id: string, over: Record<string, unknown> = {}) => ({ shiftId: id, startsAt: at(3).toISOString(), endsAt: at(5).toISOString(), localDate: today, coverageState: "covered", clientId: "c1", clientCode: "CL-1", clientName: "Client One", serviceId: "sv1", serviceName: "Personal care", serviceCode: "PCS",
  caregiverRecordId: "r1", caregiverCode: "CG-1", caregiverName: "Alex Caregiver", hasSignIn: true, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null, ...over });

describe("the view model", () => {
  it("day, week and month ranges, stepping and the month grid are calendar arithmetic", () => {
    expect(viewRange("day", "2026-10-17")).toEqual({ from: "2026-10-17", to: "2026-10-17" });
    expect(viewRange("week", "2026-10-17")).toEqual({ from: "2026-10-17", to: "2026-10-23" });
    expect(viewRange("month", "2026-10-17")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
    expect(stepAnchor("day", "2026-10-31", 1)).toBe("2026-11-01");
    expect(stepAnchor("week", "2026-10-17", -1)).toBe("2026-10-10");
    expect(stepAnchor("month", "2026-01-31", 1)).toBe("2026-02-01");
    expect(stepAnchor("month", "2026-01-15", -1)).toBe("2025-12-01");
    const weeks = monthGrid("2026-10-17"); // October 2026 starts on a Thursday
    expect(weeks[0]!.slice(0, 4)).toEqual([null, null, null, "2026-10-01"]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });
  it("filters keep what matches, offer only what exists, and the open choice means no caregiver", () => {
    const a = shift("a") as any, b = shift("b", { caregiverRecordId: null, caregiverName: null, caregiverCode: null, coverageState: "needs_coverage", clientId: "c2", clientName: "Client Two" }) as any, c = shift("c", { displayState: "partial" }) as any;
    expect(applyFilters([a, b, c], { ...NO_FILTERS, caregiver: "open" })).toEqual([b]);
    expect(applyFilters([a, b, c], { ...NO_FILTERS, client: "c2" })).toEqual([b]);
    expect(applyFilters([a, b, c], { ...NO_FILTERS, state: "partial" })).toEqual([c]);
    expect(applyFilters([a, b, c], NO_FILTERS)).toHaveLength(3);
    const o = filterOptions([a, b, c]);
    expect(o.clients.map(([, l]) => l)).toEqual(["Client One", "Client Two"]);
    expect(o.states.map(([k]) => k).sort()).toEqual(["covered", "needs_coverage", "partial"]);
  });
});

describe("views, overview and states", () => {
  it("opens on the week; the month view shows a grid with counts and a day opens its day; the overview reads today and the server's urgent list", async () => {
    const { calls } = renderAws("/schedule", PERMS, {
      "GET /v1/shifts": ({ url }) => {
        const open = shift("s2", { coverageState: "needs_coverage", caregiverRecordId: null, caregiverName: null, caregiverCode: null });
        const onlyToday = url.searchParams.get("from") === url.searchParams.get("to") && url.searchParams.get("from") === today;
        return json(200, { shifts: onlyToday ? [shift("s1"), open] : [shift("s1"), open, shift("s3", { localDate: `${today.slice(0, 8)}${today.endsWith("28") ? "27" : "28"}` })] });
      },
      "GET /v1/action-issues": () => json(200, { asOf: new Date().toISOString(), matching: 2, limit: 50, offset: 0, counts: { total: 2, critical: 1, urgent: 1, routine: 0, actionNeeded: 2, byQueue: {} },
        issues: [{ issueKey: "a", kind: "shift", reason: "uncovered_open", queue: "needs_attention_now", category: "coverage", severity: "critical", deadline: null, since: null, shiftId: "s2", visitId: null, entityId: "s2", caregiverRecordId: null, clientId: "c1", serviceId: "sv1", clientCode: "CL-1", caregiverCode: null, serviceCode: "PCS", status: "open", firstSeenAt: null, reopenCount: 0, action: "assign_caregiver", recommendedAction: "x" },
          { issueKey: "b", kind: "visit", reason: "missing_clock_out", queue: "needs_attention_now", category: "visits", severity: "urgent", deadline: null, since: null, shiftId: null, visitId: "v1", entityId: "v1", caregiverRecordId: null, clientId: "c1", serviceId: "sv1", clientCode: "CL-1", caregiverCode: null, serviceCode: "PCS", status: "open", firstSeenAt: null, reopenCount: 0, action: "review_visit", recommendedAction: "y" }] }),
    });
    const overview = await screen.findByTestId("scheduling-overview", {}, { timeout: 15000 });
    await waitFor(() => expect(overview).toHaveTextContent(/Today\s*2\s*visits/));
    await waitFor(() => expect(overview).toHaveTextContent("Urgent exceptions 2"));
    expect(overview).toHaveTextContent("Today, no caregiver 1");
    expect(within(overview).getByRole("link", { name: "See all" })).toHaveAttribute("href", "/action-needed");
    expect(screen.getByRole("button", { name: "Week", pressed: true })).toBeInTheDocument();
    expect(screen.getByLabelText("Week starting")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    const grid = await screen.findByTestId("month-grid");
    expect(calls.some((c) => c.path === "/v1/shifts" && c.query.get("from") === `${today.slice(0, 7)}-01`)).toBe(true);
    const cell = within(grid).getByRole("button", { name: new RegExp(`^${today}: 2 visits, 1 needs coverage`) });
    fireEvent.click(cell);
    expect(screen.getByRole("button", { name: "Day", pressed: true })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "← Previous day" })).toBeInTheDocument();
  }, 30000);

  it("shows what happened to a shift in plain words and filters by it; a shift that ended with no record is not called a failure", async () => {
    renderAws("/schedule", PERMS, { "GET /v1/shifts": () => json(200, { shifts: [
      shift("a", { displayState: "verification_pending" }), shift("b", { displayState: "missed", coverageState: "completed" }), shift("c", { displayState: "partial", coverageState: "completed" }),
      shift("d", { displayState: "delivered_not_verified", coverageState: "completed" }), shift("e", { displayState: "not_delivered", coverageState: "completed" })] }) });
    const states = await screen.findAllByTestId("shift-state", {}, { timeout: 15000 });
    expect(states.map((s) => s.textContent)).toEqual(["Verification pending", "Missed: no visit record", "Partial visit", "Delivered: not verified", "Not delivered"]);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const bar = screen.getByTestId("shift-filters");
    fireEvent.change(within(bar).getByLabelText("Status"), { target: { value: "partial" } });
    await waitFor(() => expect(screen.getAllByTestId("shift-state")).toHaveLength(1));
    fireEvent.click(within(bar).getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getAllByTestId("shift-state")).toHaveLength(5));
  }, 30000);

  it("a client in the link filters the list to that client", async () => {
    renderAws("/schedule?client=c2", PERMS, { "GET /v1/shifts": () => json(200, { shifts: [shift("a"), shift("b", { clientId: "c2", clientName: "Client Two", clientCode: "CL-2" })] }) });
    await screen.findAllByTestId("shift-state", {}, { timeout: 15000 });
    await waitFor(() => expect(screen.getAllByTestId("shift-state")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Filters (1 on)" })).toBeInTheDocument();
  }, 30000);
});

describe("links from Action needed, prefill and suggested replacements", () => {
  const candidates = { matches: { ruleVersion: "v0-provisional-50-25-25", ruleStatus: "provisional", rankedByScore: true, note: null, candidates: [
    { caregiverRecordId: "r2", caregiverCode: "CG-2", name: "Blair Caregiver", eligibility: "eligible", assignedToClient: true, scheduledMinutesThatWeek: 0, score: { ruleVersion: "v0", ruleStatus: "provisional", complete: true, label: null, total: 80, components: [{ name: "availability", weight: 50, points: 50, status: "scored", reason: "free" }] } },
    { caregiverRecordId: "r3", caregiverCode: "CG-3", name: "Casey Caregiver", eligibility: "eligible", assignedToClient: false, scheduledMinutesThatWeek: 600, score: { ruleVersion: "v0", ruleStatus: "provisional", complete: false, label: "Score incomplete", total: null, components: [] } },
    { caregiverRecordId: "r4", caregiverCode: "CG-4", name: "Dana Caregiver", eligibility: "not_eligible", assignedToClient: false, scheduledMinutesThatWeek: 0, score: { ruleVersion: "v0", ruleStatus: "provisional", complete: true, label: null, total: 0, components: [] } },
    { caregiverRecordId: "r1", caregiverCode: "CG-1", name: "Alex Caregiver", eligibility: "eligible", assignedToClient: true, scheduledMinutesThatWeek: 0, score: { ruleVersion: "v0", ruleStatus: "provisional", complete: true, label: null, total: 90, components: [] } }] } };
  it("?shift= highlights that shift and with coverage=1 opens the assignment; the suggestions list only eligible caregivers in the server's order, never the one being replaced, and Select only fills the box", async () => {
    const open = shift("open1", { coverageState: "needs_coverage", caregiverRecordId: "r1", caregiverName: "Alex Caregiver", lastCalloutReason: "Sick" });
    const { calls } = renderAws(`/schedule?coverage=1&shift=open1&at=${encodeURIComponent(open.startsAt)}`, PERMS, {
      "GET /v1/shifts": () => json(200, { shifts: [open, shift("other")] }),
      "GET /v1/caregivers": () => json(200, { caregivers: ["r1", "r2", "r3"].map((id, n) => ({ caregiverRecordId: id, caregiverCode: `CG-${n + 1}`, firstName: ["Alex", "Blair", "Casey"][n], lastName: "Caregiver", preferredName: null, status: "active", hasSignIn: true })) }),
      "POST /v1/matching/candidates": () => json(200, candidates),
    });
    const row = await screen.findByTestId("replacement-suggestions", {}, { timeout: 15000 });
    expect(document.getElementById("shift-open1")).toHaveAttribute("data-highlight", "true");
    const items = within(row).getAllByTestId("suggestion");
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining("Blair Caregiver"), expect.stringContaining("Casey Caregiver")]);
    expect(row).toHaveTextContent("Casey Caregiver: score incomplete"); // score completeness lives in Details
    expect(row).not.toHaveTextContent("you still confirm the assignment");
    expect(row).toHaveTextContent("Suggested");
    const match = calls.find((c) => c.path === "/v1/matching/candidates")!;
    expect(match.body).toMatchObject({ organizationId: expect.any(String), serviceId: "sv1", clientId: "c1", intervals: [{ startsAt: open.startsAt, endsAt: open.endsAt }] });
    fireEvent.click(within(items[0]!).getByRole("button", { name: /^Select Blair/ }));
    expect((screen.getByLabelText("Caregiver") as HTMLSelectElement).value).toBe("r2");
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/caregiver"))).toHaveLength(0); // nothing is assigned until the office confirms
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Why" }));
    expect(within(row).getByText(/availability: 50 of 50: free/)).toBeInTheDocument();
  }, 30000);

  it("no eligible caregiver says so and leaves the shift flagged; a failed lookup does not block choosing by hand", async () => {
    const open = shift("open2", { coverageState: "needs_coverage", caregiverRecordId: null, caregiverName: null, caregiverCode: null });
    renderAws(`/schedule?coverage=1&shift=open2`, PERMS, {
      "GET /v1/shifts": () => json(200, { shifts: [open] }),
      "GET /v1/caregivers": () => json(200, { caregivers: [] }),
      "POST /v1/matching/candidates": () => json(200, { matches: { ...candidates.matches, candidates: [candidates.matches.candidates[2]] } }),
    });
    expect(await screen.findByTestId("no-eligible", {}, { timeout: 15000 })).toHaveTextContent("The shift stays flagged");
    cleanup();
    renderAws(`/schedule?coverage=1&shift=open2`, PERMS, { "GET /v1/shifts": () => json(200, { shifts: [open] }), "GET /v1/caregivers": () => json(200, { caregivers: [] }), "POST /v1/matching/candidates": () => json(500, { error: { code: "internal_error", message: "Something went wrong." } }) });
    expect(await screen.findByTestId("suggestions-error", {}, { timeout: 15000 })).toHaveTextContent("You can still choose a caregiver below");
    expect(screen.getByLabelText("Caregiver")).toBeInTheDocument();
  }, 30000);

  it("Add shift for a client fills in the one authorized service and the one assigned caregiver, says so, and changes nothing the person already chose", async () => {
    renderAws("/schedule?add=1&client=c1", PERMS, {
      "GET /v1/shifts": () => json(200, { shifts: [] }),
      "GET /v1/clients": () => json(200, { clients: [{ clientId: "c1", clientCode: "CL-1", caregiverDisplayCode: null, status: "active", legalFirstName: "Client", legalLastName: "One", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizationCount: 1 }] }),
      "GET /v1/services": () => json(200, { services: [{ serviceId: "sv1", code: "PCS", name: "Personal care", isActive: true }, { serviceId: "sv2", code: "RSP", name: "Respite", isActive: true }] }),
      "GET /v1/clients/c1/authorizations": () => json(200, { authorizations: [{ authorizationId: "a1", lineageId: "a1", versionNumber: 1, isCurrent: true, serviceId: "sv1", serviceCode: "PCS", serviceName: "Personal care", payer: "P", authorizationNumber: null, monthlyAuthorizedMinutes: 600, periodStart: "2026-01-01", periodEnd: "2099-12-31", receivedDate: null, sourceReference: null, changeReason: null, createdAt: "2026-01-01T00:00:00Z", createdByName: null, hourlyRateCents: null }] }),
      "GET /v1/assignments": () => json(200, { assignments: [{ assignmentId: "as1", caregiverRecordId: "r1", caregiverCode: "CG-1", caregiverName: "Alex Caregiver", clientId: "c1", clientCode: "CL-1", clientName: null, serviceId: "sv1", serviceCode: "PCS", serviceName: "Personal care", effectiveStart: "2026-01-01", effectiveEnd: null, state: "current", hasAuthorization: true }] }),
      "GET /v1/caregivers": () => json(200, { caregivers: [{ caregiverRecordId: "r1", caregiverCode: "CG-1", firstName: "Alex", lastName: "Caregiver", preferredName: null, status: "active", hasSignIn: true }] }),
    });
    const note = await screen.findByTestId("prefill-note", {}, { timeout: 15000 });
    expect(note).toHaveTextContent("Filled in from the client's record: service and caregiver");
    expect((screen.getByLabelText("Service") as HTMLSelectElement).value).toBe("sv1");
    expect((screen.getByLabelText(/Caregiver \(optional\)/) as HTMLSelectElement).value).toBe("r1");
    const options = within(screen.getByLabelText("Service")).getAllByRole("option").map((o) => o.textContent);
    expect(options).not.toContain("Respite (RSP)"); // only what the client is authorized for
  }, 30000);
});
