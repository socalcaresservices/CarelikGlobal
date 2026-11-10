/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies are free-form JSON */
// Accounting screens (0067-0070): shifts that ended with no visit, authorization changes to review, the full-chain report. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const SHIFT = "51515151-0000-4000-8000-000000000001";
const IMPACT = "61616161-0000-4000-8000-000000000001";
type Call = { method: string; path: string; body: Record<string, any> | null; key: string | null };
const later = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();

function renderAt(path: string, permissions: string[], extra: Record<string, (body: any) => Response | undefined> = {}) {
  const calls: Call[] = [];
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  let reconciled = false;
  let acked = false;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, any> | null;
    const key = new Headers(init?.headers).get("idempotency-key");
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body, key });
    const handler = extra[`${method} ${url.pathname}`];
    const custom = handler?.(body);
    if (custom) return custom;
    switch (`${method} ${url.pathname}`) {
      case "GET /v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions }], profile: { displayName: "Morgan Manager" } });
      case "GET /v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention": return json(200, { summary: null });
      case "GET /v1/action-issues": return json(200, { asOf: new Date().toISOString(), matching: 0, limit: 50, offset: 0, counts: { total: 0, critical: 0, urgent: 0, routine: 0, actionNeeded: 0 }, issues: [] });
      case "GET /v1/attention/overview": return json(200, { overview: { asOf: new Date().toISOString(), urgentWindowHours: 48, urgent: null, upcoming: { count: 0, nextStartsAt: null, shifts: [] }, documents: null, visitReview: null,
        reconciliation: { count: 1, minutes: 90, oldestEndedAt: later(-5) }, amendmentImpacts: { count: 2, oldestAt: later(-30) } } });
      case "GET /v1/shifts": return json(200, { shifts: [] });
      case "GET /v1/clients": return json(200, { clients: [] });
      case "GET /v1/services": return json(200, { services: [] });
      case "GET /v1/caregivers": return json(200, { caregivers: [] });
      case "GET /v1/shift-series": return json(200, { series: [] });
      case "GET /v1/shift-pickups": return json(200, { requests: [] });
      case "GET /v1/work-hour-policy": return json(200, { policy: { applies: false } });
      case "GET /v1/hour-limits": return json(200, { limits: [] });
      case "GET /v1/shifts-to-reconcile":
        return json(200, { shifts: reconciled ? [] : [{ shiftId: SHIFT, reservationId: "r1", startsAt: later(-8), endsAt: later(-6), localDate: "2026-10-17", clientCode: "CL-1", serviceCode: "PCS", serviceName: "Personal care",
          caregiverCode: "CG-1", reservedMinutes: 90, bucket: "unreconciled", endedHours: 6, lastOutcome: null, lastNote: null, lastDecidedAt: null }] });
      case `POST /v1/shifts/${SHIFT}/reconcile`: reconciled = true; return json(200, { reconciliation: { outcome: body?.outcome, released: body?.outcome === "no_service_delivered", reservedMinutes: 90 } });
      case "GET /v1/authorization-impacts":
        return json(200, { impacts: acked && url.searchParams.get("includeAcknowledged") !== "true" ? [] : [{ impactId: IMPACT, createdAt: later(-3), impactKind: "reserved_shift_over_cap", clientCode: "CL-1", serviceCode: "PCS", serviceName: "Personal care", newVersionNumber: 2,
          newMonthlyMinutes: 120, shiftId: SHIFT, shiftStartsAt: later(30), shiftEndsAt: later(32), visitId: null, serviceDate: "2026-10-20", minutes: 120, bucket: "ahead", stillApplicable: true,
          acknowledgedAt: acked ? later(-1) : null, acknowledgedByName: acked ? "Morgan Manager" : null, acknowledgementNote: acked ? body?.note ?? "Moved it" : null, amendedByName: "Olivia Owner" }] });
      case `POST /v1/authorization-impacts/${IMPACT}/acknowledge`: acked = true; return json(200, { acknowledgement: { impactId: IMPACT, acknowledged: true } });
      default: return json(404, { error: { code: "not_found", message: `No such endpoint: ${method} ${url.pathname}` } });
    }
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "m@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { calls };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("shifts that ended with no visit record", () => {
  it("are listed with the reserved time, and releasing needs a note, sends one keyed request, and says what happened", async () => {
    const { calls } = renderAt("/schedule", ["shifts.manage", "visits.read", "clients.names.read"]);
    const panel = await screen.findByTestId("shifts-to-reconcile", {}, { timeout: 15000 });
    expect(screen.getByRole("heading", { name: "Past: need review (1)" })).toBeInTheDocument();
    expect(within(screen.getByTestId("page-help-panel")).getByText(/Nothing is released automatically/)).toBeInTheDocument();
    expect(within(panel).getByText(/1 hr 30 min reserved/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Save" })).toBeDisabled(); // nothing chosen yet
    fireEvent.click(within(panel).getByRole("radio", { name: "No service was delivered" }));
    expect(within(panel).getByText("Releases the reserved authorization time.")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Note too short");
    expect(posts(calls, `/v1/shifts/${SHIFT}/reconcile`)).toHaveLength(0);
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: "Called the family and the caregiver; nobody went" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts(calls, `/v1/shifts/${SHIFT}/reconcile`)).toHaveLength(1));
    const sent = posts(calls, `/v1/shifts/${SHIFT}/reconcile`)[0]!;
    expect(sent.body).toMatchObject({ organizationId: ORG, outcome: "no_service_delivered", note: "Called the family and the caregiver; nobody went" });
    expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByTestId("shifts-to-reconcile")).not.toBeInTheDocument());
    expect(await screen.findByText(/of authorization were released for that shift/)).toBeInTheDocument();
  }, 30000);

  it("'I cannot confirm yet' keeps it reserved and says so", async () => {
    const { calls } = renderAt("/schedule", ["shifts.manage", "visits.read"]);
    const panel = await screen.findByTestId("shifts-to-reconcile", {}, { timeout: 15000 });
    fireEvent.click(within(panel).getByRole("radio", { name: "I cannot confirm yet" }));
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: "Caregiver says she went; waiting for the family" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts(calls, `/v1/shifts/${SHIFT}/reconcile`)[0]?.body).toMatchObject({ outcome: "hold_service_may_have_occurred" }));
    expect(await screen.findByText(/The time stays reserved and counted until you decide/)).toBeInTheDocument();
  }, 30000);

  it("a role without shift management never sees the panel or asks for the list", async () => {
    const { calls } = renderAt("/schedule", ["visits.read"]);
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/branding")).toBe(true), { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("shifts-to-reconcile")).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === "/v1/shifts-to-reconcile")).toBe(false);
  }, 30000);

  it("the staffing page tells the office about them and about unacknowledged authorization changes, with links", async () => {
    renderAt("/staffing", ["shifts.manage", "visits.read", "authorizations.update"]);
    const link = await screen.findByTestId("reconcile-link", {}, { timeout: 15000 });
    expect(link).toHaveTextContent("1 shift ended with no visit record");
    expect(link).toHaveTextContent("It still holds 1 hr 30 min of authorization. Nothing is released until you decide.");
    expect(within(link).getByRole("link", { name: "Reconcile shifts" })).toHaveAttribute("href", "/schedule");
    expect(screen.getByTestId("amendment-impacts-link")).toHaveTextContent("2 items affected by an authorization change");
    expect(screen.getByTestId("amendment-impacts-link")).toHaveTextContent("They need your review.");
  }, 30000);
});

