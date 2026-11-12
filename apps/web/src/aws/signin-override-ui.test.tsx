/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies are free-form JSON */
// R10: the administrator override for a caregiver who has not signed in. The action, the required reason, the hard block on the background check, the badge on the
// profile, the Care Team list and the schedule, and the "not signed in" warning. The feature is released per environment: where the route does not exist the screens say nothing. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

const CG = "abababab-0000-4000-8000-000000000009";
afterEach(() => cleanup());
const item = (requirement: string, label: string, kind: string, state: string, detail: string, over: Record<string, unknown> = {}) =>
  ({ requirement, label, kind, state, detail, dueDate: null, metOn: null, actorName: null, blocksShifts: false, nextAction: "none", extra: {}, ...over });
const readiness = (o: { background?: boolean; override?: boolean } = {}) => ({ caregiverRecordId: CG, caregiverCode: "CG-NEW00001", status: "not_ready", approved: false, approvedAt: null, approvedByName: null, approvalSource: null, met: 2, total: 5, waitingOn: ["App sign-in"],
  canApprove: false, hireDate: "2026-10-01", graceDays: 30, cprTbDueDate: "2026-10-31", enforcementActive: false,
  items: [item("background", "Background check", "hard", o.background === false ? "unmet" : "met", o.background === false ? "Not started" : "Verified", { nextAction: o.background === false ? "verify" : "view" }),
    item("training", "Required training", "hard", "met", "Done", { nextAction: "reopen", extra: { requirementId: "r1" } }),
    o.override ? item("signin", "App sign-in", "hard", "met", "Approved by override: not signed in", { extra: { override: true } }) : item("signin", "App sign-in", "hard", "unmet", "Invited, has not signed in yet", { nextAction: "resend_link", extra: { lastSentAt: null, sendCount: 1 } }),
    item("cpr", "CPR certificate", "flexible", "pending", "Not uploaded", { nextAction: "upload" }), item("tb", "TB clearance", "flexible", "pending", "Not uploaded", { nextAction: "upload" })] });
const caregiver = { caregiverRecordId: CG, caregiverCode: "CG-NEW00001", firstName: "Synthetic", lastName: "Newcomer", preferredName: null, status: "onboarding", workStatus: "not_ready", readinessMet: 2, readinessTotal: 5, signedIn: false, hasContact: true,
  hasSignIn: false, signInStatus: null, activeAssignments: 1, plannedAssignments: 0, openVisits: 0, invitationEmail: null, invitedAt: null, invitationLastSentAt: null, invitationSendCount: null, firstSignedInAt: null };
const ADMIN = ["caregivers.manage", "visits.manage", "visits.read", "clients.names.read", "readiness.read", "caregivers.compliance.manage", "caregivers.signin_override", "shifts.manage"];
const MANAGER = ADMIN.filter((p) => p !== "caregivers.signin_override" && p !== "caregivers.compliance.manage");
const base = (r: object, overrides: object[] | "missing" = []) => ({
  "GET /v1/caregivers": () => json(200, { caregivers: [caregiver] }),
  [`GET /v1/caregivers/${CG}/readiness`]: () => json(200, { readiness: r }),
  "GET /v1/signin-overrides": () => overrides === "missing" ? json(404, { error: { code: "not_found", message: "No such endpoint." } }) : json(200, { overrides }),
});

