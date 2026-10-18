/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies are free-form JSON */
// The client page (Board 2): authorization first, alerts with links and resolved history, three primary actions with the rest under More, the next three visits, compact caregivers,
// readiness with holds, documents (upload is not approval), read-only details with a duplicate warning, the audit timeline and the guided renewal. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const SERVICE = "dddddddd-0000-4000-8000-000000000001";
const AUTH1 = "a1a1a1a1-0000-4000-8000-000000000001";
const OWNER = ["authorizations.read", "authorizations.update", "clients.manage", "clients.names.manage", "clients.names.read", "visits.manage", "visits.read", "shifts.manage", "documents.read", "documents.manage", "organization.update"];
const soon = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
afterEach(() => cleanup());

const client = { clientId: CLIENT, clientCode: "CL-ABCDEF1234", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client Alpha", city: "Riverside", clientTypeId: null, clientTypeName: null, currentAuthorizationCount: 1 };
const version = (over: Record<string, unknown> = {}) => ({ authorizationId: AUTH1, lineageId: AUTH1, versionNumber: 1, isCurrent: true, serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care", payer: "Synthetic Regional Center",
  authorizationNumber: "SYN-1", monthlyAuthorizedMinutes: 1800, periodStart: "2026-01-01", periodEnd: "2026-12-31", receivedDate: null, sourceReference: null, changeReason: "Created", createdAt: "2026-01-01T00:00:00Z", createdByName: "Morgan Manager", hourlyRateCents: null, ...over });
const base = (extra: Record<string, ReturnType<typeof Object>> = {}) => ({
  "GET /v1/clients": () => json(200, { clients: [client] }),
  [`GET /v1/clients/${CLIENT}/authorizations`]: () => json(200, { authorizations: [version()] }),
  "GET /v1/reports/monthly-service-summary": () => json(200, { services: [] }),
  "GET /v1/assignments": () => json(200, { assignments: [] }),
  "GET /v1/services": () => json(200, { services: [{ serviceId: SERVICE, code: "862", name: "Respite Care", isActive: true }] }),
  [`GET /v1/clients/${CLIENT}/documents`]: () => json(200, { documents: [] }),
  [`GET /v1/clients/${CLIENT}/issue-history`]: () => json(200, { history: { resolved: [] } }),
  ...extra,
}) as Record<string, (c: { url: URL; body: Record<string, any> | null }) => Response | undefined>;
const readiness = (over: Record<string, unknown> = {}) => ({ readiness: { clientId: CLIENT, status: "active", stage: "active", stageNote: null, canSchedule: true, ready: true, services: [], ...over } });

describe("alerts, actions, next visits, caregivers", () => {
  it("authorization comes first; alerts link to the workflow with the client; resolved alerts stay as history; three primary actions and the rest under More", async () => {
    renderAws(`/clients/${CLIENT}`, OWNER, base({
      "GET /v1/action-issues": () => json(200, { asOf: new Date().toISOString(), matching: 1, limit: 50, offset: 0, counts: { total: 1, critical: 1, urgent: 0, routine: 0, actionNeeded: 1, byQueue: {} },
        issues: [{ issueKey: "k1", kind: "shift", reason: "uncovered_open", queue: "needs_attention_now", category: "coverage", severity: "critical", deadline: soon(-1), since: null, shiftId: "s1", visitId: null, entityId: "s1", caregiverRecordId: null, clientId: CLIENT, serviceId: SERVICE,
          clientCode: "CL-1", caregiverCode: null, serviceCode: "862", status: "open", firstSeenAt: null, reopenCount: 0, action: "assign_caregiver", recommendedAction: "Choose an eligible caregiver and confirm the assignment." }] }),
      [`GET /v1/clients/${CLIENT}/issue-history`]: () => json(200, { history: { resolved: [{ issueKey: "old", kind: "visit", reason: "confirmation_overdue", firstSeenAt: soon(-100), resolvedAt: soon(-50), reopenCount: 0 }] } }),
      [`GET /v1/clients/${CLIENT}/readiness`]: () => json(200, readiness()),
    }));
    const alert = await screen.findByTestId("client-alert", {}, { timeout: 15000 });
    expect(within(alert).getByText("Critical")).toBeInTheDocument();
    expect(within(alert).getByRole("link", { name: "Choose a caregiver" })).toHaveAttribute("href", expect.stringMatching(new RegExp(`^/schedule\\?coverage=1&shift=s1&at=.+&client=${CLIENT}$`)));
    const history = await screen.findByTestId("client-alert-history");
    expect(history).toHaveTextContent("Resolved alerts (1)");
    const nav = screen.getByRole("navigation", { name: "Client actions" });
    expect(within(nav).getByRole("link", { name: "Schedule Visit" })).toHaveAttribute("href", `/schedule?add=1&client=${CLIENT}`);
    expect(within(nav).getByRole("link", { name: "View Authorization" })).toHaveAttribute("href", "#authorizations");
    expect(within(nav).getByRole("link", { name: "Verify Visit" })).toHaveAttribute("href", `/visit-review?client=${CLIENT}`);
    expect(within(nav).getByText("More")).toBeInTheDocument();
    // authorization is above the schedule, caregivers and details
    const order = ["Authorizations", "Next visits", "Caregivers", "Readiness", "Documents", "Details"].map((t) => screen.getByRole("heading", { name: t }));
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }, 30000);

  it("lists the next three visits with date, time, caregiver and status, and a link to the full schedule; compact caregivers show name, status and next visit and open the tools on selection", async () => {
    const shift = (n: number, covered = true) => ({ shiftId: `s${n}`, startsAt: soon(24 * n), endsAt: soon(24 * n + 2), localDate: "2026-10-20", coverageState: covered ? "covered" : "needs_coverage", clientId: CLIENT, clientCode: "CL-1", clientName: "Client", serviceName: "Respite Care", serviceCode: "862",
      caregiverRecordId: covered ? "r1" : null, caregiverCode: "CG-1", caregiverName: covered ? "Alex Caregiver" : null, hasSignIn: false, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null });
    renderAws(`/clients/${CLIENT}`, OWNER, base({
      "GET /v1/shifts": () => json(200, { shifts: [shift(1), shift(2, false), shift(3), shift(4)] }),
      "GET /v1/assignments": () => json(200, { assignments: [{ assignmentId: "as1", caregiverRecordId: "r1", caregiverCode: "CG-1", caregiverName: "Alex Caregiver", clientId: CLIENT, clientCode: "CL-1", clientName: null, serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care", effectiveStart: "2026-01-01", effectiveEnd: null, state: "current", hasAuthorization: true }] }),
      [`GET /v1/clients/${CLIENT}/readiness`]: () => json(200, readiness()),
    }));
    const next = await screen.findByTestId("next-visits", {}, { timeout: 15000 });
    await waitFor(() => expect(within(next).getAllByTestId("next-visit")).toHaveLength(3));
    expect(within(next).getAllByTestId("next-visit")[1]).toHaveTextContent("No caregiver");
    expect(within(next).getByRole("link", { name: "Full schedule" })).toHaveAttribute("href", `/schedule?client=${CLIENT}`);
    const row = await screen.findByTestId("caregiver-summary-row");
    expect(row).toHaveTextContent("Alex Caregiver");
    expect(row).toHaveTextContent("Assigned");
    expect(row).toHaveTextContent("Next visit");
    expect(screen.queryByRole("heading", { name: "Caregivers assigned" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Assignment details" }));
    expect(await screen.findByRole("heading", { name: "Caregivers assigned" })).toBeInTheDocument();
  }, 30000);
});

describe("details are read-only until edited; a same-name client needs a confirmation", () => {
  it("shows the details read-only, opens the form on Edit with an impact note, and refuses a duplicate name until it is confirmed different", async () => {
    const { calls } = renderAws(`/clients/${CLIENT}`, OWNER, base({
      [`GET /v1/clients/${CLIENT}/readiness`]: () => json(200, readiness()),
      "GET /v1/client-duplicates": () => json(200, { matches: [{ clientId: "other", clientCode: "CL-OTHER", firstName: "Maria", lastName: "Dup", status: "active", match: "same_name" }] }),
      [`POST /v1/clients/${CLIENT}/details`]: () => json(200, { ok: true }),
    }));
    const ro = await screen.findByTestId("details-readonly", {}, { timeout: 15000 });
    expect(ro).toHaveTextContent("Synthetic Client Alpha");
    expect(screen.queryByLabelText("First name")).not.toBeInTheDocument();
    fireEvent.click(within(ro).getByRole("button", { name: "Edit details" }));
    expect(await screen.findByTestId("edit-impact")).toHaveTextContent("recorded in the client");
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Maria" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Dup" } });
    const warn = await screen.findByTestId("duplicate-warning");
    expect(warn).toHaveTextContent("A client with this name already exists");
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Confirm it is a different person");
    expect(calls.filter((c) => c.path === `/v1/clients/${CLIENT}/details`)).toHaveLength(0);
    fireEvent.click(within(warn).getByLabelText("This is a different person"));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === `/v1/clients/${CLIENT}/details`)).toHaveLength(1));
    expect(await screen.findByTestId("details-readonly")).toBeInTheDocument();
  }, 30000);
});

describe("readiness, holds and documents", () => {
  const needs = readiness({ stage: "draft", canSchedule: false, ready: false, services: [{ serviceId: SERVICE, serviceName: "Respite Care", unmet: 1, state: "needs_documents", authorization: { periodStart: "2026-01-01", periodEnd: "2026-12-31", state: "valid" }, requirements: [{ documentTypeId: "t1", name: "Consent to care", state: "pending_review" }], hold: null }] });
  it("a draft client says it cannot be scheduled, lists the unmet requirement and activates through the server (which may refuse)", async () => {
    const { calls } = renderAws(`/clients/${CLIENT}`, OWNER, base({
      [`GET /v1/clients/${CLIENT}/readiness`]: () => json(200, needs),
      [`POST /v1/clients/${CLIENT}/stage`]: () => json(409, { error: { code: "conflict", message: "This client cannot be activated yet: 1 service requirement(s) are not approved or a service is on hold" } }),
    }));
    const card = await screen.findByTestId("readiness-card", {}, { timeout: 15000 });
    expect(within(card).getByTestId("client-stage")).toHaveTextContent("Draft");
    expect(card).toHaveTextContent("Cannot be scheduled until it is activated");
    expect(card).toHaveTextContent("Consent to care: pending review");
    fireEvent.click(within(card).getByRole("button", { name: "Activate" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("cannot be activated yet");
    expect(calls.find((c) => c.method === "POST" && c.path === `/v1/clients/${CLIENT}/stage`)?.body).toMatchObject({ organizationId: expect.any(String), stage: "active" });
  }, 30000);

  it("a service hold needs a reason and says other services are not affected; an open hold shows who and why and is released with a note", async () => {
    let held = false;
    const svc = () => ({ serviceId: SERVICE, serviceName: "Respite Care", unmet: 0, state: held ? "held" : "ready", authorization: { periodStart: "2026-01-01", periodEnd: "2026-12-31", state: "valid" }, requirements: [],
      hold: held ? { holdId: "h1", reason: "The family asked for a pause", openedAt: soon(-5), openedByName: "Morgan Manager" } : null });
    const { calls } = renderAws(`/clients/${CLIENT}`, OWNER, base({
      [`GET /v1/clients/${CLIENT}/readiness`]: () => json(200, readiness({ services: [svc()] })),
      [`POST /v1/clients/${CLIENT}/service-holds`]: () => { held = true; return json(201, { holdId: "h1" }); },
      "POST /v1/client-service-holds/h1/release": () => { held = false; return json(200, { holdId: "h1" }); },
    }));
    const card = await screen.findByTestId("readiness-card", {}, { timeout: 15000 });
    fireEvent.click(await within(card).findByRole("button", { name: "Place this service on hold…" }));
    fireEvent.click(within(card).getByRole("button", { name: "Place on hold" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("at least 10 characters");
    fireEvent.change(within(card).getByLabelText("Why is this service on hold?"), { target: { value: "The family asked for a pause" } });
    fireEvent.click(within(card).getByRole("button", { name: "Place on hold" }));
    expect(await within(card).findByRole("status")).toHaveTextContent("other services are not affected");
    const hold = await within(card).findByTestId("service-hold");
    expect(hold).toHaveTextContent("The family asked for a pause");
    fireEvent.click(within(hold).getByRole("button", { name: "Release the hold…" }));
    fireEvent.change(within(card).getByLabelText(/What did you check/), { target: { value: "Spoke with the family today" } });
    fireEvent.click(within(card).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/client-service-holds/h1/release" && c.body?.note === "Spoke with the family today")).toBe(true));
  }, 30000);

  it("documents show Missing, Pending review (uploading is not approval), Approved, Expired and Rejected; upload needs a file and the expiry date when the type needs one", async () => {
    const doc = (state: string, over: Record<string, unknown> = {}) => ({ documentTypeId: `t-${state}`, name: `Doc ${state}`, category: "consent", requiresExpiry: state === "expired", state, requiredFor: [{ serviceId: SERVICE, serviceName: "Respite Care" }], documentId: state === "missing" ? null : `d-${state}`,
      latestVersionId: state === "missing" ? null : `v-${state}`, versionNumber: state === "missing" ? null : 1, uploadedAt: soon(-24), uploadedByName: "Morgan Manager", issuedOn: null, expiresOn: state === "expired" ? "2026-01-01" : null, reviewedByName: null, reviewedAt: null, rejectionReason: state === "rejected" ? "Signature page missing" : null, versionCount: state === "missing" ? null : 1, ...over });
    const { calls } = renderAws(`/clients/${CLIENT}`, OWNER, base({
      [`GET /v1/clients/${CLIENT}/readiness`]: () => json(200, readiness()),
      [`GET /v1/clients/${CLIENT}/documents`]: () => json(200, { documents: ["missing", "pending_review", "approved", "expired", "rejected"].map((s) => doc(s)) }),
      "POST /v1/client-document-versions/v-pending_review/review": () => json(200, { decision: "verified" }),
    }));
    const box = await screen.findByTestId("client-documents", {}, { timeout: 15000 });
    const rows = await within(box).findAllByTestId("client-document");
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["missing", "pending_review", "approved", "expired", "rejected"]);
    expect(rows[1]).toHaveTextContent("Uploading is not approval");
    expect(rows[4]).toHaveTextContent("Rejected: Signature page missing");
    fireEvent.click(within(rows[3]!).getByRole("button", { name: "Upload a new version" }));
    fireEvent.click(within(rows[3]!).getByRole("button", { name: "Upload" }));
    expect(await within(rows[3]!).findByRole("alert")).toHaveTextContent("Choose a photo or PDF");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Review…" }));
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Reject" }));
    expect(await within(rows[1]!).findByRole("alert")).toHaveTextContent("Write why it is rejected");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/client-document-versions/v-pending_review/review" && c.body?.decision === "verified")).toBe(true));
  }, 30000);

  it("a caregiver-level role sees no documents card", async () => {
    renderAws(`/clients/${CLIENT}`, ["clients.names.read", "visits.read"], base({ [`GET /v1/clients/${CLIENT}/readiness`]: () => json(200, readiness()) }));
    await screen.findByTestId("readiness-card", {}, { timeout: 15000 });
    expect(screen.queryByTestId("client-documents")).not.toBeInTheDocument();
  }, 30000);
});

describe("history and renewal", () => {
  it("the history shows who changed what without values; an ended authorization offers a guided renewal that starts the day after it ended and says nothing is restored automatically", async () => {
    renderAws(`/clients/${CLIENT}`, OWNER, base({
      [`GET /v1/clients/${CLIENT}/readiness`]: () => json(200, readiness()),
      [`GET /v1/clients/${CLIENT}/authorizations`]: () => json(200, { authorizations: [version({ periodEnd: "2026-03-31" })] }),
      [`GET /v1/clients/${CLIENT}/audit`]: () => json(200, { events: [{ occurredAt: soon(-3), action: "client.updated", actorName: "Morgan Manager", reason: null, fields: ["city", "client_type_id"] }] }),
    }));
    fireEvent.click(await screen.findByRole("button", { name: "History and audit trail" }, { timeout: 15000 }));
    const hist = await screen.findByTestId("client-history");
    await waitFor(() => expect(hist).toHaveTextContent("client updated · Morgan Manager · changed: city, client type id"));
    expect(hist).toHaveTextContent("never the values");
    fireEvent.click(await screen.findByTestId("renew-authorization"));
    expect(await screen.findByTestId("renewal-steps")).toHaveTextContent("Nothing that was held or scheduled is restored or released automatically");
    expect((screen.getByLabelText(/Start date/) as HTMLInputElement).value).toBe("2026-04-01");
  }, 30000);
});