describe("authorization changes to review", () => {
  it("lists what the amendment affected, says nothing was changed, and acknowledging needs a note", async () => {
    const { calls } = renderAt("/authorization-impacts", ["authorizations.update", "shifts.manage"]);
    const item = await screen.findByTestId("amendment-impact", {}, { timeout: 15000 });
    const group = screen.getByTestId("amendment-group");
    expect(within(group).getByRole("heading", { level: 2 })).toHaveTextContent("Client CL-1 · Personal care · version 2 (2 hr a month)");
    expect(group).toHaveTextContent("Amended by Olivia Owner");
    expect(item).toHaveTextContent("This reserved shift no longer fits the new monthly limit.");
    expect(item).not.toHaveTextContent("Amended by");
    expect(screen.getByText(/changed, released and re-billed nothing/)).toBeInTheDocument();
    fireEvent.click(within(item).getByRole("button", { name: "Acknowledge…" }));
    fireEvent.click(within(item).getByRole("button", { name: "Acknowledge" }));
    expect(await within(item).findByRole("alert")).toHaveTextContent("Write what you did or decided");
    expect(posts(calls, `/v1/authorization-impacts/${IMPACT}/acknowledge`)).toHaveLength(0);
    fireEvent.change(within(item).getByRole("textbox"), { target: { value: "Moved the shift to next month" } });
    fireEvent.click(within(item).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(posts(calls, `/v1/authorization-impacts/${IMPACT}/acknowledge`)[0]?.body).toMatchObject({ organizationId: ORG, note: "Moved the shift to next month" }));
    await waitFor(() => expect(screen.queryByTestId("amendment-impact")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Nothing to review.");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(await screen.findByText(/Acknowledged by Morgan Manager/)).toBeInTheDocument();
  }, 30000);

  it("a role without the permission is told so and nothing is requested", async () => {
    const { calls } = renderAt("/authorization-impacts", ["visits.read"]);
    expect(await screen.findByText("You do not have access to authorization changes.", {}, { timeout: 15000 })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/v1/authorization-impacts")).toBe(false);
  }, 30000);
});

describe("delivered but not verified (0071)", () => {
  const awaiting = (outcome: string) => ({ shifts: [{ shiftId: SHIFT, reservationId: "r1", startsAt: later(-8), endsAt: later(-6), localDate: "2026-10-17", clientCode: "CL-1", serviceCode: "PCS", serviceName: "Personal care",
    caregiverCode: "CG-1", reservedMinutes: 90, bucket: "awaiting_record", endedHours: 6, lastOutcome: outcome, lastNote: "Family says she came; no clock-in", lastDecidedAt: later(-1) }] });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("offers a third outcome that sends delivered_unverified with a note and says nothing is billable", async () => {
    const { calls } = renderAt("/schedule", ["shifts.manage", "visits.read"]);
    const panel = await screen.findByTestId("shifts-to-reconcile", {}, { timeout: 15000 });
    fireEvent.click(within(panel).getByRole("radio", { name: "It was delivered, but there is no verified visit" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Note too short");
    expect(posts(calls, `/v1/shifts/${SHIFT}/reconcile`)).toHaveLength(0);
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: "Family says she came; no clock-in" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts(calls, `/v1/shifts/${SHIFT}/reconcile`)[0]?.body).toMatchObject({ outcome: "delivered_unverified", note: "Family says she came; no clock-in" }));
    expect(await screen.findByText(/The time stays reserved and counted, and nothing is billable. No visit was created./)).toBeInTheDocument();
  }, 30000);

  it("a shift recorded as delivered stays listed, says it is not billable and has no visit, and cannot be recorded that way twice", async () => {
    renderAt("/schedule", ["shifts.manage", "visits.read"], { "GET /v1/shifts-to-reconcile": () => json(awaiting("delivered_unverified")) });
    const note = await screen.findByTestId("awaiting-note", {}, { timeout: 15000 });
    expect(note).toHaveTextContent("Delivered — not verified");
    expect(note).toHaveTextContent("Still reserved and counted. Not billable, and no visit exists.");
    expect(screen.queryByRole("radio", { name: "It was delivered, but there is no verified visit" })).not.toBeInTheDocument();
  }, 30000);

  it("authorization changes: an unapproved visit says it was sent back to review; an approved visit says it was not changed", async () => {
    const row = (id: string, state: string, review: boolean) => ({ impactId: id, createdAt: later(-3), impactKind: "visit_over_cap", clientCode: "CL-1", serviceCode: "PCS", serviceName: "Personal care", newVersionNumber: 3,
      newMonthlyMinutes: 60, shiftId: null, shiftStartsAt: null, shiftEndsAt: null, visitId: `v-${id}`, serviceDate: "2026-10-05", minutes: 90, bucket: null, stillApplicable: true,
      acknowledgedAt: null, acknowledgedByName: null, acknowledgementNote: null, amendedByName: "Olivia Owner", visitBillingState: state, reviewOpen: review, detail: null });
    renderAt("/authorization-impacts", ["authorizations.update", "shifts.manage"], { "GET /v1/authorization-impacts": () => json({ impacts: [row("a1", "needs_correction", true), row("a2", "approved_for_billing", false)] }) });
    const items = await screen.findAllByTestId("amendment-impact", {}, { timeout: 15000 });
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByTestId("sent-back")).toHaveTextContent("sent back to review (Needs Correction)");
    expect(within(items[1]!).getByTestId("approved-unchanged")).toHaveTextContent("already approved for billing. It was not changed");
    expect(within(items[0]!).getByText("A confirmed visit now goes past the lowered monthly limit.")).toBeInTheDocument();
  }, 30000);

  it("the visit page shows the authorization-review card, requires a note, and confirms with one keyed request", async () => {
    const V = "77777777-0000-4000-8000-0000000000aa";
    let resolved = false;
    const rev = () => ({ review: { open: !resolved, reviews: [{ reviewId: "rv1", reason: "authorization_over_cap", billableMinutes: 90, excessMinutes: 30, newMonthlyMinutes: 60, openedAt: later(-3), openedByName: "Olivia Owner",
      resolvedAt: resolved ? later(-1) : null, resolution: resolved ? "confirmed_billable" : null, resolutionNote: resolved ? "Checked the new letter" : null, resolvedByName: resolved ? "Morgan Manager" : null }] } });
    const { calls } = renderAt(`/visits/${V}`, ["visits.manage", "visits.read", "billing.approve"], {
      [`GET /v1/visits/${V}/review`]: () => json({ visit: { visitId: V, organizationId: ORG, visitNumber: "CL1-PCS-001", visitStatus: "verified", clientId: "c1", clientCode: "CL-1", clientName: "Synthetic Client", caregiverName: "Pilot Caregiver",
        serviceCode: "PCS", serviceName: "Personal care", serviceDate: "2026-10-05", timeIn: "2026-10-05T16:00:00Z", timeOut: "2026-10-05T17:30:00Z", workedMinutes: 90, verifiedMinutes: 90, billableMinutes: 90, authorizationStatus: "within_authorization",
        scheduledStartsAt: null, scheduledEndsAt: null, caregiverSchedulingMode: "fixed", confirmationMethod: "draw", signerRole: "client", signerName: null, signerRelationship: null, confirmationReason: null, confirmedAt: "2026-10-05T17:35:00Z",
        hasSignatureEvidence: true, isCorrection: false, reviewReasons: ["authorization_decreased"], decisionId: null, decision: null, decisionReason: null, decidedByName: null, decidedAt: null, activeBillingApprovalId: null, approvedMinutes: null,
        canDecide: true, allowedDecisions: [], recoveryState: null, canRequestConfirmation: false, decisionAcceptedMinutes: null } }),
      [`GET /v1/visits/${V}/confirmation-requests`]: () => json({ requests: [] }),
      [`GET /v1/visits/${V}/authorization-review`]: () => json(rev()),
      [`POST /v1/visits/${V}/authorization-review/resolve`]: () => { resolved = true; return json({ resolved: true }); },
    });
    const card = await screen.findByTestId("authorization-review", {}, { timeout: 15000 });
    expect(card).toHaveTextContent("The authorization was lowered after this visit was confirmed");
    expect(card).toHaveTextContent("The visit, its minutes and its signature were not changed.");
    fireEvent.click(within(card).getByRole("button", { name: "Confirm it is still billable" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("at least 10 characters");
    expect(posts(calls, `/v1/visits/${V}/authorization-review/resolve`)).toHaveLength(0);
    fireEvent.change(within(card).getByRole("textbox"), { target: { value: "Checked the new letter" } });
    fireEvent.click(within(card).getByRole("button", { name: "Confirm it is still billable" }));
    await waitFor(() => expect(posts(calls, `/v1/visits/${V}/authorization-review/resolve`)).toHaveLength(1));
    expect(posts(calls, `/v1/visits/${V}/authorization-review/resolve`)[0]).toMatchObject({ body: { organizationId: ORG, note: "Checked the new letter" } });
    expect(posts(calls, `/v1/visits/${V}/authorization-review/resolve`)[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/Confirmed still billable by Morgan Manager/)).toBeInTheDocument();
  }, 30000);
});
