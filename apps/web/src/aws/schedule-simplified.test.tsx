// The simplified schedule: counted groups first, compact rows, one overall outcome in the Add shift form, phone rows. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, renderAws } from "./test-support";

const PERMS = ["shifts.manage", "visits.manage", "visits.read", "clients.names.read", "matching.read", "authorizations.read"];
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const at = (h: number) => new Date(Date.now() + h * 3600e3);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const shift = (id: string, over: Record<string, unknown> = {}) => ({ shiftId: id, startsAt: at(3).toISOString(), endsAt: at(5).toISOString(), localDate: today, coverageState: "covered", clientId: "c1", clientCode: "CL-1", clientName: "Client One", serviceId: "sv1", serviceName: "Personal care", serviceCode: "PCS",
  caregiverRecordId: "r1", caregiverCode: "CG-1", caregiverName: "Alex Caregiver", hasSignIn: true, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null, ...over });
const open = (id: string) => shift(id, { coverageState: "needs_coverage", caregiverRecordId: null, caregiverName: null, caregiverCode: null });
const reconcile = { shiftId: "p1", reservationId: "r1", startsAt: at(-8).toISOString(), endsAt: at(-6).toISOString(), localDate: today, clientCode: "CL-1", serviceCode: "PCS", serviceName: "Personal care", caregiverCode: "CG-1", reservedMinutes: 120, bucket: "unreconciled", endedHours: 6, lastOutcome: null, lastNote: null, lastDecidedAt: null };

describe("shifts to reconcile are names-first (F01/I07)", () => {
  it("shows client and caregiver by name (code only for a shared name); without a visible name the codes stay", async () => {
    renderAws("/schedule", PERMS, {
      "GET /v1/shifts": () => json(200, { shifts: [] }),
      "GET /v1/shifts-to-reconcile": () => json(200, { shifts: [
        { ...reconcile, shiftId: "p1", clientName: "Dana Sample", duplicateName: true, caregiverName: "Alex Lee", caregiverDuplicateName: false },
        { ...reconcile, shiftId: "p2", reservationId: "r2" },
      ] }),
    });
    expect(await screen.findByRole("heading", { name: "Past: need review (2)" }, { timeout: 15000 })).toBeInTheDocument();
    const rows = (await screen.findAllByText(/reserved$/)).map((e) => e.textContent ?? "");
    expect(rows.some((t) => t.includes("Dana Sample (CL-1)") && t.includes("Alex Lee") && !t.includes("CG-1"))).toBe(true);
    expect(rows.some((t) => t.includes("Client CL-1") && t.includes("Caregiver CG-1"))).toBe(true);
  }, 30000);
});

describe("the schedule groups what needs attention", () => {
  it("counts upcoming shifts that need coverage and past shifts that need review separately, and lists each shift once", async () => {
    renderAws("/schedule", PERMS, {
      "GET /v1/shifts": () => json(200, { shifts: [open("a"), open("b"), shift("c")] }),
      "GET /v1/shifts-to-reconcile": () => json(200, { shifts: [reconcile] }),
    });
    expect(await screen.findByRole("heading", { name: "Unfilled (2)" }, { timeout: 15000 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Past: need review (1)" })).toBeInTheDocument();
    expect(screen.queryByText(/shifts? needs? coverage this/i)).toBeNull(); // the old red headline repeated the count
    const upcoming = screen.getByRole("table", { name: "Unfilled shifts" });
    expect(within(upcoming).getAllByRole("button", { name: /^Assign caregiver to shift for / })).toHaveLength(2);
    expect(screen.getAllByTestId("shift-state")).toHaveLength(3); // 2 uncovered + 1 covered, none twice
    // One primary action per row: the covered shift offers Record call-out, the rest is behind More actions.
    const coveredRow = screen.getByText(/Alex Caregiver/).closest("tbody")!;
    expect(within(coveredRow).getByRole("button", { name: "Record call-out" })).toBeInTheDocument();
    expect(within(coveredRow).queryByRole("button", { name: "Cancel shift" })).toBeNull();
    fireEvent.click(within(coveredRow).getByRole("button", { name: "More actions" }));
    for (const name of ["Change caregiver", "Change time", "Cancel shift", "History"]) expect(within(coveredRow).getByRole("button", { name })).toBeInTheDocument();
  }, 30000);

  it("Add shift is the one primary action; repeating is a choice inside its panel; the series list and the limits stay reachable under More", async () => {
    renderAws("/schedule", PERMS);
    expect(await screen.findByRole("button", { name: "Add shift" }, { timeout: 15000 })).toBeInTheDocument();
    for (const name of ["Manage repeating shifts", "Hours and limits"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Repeat visits" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add shift" }));
    const panel = await screen.findByRole("dialog", { name: "Add shift" });
    expect(within(panel).getByRole("button", { name: "Repeating" })).toBeInTheDocument();
  }, 30000);

  it("on a phone each shift is a compact row that opens, with the same actions inside", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: /max-width/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }));
    renderAws("/schedule", PERMS, { "GET /v1/shifts": () => json(200, { shifts: [open("a"), shift("c")] }) });
    const list = await screen.findByRole("list", { name: "Unfilled shifts" }, { timeout: 15000 });
    expect(screen.queryByRole("table")).toBeNull();
    const row = within(list).getAllByRole("listitem")[0]!;
    expect(row.querySelector("details summary")).not.toBeNull();
    expect(within(row).getByRole("button", { name: /^Assign caregiver to shift for / })).toBeInTheDocument();
  }, 30000);
});

