// Wave 1 UI (AWS build only): start with/without a schedule, verbal and declined confirmation, attestation, the open-shift pick-up,
// the review page wording for unscheduled / schedule-difference visits, and the visit-rules settings page.
// In-memory fake of the AWS API. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { ATTESTATION_TEXT, caregiverReasonText, describeOutcome, isUnscheduledReasonValid } from "@/lib/visit-outcome";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const SERVICE = "dddddddd-0000-4000-8000-000000000001";
const VISIT = "eeeeeeee-0000-4000-8000-000000000001";
const SHIFT = "55555555-0000-4000-8000-000000000001";
const SUB = "11111111-2222-4333-8444-555555555555";
type Call = { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null };
type Role = "caregiver" | "manager" | "organization_owner";

interface Opts { scheduled?: boolean; startNeedsReason?: boolean; pickup?: "ok" | "filled"; reviewKind?: "unscheduled" | "variance"; reviewer?: boolean }

function fakeApi(role: Role, opts: Opts = {}) {
  const calls: Call[] = [];
  let visit: Record<string, unknown> | null = null;
  let openShifts = [{ shiftId: SHIFT, startsAt: "2026-10-20T16:00:00Z", endsAt: "2026-10-20T18:00:00Z", minutes: 120, clientCode: "C-104", serviceName: "Respite Care", coverageState: "needs_coverage" }];
  let rules = [{ version: 0, minutes: 15, source: "system_default", effectiveFrom: null, changedByName: null, changedAt: null, reason: null, inEffect: true }] as Array<Record<string, unknown>>;
  const permissions = role === "organization_owner" ? ["organization.update", "visits.read", "visits.manage", "billing.visits.read"] : role === "manager" ? ["visits.read", "visits.manage", "billing.visits.read"] : ["availability.manage_own"];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, headers, body });
    switch (key) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName: "Synthetic Person" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: "#1f5f8b", logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case "GET /v1/reports/utilisation":
        return json(200, { services: [] });
      case "GET /v1/visits/active":
        return json(200, { visit });
      case "GET /v1/clients/assigned":
        return json(200, { clients: [{ clientId: CLIENT, clientCode: "C-104", nextScheduledStartsAt: opts.scheduled ? new Date(Date.now() + 5 * 60_000).toISOString() : null, nextScheduledEndsAt: opts.scheduled ? new Date(Date.now() + 125 * 60_000).toISOString() : null, activeServiceCount: 1, nextScheduledServiceId: opts.scheduled ? SERVICE : null }] });
      case `GET /v1/clients/${CLIENT}/services`:
        return json(200, { services: [{ serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care", serviceColor: null, authorizationId: "f0000000-0000-4000-8000-000000000001", monthlyAuthorizedMinutes: 6000, minutesUsedThisMonth: 1470, minutesScheduledThisMonth: 0 }] });
      case "POST /v1/visits":
        if (opts.startNeedsReason && !body?.unscheduledReason) return json(422, { error: { code: "validation_failed", message: "A reason is required to start a visit without a scheduled shift" } });
        visit = { visitId: VISIT, visitNumber: "V-1", clientCode: "C-104", serviceCode: "862", serviceName: "Respite Care", scheduledStartsAt: null, scheduledEndsAt: null, timeIn: new Date(Date.now() - 120 * 60_000).toISOString(), timeOut: null, workedMinutes: null, visitStatus: "draft", monthlyAuthorizedMinutes: 6000, confirmedMinutesThisMonth: 1470 };
        return json(201, { visitId: VISIT });
      case `POST /v1/visits/${VISIT}/end`:
        visit = { ...visit, timeOut: new Date().toISOString(), workedMinutes: 120, visitStatus: "awaiting_signature" };
        return json(200, { visit: { visitId: VISIT, workedMinutes: 120, timeIn: visit!["timeIn"], timeOut: visit!["timeOut"] } });
      case `POST /v1/visits/${VISIT}/confirm`: {
        visit = null;
        const method = String(body?.method);
        const clean = method === "draw" && opts.scheduled === true;
        const reasons = clean ? [] : method === "draw" ? ["unscheduled"] : method === "unable_to_confirm" ? ["no_client_signature"] : ["no_client_signature"];
        return json(200, { result: { visitId: VISIT, status: clean ? "signed" : "administrator_review", authorizationStatus: "within_authorization", workedMinutes: 120, billableMinutes: clean ? 120 : 0, monthToDateMinutes: 1590, remainingMinutes: 4410,
          outcome: { visitId: VISIT, status: clean ? "signed" : "administrator_review", workedMinutes: 120, verifiedMinutes: clean ? 120 : 0, billableMinutes: clean ? 120 : 0, authorizationStatus: "within_authorization", confirmationMethod: method, confirmationReason: body?.reason ?? null, reviewReasons: reasons, unscheduledReason: null, attestationVersion: body?.attested ? "attest-v1" : null, ruleVersion: 0, ruleMinutes: 15, ruleSource: "system_default", ruleOutcome: "within" } } });
      }
      case "GET /v1/my-shifts":
        return json(200, { shifts: [{ shiftId: "66666666-0000-4000-8000-000000000001", startsAt: "2026-10-21T16:00:00Z", endsAt: "2026-10-21T18:00:00Z", clientCode: "C-104", serviceName: "Respite Care", coverageState: "covered", canCallOut: true }] });
      case "GET /v1/open-shifts":
        return json(200, { shifts: openShifts });
      case `POST /v1/shifts/${SHIFT}/pickup`:
        if (opts.pickup === "filled") { openShifts = []; return json(409, { error: { code: "conflict", message: "This shift was just filled." } }); }
        openShifts = openShifts.map((o: any) => ({ ...o, myRequestStatus: "requested" })); // 0063: the shift stays open; the caregiver has asked
        return json(200, { pickupState: "requested" });
      case `POST /v1/shifts/${SHIFT}/pickup/withdraw`:
        openShifts = openShifts.map((o: any) => ({ ...o, myRequestStatus: null }));
        return json(200, { pickupState: "withdrawn" });
      case "GET /v1/visit-rules":
        return json(200, { rules });
      case "POST /v1/visit-rules":
        rules = [{ version: 1, minutes: body?.minutes, source: "agency_setting", effectiveFrom: "2026-10-13", changedByName: "Synthetic Person", changedAt: "2026-10-13T20:00:00Z", reason: body?.reason, inEffect: true }, { ...rules[0]!, inEffect: false }];
        return json(201, { version: 1 });
      case `GET /v1/visits/${VISIT}/review`: {
        const variance = opts.reviewKind === "variance";
        return json(200, { visit: {
          visitId: VISIT, organizationId: ORG, visitNumber: "V-1", visitStatus: "administrator_review", clientId: CLIENT, clientCode: "C-104", clientName: null, caregiverName: "Synthetic Caregiver", serviceCode: "862", serviceName: "Respite Care", serviceDate: "2026-10-13",
          timeIn: "2026-10-13T16:00:00Z", timeOut: "2026-10-13T18:00:00Z", workedMinutes: 120, verifiedMinutes: 120, billableMinutes: 120, authorizationStatus: "within_authorization",
          scheduledStartsAt: variance ? "2026-10-13T16:00:00Z" : null, scheduledEndsAt: variance ? "2026-10-13T17:00:00Z" : null, caregiverSchedulingMode: "fixed",
          confirmationMethod: "draw", signerRole: "client", signerName: null, signerRelationship: null, confirmationReason: null, confirmedAt: "2026-10-13T18:05:00Z", hasSignatureEvidence: true, isCorrection: false,
          reviewReasons: [variance ? "schedule_variance" : "unscheduled"], decisionId: null, decision: null, decisionReason: null, decidedByName: null, decidedAt: null, activeBillingApprovalId: null, approvedMinutes: null,
          canDecide: true, allowedDecisions: ["accept_capped_billable", "close_not_billable"], recoveryState: null, canRequestConfirmation: false, decisionAcceptedMinutes: null,
          unscheduledReason: variance ? null : "Synthetic: client asked for extra help", ruleVersion: 0, ruleMinutes: 15, ruleSource: "system_default", ruleOutcome: variance ? "over" : "not_applicable", attestationVersion: "attest-v1" } });
      }
      case `GET /v1/visits/${VISIT}/confirmation-requests`:
        return json(200, { requests: [] });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

function renderAws(path: string, role: Role, opts: Opts = {}) {
  const api = fakeApi(role, opts);
  const session = { user: { id: SUB, email: "x@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 };
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => session), getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(async () => "/"), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: api.fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return api;
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,iVBORw0KGgo=");
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
});
afterEach(() => vi.clearAllMocks());
const T = 30_000;
const COLD = 15_000;

async function startAndEnd(api: ReturnType<typeof fakeApi>, reason?: string) {
  fireEvent.click(await screen.findByRole("button", { name: /Client C-104/ }, { timeout: COLD }));
  await screen.findByRole("group", { name: "Visit details" });
  if (reason !== undefined) fireEvent.change(await screen.findByLabelText(/Why is this visit not on your schedule/), { target: { value: reason } });
  await waitFor(() => expect(screen.getByRole("button", { name: /Start visit/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: /Start visit/ }));
  fireEvent.click(await screen.findByRole("button", { name: /End visit/ }));
  await screen.findByRole("heading", { name: "Verify visit details" });
  return api;
}

describe("unscheduled start (G01)", () => {
  it("a client with no schedule needs a reason of at least 3 characters before Start is enabled", async () => {
    const api = renderAws("/", "caregiver");
    await startAndEnd(api, "ab").catch(() => undefined);
    fireEvent.change(await screen.findByLabelText(/Why is this visit not on your schedule/), { target: { value: "ab" } });
    expect(screen.getByRole("button", { name: /Start visit/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Why is this visit not on your schedule/), { target: { value: "abc" } });
    expect(screen.getByRole("button", { name: /Start visit/ })).toBeEnabled();
    expect(screen.getByText(/marked Unscheduled/)).toBeInTheDocument();
  }, T);

  it("a client with a schedule shows no reason field and sends none", async () => {
    const api = renderAws("/", "caregiver", { scheduled: true });
    await startAndEnd(api);
    expect(screen.queryByLabelText(/Why is this visit not on your schedule/)).not.toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/visits")!.body).toEqual({ organizationId: ORG, clientId: CLIENT, serviceId: SERVICE });
  }, T);

  it("when the server finds no matching shift it asks for the reason instead of leaving a dead end", async () => {
    const api = renderAws("/", "caregiver", { scheduled: true, startNeedsReason: true });
    fireEvent.click(await screen.findByRole("button", { name: /Client C-104/ }, { timeout: COLD }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Start visit/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Start visit/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reason is required/);
    const box = await screen.findByLabelText(/Why is this visit not on your schedule/);
    expect(screen.getByRole("button", { name: /Start visit/ })).toBeDisabled();
    fireEvent.change(box, { target: { value: "Synthetic: covering for a friend" } });
    fireEvent.click(screen.getByRole("button", { name: /Start visit/ }));
    await screen.findByRole("button", { name: /End visit/ });
    expect(api.calls.filter((c) => c.method === "POST" && c.path === "/v1/visits").length).toBe(2);
  }, T);
});

describe("confirmation choices and attestation (G05, G06)", () => {
  it("offers Verbal only; it needs the person's name and the attestation, and is sent as method verbal with no image", async () => {
    const api = renderAws("/", "caregiver", { scheduled: true });
    await startAndEnd(api);
    fireEvent.click(screen.getByRole("button", { name: /Verbal only/ }));
    expect(screen.queryByLabelText("Client or guardian signature")).not.toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: /Confirm visit/ });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name of the person who confirmed"), { target: { value: "Synthetic Parent" } });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(ATTESTATION_TEXT.slice(0, 30)) }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(await screen.findByRole("heading", { name: "Saved for manager review" })).toBeInTheDocument();
    const sent = api.calls.find((c) => c.path.endsWith("/confirm"))!.body!;
    expect(sent).toMatchObject({ method: "verbal", typedSignerName: "Synthetic Parent", attested: true });
    expect(sent).not.toHaveProperty("signaturePng");
    expect(screen.getByLabelText("Why a manager will review this visit")).toHaveTextContent(/without a signature or mark/);
    expect(screen.getByText(/Not billable until a manager reviews it/)).toBeInTheDocument();
  }, T);

  it("'Client declined to sign' is a listed reason and is sent as unable to confirm with the caregiver's note", async () => {
    const api = renderAws("/", "caregiver", { scheduled: true });
    await startAndEnd(api);
    fireEvent.click(screen.getByRole("button", { name: /Unable to obtain confirmation/ }));
    const select = screen.getByLabelText("Why is manager review needed?") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["Choose a reason", "Client declined to sign", "Technical problem prevented signing", "Signature was accidentally missed before departure"]);
    fireEvent.change(select, { target: { value: "Client declined to sign" } });
    fireEvent.change(screen.getByLabelText("Brief explanation"), { target: { value: "Said she was tired (synthetic)" } });
    const submit = screen.getByRole("button", { name: "Submit for manager review" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(ATTESTATION_TEXT.slice(0, 30)) }));
    fireEvent.click(submit);
    await screen.findByRole("heading", { name: "Saved for manager review" });
    expect(api.calls.find((c) => c.path.endsWith("/confirm"))!.body).toMatchObject({ method: "unable_to_confirm", reason: "Client declined to sign: Said she was tired (synthetic)", attested: true });
  }, T);

  it("a clean scheduled visit: the final screen shows confirmed, billable, authorization left and method; Billing ready is not billed", async () => {
    const api = renderAws("/", "caregiver", { scheduled: true });
    await startAndEnd(api);
    const canvas = screen.getByLabelText("Client or guardian signature");
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(ATTESTATION_TEXT.slice(0, 30)) }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm visit/ }));
    expect(await screen.findByRole("heading", { name: "Visit saved" })).toBeInTheDocument();
    const dl = within(document.querySelector('dl[aria-label="Visit result"]') as HTMLElement);
    expect(dl.getByText("Billing ready")).toBeInTheDocument();
    expect(screen.getByText(/Billing ready does not mean billed/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Why a manager will review this visit")).not.toBeInTheDocument();
    expect(api.calls.find((c) => c.path.endsWith("/confirm"))!.body).toMatchObject({ method: "draw", attested: true });
  }, T);
});

describe("open shifts (G09)", () => {
  it("lists open shifts by client code; asking sends a request (with an idempotency key) and does NOT claim the shift; the caregiver can withdraw it", async () => {
    const api = renderAws("/my-shifts", "caregiver", { pickup: "ok" });
    expect(await screen.findByText(/Open shifts you can ask for/, undefined, { timeout: COLD })).toBeInTheDocument();
    const region = screen.getByRole("heading", { name: /Open shifts you can ask for/ }).closest("section")!;
    expect(within(region).getByText(/Client C-104 · Respite Care · 2 hr/)).toBeInTheDocument();
    expect(within(region).getByText(/Asking does not give you the shift/)).toBeInTheDocument();
    expect(within(region).queryByText(/disappear/)).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Request this shift" }));
    expect(await screen.findByText(/Request sent\. The office will confirm it\. The shift is not yours until they do/)).toBeInTheDocument();
    expect(screen.queryByText(/You have the shift/)).toBeNull();
    const call = api.calls.find((c) => c.path === `/v1/shifts/${SHIFT}/pickup`)!;
    expect(call.body).toEqual({ organizationId: ORG });
    expect(call.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByTestId("requested-badge")).toHaveTextContent("Requested — waiting for the office");
    expect(screen.queryByRole("button", { name: "Request this shift" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
    expect(await screen.findByRole("button", { name: "Request this shift" })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === `/v1/shifts/${SHIFT}/pickup/withdraw`)).toBe(true);
  }, T);

  it("when someone else got there first, the caregiver is told and the shift leaves the list", async () => {
    renderAws("/my-shifts", "caregiver", { pickup: "filled" });
    fireEvent.click(await screen.findByRole("button", { name: "Request this shift" }, { timeout: COLD }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This shift was just filled.");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Request this shift" })).not.toBeInTheDocument());
  }, T);
});

describe("review page wording (G01, G02, G03)", () => {
  it("an unscheduled visit shows the caregiver's reason, the rule is not applied, and the decision is worded as accepting the visit", async () => {
    renderAws(`/visits/${VISIT}`, "manager", { reviewKind: "unscheduled" });
    expect(await screen.findByText(/Started with no scheduled shift/, undefined, { timeout: COLD })).toHaveTextContent("Synthetic: client asked for extra help");
    expect(screen.getByText("Unscheduled reason")).toBeInTheDocument();
    expect(screen.getByText(/Accept this visit as worked/)).toBeInTheDocument();
    expect(screen.getByText("Recorded (attest-v1)")).toBeInTheDocument();
  }, T);

  it("a schedule difference shows the rule used, its version and that the starting value is not verified", async () => {
    renderAws(`/visits/${VISIT}`, "manager", { reviewKind: "variance" });
    expect(await screen.findByText(/more than the 15-minute difference the agency allows/, undefined, { timeout: COLD })).toHaveTextContent("starting value no one has verified");
    expect(screen.getByText(/15 minutes \(version 0, starting value, not verified\): difference over the rule/)).toBeInTheDocument();
  }, T);
});

describe("visit rules page (G02)", () => {
  it("shows the unverified starting value and history; the Administrator saves a new version with a reason; there is no off setting", async () => {
    const api = renderAws("/settings/visit-rules", "organization_owner");
    expect(await screen.findByText("15 minutes", undefined, { timeout: COLD })).toBeInTheDocument();
    expect(screen.getByText(/not been verified/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Allowed difference (minutes)"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/Reason \(required/), { target: { value: "Synthetic: our payer rule" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as a new version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/from 1 to 240/);
    fireEvent.change(screen.getByLabelText("Allowed difference (minutes)"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as a new version" }));
    expect(await screen.findByText(/Saved as a new version/)).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/visit-rules")!.body).toMatchObject({ organizationId: ORG, minutes: 30, reason: "Synthetic: our payer rule" });
    expect(await screen.findByText(/Version 1: 30 minutes \(in effect\)/)).toBeInTheDocument();
    expect(screen.getByText(/Version 0: 15 minutes/)).toBeInTheDocument();
  }, T);

  it("a manager can read the rule but has no form", async () => {
    renderAws("/settings/visit-rules", "manager");
    expect(await screen.findByText("15 minutes", undefined, { timeout: COLD })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save as a new version" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the agency Administrator can change this rule/)).toBeInTheDocument();
  }, T);
});

describe("wording helpers", () => {
  it("validates the reason length and words every review code without identifiers", () => {
    expect(isUnscheduledReasonValid("  ab ")).toBe(false);
    expect(isUnscheduledReasonValid("abc")).toBe(true);
    const o = describeOutcome({ confirmation_method: "verbal", review_reasons: ["unscheduled", "schedule_variance", "no_client_signature", "over_authorization", "something_new"], rule_minutes: 15 });
    expect(o.methodLabel).toBe("Verbal confirmation");
    expect(o.reasons).toHaveLength(5);
    expect(o.reasons.join(" ")).not.toMatch(/undefined|null/);
    expect(caregiverReasonText("schedule_variance", { methodLabel: "x", ruleMinutes: 15 })).toMatch(/15 minutes/);
  });
});