describe("approve by override: the profile", () => {
  it("an administrator with a clear background check sees the action; an empty reason is refused in the browser and nothing is sent; a reason sends one request", async () => {
    const posts: any[] = [];
    const { calls } = renderAws(`/care-team/${CG}`, ADMIN, { ...base(readiness()), [`POST /v1/caregivers/${CG}/signin-override`]: ({ body }) => { posts.push(body); return json(201, { readiness: readiness({ override: true }) }); } }, "organization_owner");
    fireEvent.click(await screen.findByRole("button", { name: "Approve by override" }, { timeout: 15000 }));
    const form = screen.getByRole("form", { name: "Approve by override" });
    fireEvent.click(within(form).getByRole("button", { name: "Record override" }));
    expect(await screen.findByText(/Write why you are approving this caregiver/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Reason (required)"), { target: { value: "    " } });
    fireEvent.click(within(form).getByRole("button", { name: "Record override" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText("Reason (required)"), { target: { value: "Starts Monday; invitation sent (synthetic)" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record override" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ organizationId: expect.any(String), reason: "Starts Monday; invitation sent (synthetic)" });
    expect(await screen.findByText(/Approved by override\. It is recorded with your name/)).toBeInTheDocument();
  }, 30000);

  it("the background check is a hard block: with no clear check there is no button, only the reason", async () => {
    renderAws(`/care-team/${CG}`, ADMIN, base(readiness({ background: false })), "organization_owner");
    expect(await screen.findByTestId("override-needs-background", {}, { timeout: 15000 })).toHaveTextContent("There is no override for the background check");
    expect(screen.queryByRole("button", { name: "Approve by override" })).toBeNull();
  }, 30000);

  it("a manager (no sign-in override permission) never sees the action", async () => {
    renderAws(`/care-team/${CG}`, MANAGER, base(readiness()), "manager");
    await screen.findByText("Invited, has not signed in yet", {}, { timeout: 15000 });
    expect(screen.queryByRole("button", { name: "Approve by override" })).toBeNull();
    expect(screen.queryByTestId("override-needs-background")).toBeNull();
  }, 30000);

  it("an overridden caregiver shows the badge on the profile row and next to the name", async () => {
    renderAws(`/care-team/${CG}`, ADMIN, base(readiness({ override: true }), [{ caregiverRecordId: CG, approvedAt: new Date().toISOString(), approvedByName: "Olivia Owner", reason: "Reason (synthetic)" }]), "organization_owner");
    await screen.findByRole("heading", { name: /Synthetic Newcomer/ }, { timeout: 15000 });
    await waitFor(() => expect(screen.getAllByTestId("override-badge").length).toBeGreaterThanOrEqual(2));
    for (const b of screen.getAllByTestId("override-badge")) expect(b).toHaveTextContent("Approved by override — not signed in");
  }, 30000);
});

describe("the badge in the Care Team list, and where the feature is not released", () => {
  it("the Care Team list shows the badge for a caregiver with an override and no sign-in", async () => {
    renderAws("/care-team", ADMIN, base(readiness({ override: true }), [{ caregiverRecordId: CG, approvedAt: new Date().toISOString(), approvedByName: null, reason: null }]), "manager");
    expect(await screen.findByTestId("override-badge", {}, { timeout: 15000 })).toHaveTextContent("Approved by override — not signed in");
  }, 30000);

  it("where the route does not exist (the feature is not released) the screens show no badge and no error", async () => {
    renderAws("/care-team", ADMIN, base(readiness(), "missing"), "manager");
    await screen.findByText(/Synthetic Newcomer/, {}, { timeout: 15000 });
    expect(screen.queryByTestId("override-badge")).toBeNull();
    // other panels on the page may report their own unrelated loads; none may mention the override
    expect(screen.queryAllByRole("alert").filter((a) => /override|sign-in/i.test(a.textContent ?? ""))).toHaveLength(0);
  }, 30000);
});

describe("the schedule", () => {
  const at = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const shift = { shiftId: "s1", startsAt: at(3), endsAt: at(5), localDate: today, coverageState: "covered", clientId: "c1", clientCode: "CL-1", clientName: "Client One", serviceId: "sv1", serviceCode: "PCS", serviceName: "Personal care",
    caregiverRecordId: CG, caregiverCode: "CG-NEW00001", caregiverName: "Synthetic Newcomer", hasSignIn: false, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null };
  const schedule = (overrides: object[]) => ({ ...base(readiness(), overrides), "GET /v1/shifts": () => json(200, { shifts: [shift] }), "GET /v1/shifts-to-reconcile": () => json(200, { shifts: [] }), "GET /v1/shift-pickups": () => json(200, { requests: [] }) });

  it("a shift of an overridden caregiver carries the badge and the warning, and the exceptions panel lists the caregiver once with one action to send the sign-in link", async () => {
    renderAws("/schedule", ADMIN, schedule([{ caregiverRecordId: CG, approvedAt: new Date().toISOString(), approvedByName: null, reason: null }]), "organization_owner");
    expect(await screen.findByTestId("override-badge", {}, { timeout: 15000 })).toHaveTextContent("Approved by override — not signed in");
    expect(screen.getAllByTestId("cannot-verify")[0]).toHaveTextContent("Cannot verify a visit in Ogevia until they sign in.");
    const section = await screen.findByTestId("not-signed-in");
    expect(within(section).getByRole("heading", { name: "Not signed in (1)" })).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "Send sign-in link" })).toHaveAttribute("href", `/care-team/${CG}`);
    expect(screen.getByTestId("exceptions-panel")).toHaveTextContent(/1 not signed in/);
  }, 30000);

  it("a caregiver without a sign-in and without an override still shows the warning but no override badge", async () => {
    renderAws("/schedule", ADMIN, schedule([]), "organization_owner");
    await screen.findByTestId("not-signed-in", {}, { timeout: 15000 });
    expect(screen.queryByTestId("override-badge")).toBeNull();
    expect(screen.getAllByTestId("cannot-verify").length).toBeGreaterThan(0);
  }, 30000);
});