describe("Add shift shows one overall outcome", () => {
  const checks = [
    { check: "availability", status: "ok", code: null, message: null, enforced: true, blocking: false },
    { check: "service", status: "ok", code: null, message: null, enforced: true, blocking: false },
    { check: "cpr", status: "blocked", code: "missing", message: "CPR missing.", enforced: false, blocking: false },
    { check: "tb", status: "ok", code: null, message: null, enforced: true, blocking: false },
    { check: "conflict", status: "ok", code: null, message: null, enforced: true, blocking: false },
  ];
  const handlers = (refuse: boolean) => ({
    "GET /v1/clients": () => json(200, { clients: [{ clientId: "c1", clientCode: "CL-1", caregiverDisplayCode: null, status: "active", legalFirstName: "Client", legalLastName: "One", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0 }] }),
    "GET /v1/services": () => json(200, { services: [{ serviceId: "sv1", code: "PCS", name: "Personal care", isActive: true }] }),
    "GET /v1/caregivers": () => json(200, { caregivers: [{ caregiverRecordId: "r1", caregiverCode: "CG-1", firstName: "Alex", lastName: "Caregiver", preferredName: null, status: "active", hasSignIn: true }] }),
    "POST /v1/readiness/evaluate": () => json(200, { evaluation: { startsAt: "2026-10-20T16:00:00Z", endsAt: "2026-10-20T19:00:00Z", ready: true, wouldBlockAfterActivation: true, outcome: "warning", summary: "Warning: CPR missing.", checks } }),
    "POST /v1/shifts": () => refuse ? json(422, { error: { code: "authorization_exhausted", message: "Not enough authorized time remains this month for this shift: 2 hr available, this shift needs 3 hr" } }) : json(201, { shift: { shiftId: "n", reservedMinutes: 180, remainingMinutes: "60" } }),
  });
  async function fill() {
    fireEvent.click(await screen.findByRole("button", { name: "Add shift" }, { timeout: 15000 }));
    await screen.findByRole("option", { name: /Client One/ });
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "c1" } });
    await screen.findByRole("option", { name: "Personal care (PCS)" });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "sv1" } });
    fireEvent.change(screen.getByLabelText(/Caregiver \(optional\)/), { target: { value: "r1" } });
  }

  it("before submitting: the server outcome is a Warning, shown first, and authorized time is confirmed when you schedule", async () => {
    renderAws("/schedule", PERMS, handlers(false));
    await fill();
    const panel = await screen.findByRole("region", { name: "Assignment checks" });
    expect(within(panel).getByTestId("assignment-outcome")).toHaveTextContent("Warning: CPR missing.");
    expect(within(panel).getByText("Authorized time is confirmed when you schedule.")).toBeInTheDocument();
    expect(within(panel).queryByText(/Assignment allowed/)).toBeNull();
    expect(screen.getByRole("button", { name: "Schedule shift" })).toBeEnabled();
  }, 30000);

  it("when the hour limit blocks, the outcome names it instead of a generic failed check, and the report-only warning is not the reason", async () => {
    const hoursBlocked = [
      ...checks.filter((c) => c.check !== "cpr" && c.check !== "service"),
      { check: "hours", status: "blocked", code: "daily_hour_limit", message: "Daily limit exceeded: 10.5 of 9 h", enforced: true, blocking: true },
      { check: "service", status: "blocked", code: "service_not_approved", message: "Service not approved", enforced: false, blocking: false },
    ];
    renderAws("/schedule", PERMS, { ...handlers(false), "POST /v1/readiness/evaluate": () => json(200, { evaluation: { startsAt: "2026-10-20T16:00:00Z", endsAt: "2026-10-20T19:00:00Z", ready: false, wouldBlockAfterActivation: true, outcome: "blocked", summary: "Blocked: Daily limit exceeded: 10.5 of 9 h", checks: hoursBlocked } }) });
    await fill();
    const panel = await screen.findByRole("region", { name: "Assignment checks" });
    expect(within(panel).getByTestId("assignment-outcome")).toHaveTextContent("Blocked: Daily limit exceeded: 10.5 of 9 h");
    expect(within(panel).queryByText(/Assignment allowed/)).toBeNull();
    expect(within(panel).queryByText("Not blocking yet.")).toBeNull(); // the note belongs to a Warning only
    expect(within(panel).getByText("Hours and limits:")).toBeInTheDocument();
  }, 30000);

  it("after an authorization refusal the outcome says Not scheduled, with how to fix it, and the caregiver checks no longer read as the result", async () => {
    const { calls } = renderAws("/schedule", PERMS, handlers(true));
    await fill();
    await screen.findByRole("region", { name: "Assignment checks" });
    fireEvent.click(screen.getByRole("button", { name: "Schedule shift" }));
    await waitFor(() => expect(screen.getByTestId("assignment-outcome")).toHaveTextContent("Not scheduled: not enough authorized time this month. Shorten the shift or ask for an authorization change."));
    const panel = screen.getByRole("region", { name: "Assignment checks" });
    expect(within(panel).getByText(/2 hr available, this shift needs 3 hr/)).toBeInTheDocument(); // the server's own figures stay
    expect(within(panel).queryByText("Authorized time is confirmed when you schedule.")).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/shifts")).toHaveLength(1);
  }, 30000);
});
