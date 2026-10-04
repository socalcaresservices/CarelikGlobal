// AWS build (VITE_AUTH_PROVIDER=cognito) UI flows against an in-memory fake of
// the Ogevia AWS API. SYNTHETIC data only. lib/supabase is NOT mocked here: the
// test proves the AWS runtime never creates a Supabase client.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AuthError, CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { isSupabaseClientCreated } from "@/lib/supabase";
import { AwsRoutes } from "./aws-root";
import { createAwsRuntime, loadRuntimeEnv, type AwsEnv } from "./aws-runtime";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const SERVICE = "dddddddd-0000-4000-8000-000000000001";
const VISIT = "eeeeeeee-0000-4000-8000-000000000001";
const SUB = "11111111-2222-4333-8444-555555555555";

type Call = { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null };
type FakeVisit = Record<string, unknown>;

function fakeApi(role: "caregiver" | "manager" | "organization_owner", opts: { displayName?: string | null } = {}) {
  const calls: Call[] = [];
  let visit: FakeVisit | null = null;
  let approvals: Record<string, unknown>[] = [];
  const DOC = "dddddddd-0000-4000-8000-00000000d0c1";
  let docStatus: "requested" | "awaiting_review" = role === "caregiver" ? "requested" : "awaiting_review";
  const permissions =
    role === "manager" ? ["billing.approve", "billing.visits.read", "documents.manage", "documents.read", "visits.manage", "visits.read"]
    : role === "organization_owner" ? ["billing.approve", "billing.read", "billing.visits.read", "organization.update", "visits.manage", "visits.read"]
    : ["availability.manage_own", "documents.manage_own"];
  const displayName = opts.displayName === undefined ? (role === "caregiver" ? "Caregiver A1" : role === "manager" ? "Morgan Manager" : "Olivia Owner") : opts.displayName;
  const canMoney = role === "organization_owner";
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, headers, body });
    if (headers.authorization !== "Bearer synthetic-access-token") return json(401, { error: { code: "unauthenticated", message: "no" } });
    switch (key) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: "#1f5f8b", logoSha256: "a".repeat(64) } });
      case "POST /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: body?.["displayName"], accentColor: body?.["accentColor"] } });
      case "GET /v1/attention":
        return json(200, { summary: role === "caregiver" ? null : { missingTimeOut: 1, notConfirmed: 0, needsReview: 2, billingReadyUnapproved: 1, total: 3 } });
      case "GET /v1/reports/utilisation":
        return json(200, { services: role === "caregiver" ? [] : [{ serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care", clientCount: 1, authorizedMinutes: 6000, scheduledMinutes: 240, workedMinutes: 1590, billableMinutes: 1470, reviewMinutes: 120, approvedMinutes: 600, remainingMinutes: 4530, lineagesWithoutRate: 0, billableValueCents: canMoney ? 73500 : null, approvedValueCents: canMoney ? 30000 : null, unusedValueCents: canMoney ? 226500 : null }] });
      case "GET /v1/visits/active":
        return json(200, { visit });
      case "GET /v1/clients/assigned":
        return json(200, { clients: [{ clientId: CLIENT, clientCode: "C-104", nextScheduledStartsAt: null, nextScheduledEndsAt: null, activeServiceCount: 1 }] });
      case `GET /v1/clients/${CLIENT}/services`:
        return json(200, { services: [{ serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care", serviceColor: null, authorizationId: "f0000000-0000-4000-8000-000000000001", monthlyAuthorizedMinutes: 6000, minutesUsedThisMonth: 1470, minutesScheduledThisMonth: 0 }] });
      case "POST /v1/visits":
        visit = { visitId: VISIT, visitNumber: "V-1", clientCode: "C-104", serviceCode: "862", serviceName: "Respite Care", scheduledStartsAt: null, scheduledEndsAt: null, timeIn: new Date(Date.now() - 120 * 60_000).toISOString(), timeOut: null, workedMinutes: null, visitStatus: "draft", monthlyAuthorizedMinutes: 6000, confirmedMinutesThisMonth: 1470 };
        return json(201, { visitId: VISIT });
      case `POST /v1/visits/${VISIT}/end`:
        visit = { ...visit, timeOut: new Date().toISOString(), workedMinutes: 120, visitStatus: "awaiting_signature" };
        return json(200, { visit: { visitId: VISIT, workedMinutes: 120, timeIn: visit["timeIn"], timeOut: visit["timeOut"] } });
      case `POST /v1/visits/${VISIT}/confirm`:
        visit = null;
        return json(200, { result: { visitId: VISIT, status: "signed", authorizationStatus: "within_authorization", workedMinutes: 120, billableMinutes: 120, monthToDateMinutes: 1590, remainingMinutes: 4410 } });
      case "GET /v1/visits":
        return json(200, { visits: [{ id: VISIT, visitNumber: "V-1", clientId: CLIENT, clientCode: "C-104", caregiverUserId: "u1", caregiverName: "CAREGIVER_A1", serviceId: SERVICE, serviceName: "Respite Care", serviceDate: "2026-09-30", timeIn: "2026-09-30T17:00:00Z", timeOut: "2026-09-30T19:00:00Z", workedMinutes: 120, verifiedMinutes: 120, billableMinutes: 120, status: "signed", authorizationStatus: "within_authorization", signedAt: "2026-09-30T19:01:00Z", originalVisitId: null, isCorrected: false, monthToDateBeforeMinutes: 0, monthToDateAfterMinutes: 120, remainingMinutes: 5880 }] });
      case "GET /v1/billing-review":
        return json(200, { visits: [{ visitId: VISIT, visitNumber: "V-1", serviceCode: "862", serviceDate: "2026-09-30", workedMinutes: 120, verifiedMinutes: 120, billableMinutes: 120, visitStatus: "signed", authorizationStatus: "within_authorization", authorizationVersion: 1, confirmationMethod: "draw", hasSignatureEvidence: true, isCorrection: false, reviewState: "ready" }] });
      case "GET /v1/clients/directory":
        return json(200, { clients: role === "caregiver" ? [] : [{ clientId: CLIENT, clientCode: "C-104", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Person" }] });
      case "GET /v1/branding/logo":
        return json(200, { contentType: "image/png", fileBase64: "iVBORw0KGgo=" });
      case "GET /v1/documents":
        return json(200, { documents: [{ documentId: DOC, caregiverRecordId: "r1", personName: "Pilot Caregiver A", documentTypeId: "t1", documentTypeName: "TB test", requiresExpiry: true, dueOn: "2026-10-20", requestedAt: "2026-10-01T00:00:00Z",
          latestVersionId: docStatus === "requested" ? null : "eeeeeeee-0000-4000-8000-00000000d0c2", latestVersionNumber: docStatus === "requested" ? null : 1, latestContentType: null, latestUploadedAt: docStatus === "requested" ? null : "2026-10-02T00:00:00Z",
          latestReviewStatus: docStatus === "requested" ? null : "awaiting_review", latestRejectionReason: null, issuedOn: null, expiresOn: null, verifiedExpiresOn: null, displayStatus: docStatus, daysUntil: 16 }] });
      case "GET /v1/document-types":
        return json(200, { types: [{ documentTypeId: "t1", name: "TB test", requiresExpiry: true, isActive: true }] });
      case "GET /v1/documents/people":
        return json(200, { people: [{ caregiverRecordId: "r1", displayName: "Pilot Caregiver A", caregiverCode: "SCS-CG-A" }] });
      case "GET /v1/documents/alerts":
        return json(200, { alerts: { expired: 0, expiring: 1, overdue: 0, awaitingReview: 1, rejected: 0 } });
      case `POST /v1/documents/${DOC}/versions`:
        docStatus = "awaiting_review";
        return json(201, { version: { documentVersionId: "eeeeeeee-0000-4000-8000-00000000d0c2", versionNumber: 1 } });
      case "POST /v1/document-versions/eeeeeeee-0000-4000-8000-00000000d0c2/review":
        return json(200, { decision: body?.["decision"] });
      case "GET /v1/billing-approvals":
        return json(200, { approvals });
      case `POST /v1/visits/${VISIT}/billing-approval`:
        approvals = [{ billingApprovalId: "abababab-0000-4000-8000-000000000001", visitId: VISIT, visitNumber: "V-1", serviceDate: "2026-09-30", approvedMinutes: body?.["approvedMinutes"], billableMinutesAtApproval: 120, approvedAt: "2026-10-01T10:00:00Z", approvedByName: "Manager A", notes: null, voidedAt: null, voidedByName: null, voidReason: null, rateCents: null, amountCents: null }];
        return json(201, { billingApprovalId: "abababab-0000-4000-8000-000000000001" });
      case `GET /v1/visits/${VISIT}/signature`:
        return json(200, { contentType: "image/png", sha256: "x", pngBase64: "iVBORw0KGgo=" });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

function fakeAuth(signedIn = true) {
  const session = { user: { id: SUB, email: "caregiver.a1@example.test", emailVerified: true }, access_token: "synthetic-access-token", expires_at: 4_000_000_000 };
  return {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => (signedIn ? session : null)),
    getAccessToken: vi.fn(async () => (signedIn ? session.access_token : null)),
    signIn: vi.fn(async () => {}),
    handleCallback: vi.fn(async () => "/service-verification"),
    startPasswordReset: vi.fn(),
    signOut: vi.fn(async () => {}),
  };
}

function renderAws(path: string, role: "caregiver" | "manager" | "organization_owner", signedIn = true, opts: { displayName?: string | null } = {}) {
  const api = fakeApi(role, opts);
  const auth = fakeAuth(signedIn);
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
  return { api, auth };
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,iVBORw0KGgo=");
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("AWS build: caregiver vertical slice", () => {
  it("login → today's visit → start → end → signature → submitted, all through the AWS API", async () => {
    const { api } = renderAws("/", "caregiver");

    // Landing sends caregivers to Verify Visit; only the assigned client code is shown.
    fireEvent.click(await screen.findByRole("button", { name: /Client C-104/ }));
    const details = await screen.findByRole("group", { name: "Visit details" });
    await waitFor(() => expect(details).toHaveTextContent("ClientC-104"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Start visit/ })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /Start visit/ }));
    fireEvent.click(await screen.findByRole("button", { name: /End visit/ }));
    await screen.findByRole("heading", { name: "Client or guardian confirmation" });

    const canvas = screen.getByLabelText("Client or guardian signature");
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole("button", { name: /Confirm visit/ }));

    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith("/confirm"))).toBe(true));

    // Every request carried the bearer token; mutations carried idempotency keys.
    for (const c of api.calls) expect(c.headers.authorization).toBe("Bearer synthetic-access-token");
    const start = api.calls.find((c) => c.method === "POST" && c.path === "/v1/visits")!;
    expect(start.body).toEqual({ organizationId: ORG, clientId: CLIENT, serviceId: SERVICE });
    expect(start.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    const confirm = api.calls.find((c) => c.path.endsWith("/confirm"))!;
    expect(confirm.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(confirm.body).toMatchObject({ organizationId: ORG, signerRole: "client", method: "draw", signaturePng: "data:image/png;base64,iVBORw0KGgo=" });
    // No browser-supplied time, role, or caregiver identity in any request.
    expect(JSON.stringify(api.calls.map((c) => c.body))).not.toMatch(/timeIn|caregiver|role"/);
  });

  it("never creates a Supabase client in the AWS runtime", async () => {
    renderAws("/", "caregiver");
    await screen.findByRole("heading", { name: "Today's visits" });
    expect(isSupabaseClientCreated()).toBe(false);
  });
});

describe("AWS build: manager review and billing-review data", () => {
  it("manager lands on Home: MANAGER VIEW with the real name, NEEDS ATTENTION with a count, hours without dollar values", async () => {
    const { api } = renderAws("/", "manager");
    expect(await screen.findByText("MANAGER VIEW")).toBeInTheDocument();
    expect(await screen.findByText("Morgan Manager")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    const attention = await screen.findByRole("link", { name: "Needs attention: 3 visits" });
    expect(attention.getAttribute("href")).toBe("/service-verification/reports?view=exceptions");
    expect(attention.className).toMatch(/font-bold/);
    expect(attention.className).toMatch(/uppercase/);
    expect(attention.className).toMatch(/text-red-700/);
    // 1590 of 6000 minutes worked = 26.5 h of 100 h, 27 %.
    expect(await screen.findByText(/26\.5 h of 100 h · 27%/)).toBeInTheDocument();
    expect(screen.queryByText("Financial impact (owner only)")).not.toBeInTheDocument();
    expect(screen.getByText(/visible to the agency owner only/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Billing review" })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.startsWith("/v1/attention?organizationId="))).toBe(true);
  });

  it("owner sees OWNER VIEW, the financial cards with unavailable cost/margin, and Settings", async () => {
    renderAws("/", "organization_owner");
    expect(await screen.findByText("OWNER VIEW")).toBeInTheDocument();
    expect(await screen.findByText("Financial impact (owner only)")).toBeInTheDocument();
    expect(screen.getByText("$735")).toBeInTheDocument();
    expect(screen.getByText("Caregiver cost and margin")).toBeInTheDocument();
    expect(screen.getByText(/no caregiver pay data/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });

  it("a missing name is shown explicitly with a way to add it, never replaced by the email", async () => {
    renderAws("/", "manager", true, { displayName: null });
    const link = await screen.findByRole("link", { name: /Name not set/ });
    expect(link.getAttribute("href")).toBe("/profile");
  });

  it("owner branding: a colour too light for white text is refused before saving", async () => {
    const { api } = renderAws("/settings/branding", "organization_owner");
    const hex = await screen.findByLabelText("Hex");
    await waitFor(() => expect(hex).toHaveValue("#1f5f8b"));
    fireEvent.change(hex, { target: { value: "#ffd966" } });
    expect(screen.getByText(/too light: needs 4\.5:1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save branding" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a darker colour");
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/v1/branding")).toBe(false);
    fireEvent.change(hex, { target: { value: "#14532d" } });
    fireEvent.click(screen.getByRole("button", { name: "Save branding" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    const post = api.calls.find((c) => c.method === "POST" && c.path === "/v1/branding")!;
    expect(post.body).toMatchObject({ organizationId: ORG, accentColor: "#14532d" });
    expect(post.headers["idempotency-key"]).toBeTruthy();
  });

  it("billing review shows Billing Ready (not billed) and the audited signature view", async () => {
    const { api } = renderAws("/billing-review", "manager");
    expect(await screen.findByText("Billing ready")).toBeInTheDocument();
    expect(screen.getByText(/approval is not submission/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View signature" }));
    const img = await screen.findByAltText("Client signature for the selected visit");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(api.calls.some((c) => c.path === `/v1/visits/${VISIT}/signature`)).toBe(true);
  });

  it("a manager approves the billable minutes with an idempotency key; more than billable is refused in the form", async () => {
    const { api } = renderAws("/billing-review", "manager");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const minutes = screen.getByLabelText("Approved minutes");
    expect(minutes).toHaveValue("120");
    fireEvent.change(minutes, { target: { value: "121" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve for billing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter whole minutes from 0 to 120.");
    expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/billing-approval"))).toBe(false);
    fireEvent.change(minutes, { target: { value: "110" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve for billing" }));
    expect(await screen.findByText(/approved for billing \(1\.83 h\)|approved for billing/)).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === "POST" && c.path === `/v1/visits/${VISIT}/billing-approval`)!;
    expect(post.body).toEqual({ approvedMinutes: 110, notes: null });
    expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/by Manager A · not submitted/)).toBeInTheDocument();
    // No owner-only Amount column for a manager.
    expect(screen.queryByRole("columnheader", { name: "Amount" })).not.toBeInTheDocument();
  });

  it("caregiver: My documents shows the due date with days left; upload waits for the server and requires the expiry", async () => {
    const { api } = renderAws("/documents", "caregiver");
    expect(await screen.findByRole("heading", { name: "My documents" })).toBeInTheDocument();
    expect(await screen.findByText("Due Oct 20, 2026 (in 16 days)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], "tb.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/Photo or PDF/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the expiry date");
    fireEvent.change(screen.getByLabelText(/Expiry date/), { target: { value: "2027-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Uploading/ })).not.toBeInTheDocument());
    expect(await screen.findByText("Uploaded – awaiting review")).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/versions"))!;
    expect(post.body).toMatchObject({ organizationId: ORG, contentType: "application/pdf", expiresOn: "2027-10-01", fileBase64: "JVBERi0x" });
    expect(post.headers["idempotency-key"]).toBeTruthy();
  });

  it("manager: Documents lists people's requests; rejecting needs a reason; Home shows document alerts", async () => {
    const { api } = renderAws("/", "manager");
    expect(await screen.findByText("Documents to review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Documents" }));
    expect(await screen.findByRole("heading", { name: "Documents" })).toBeInTheDocument();
    const card = (await screen.findByText("TB test", { selector: "p" })).closest("li")!;
    expect(within(card).getByText("Pilot Caregiver A")).toBeInTheDocument();
    expect(within(card).getByText("Uploaded – awaiting review")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("Enter why it is rejected");
    expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/review"))).toBe(false);
    fireEvent.click(within(card).getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/review"))).toBe(true));
    expect(screen.getByRole("button", { name: "Request document" })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.startsWith("/v1/documents/people"))).toBe(true);
  });

  it("NEEDS ATTENTION opens the exceptions view; the Visit records menu item returns to the visit list", async () => {
    renderAws("/service-verification/reports?view=exceptions", "manager");
    expect(await screen.findByRole("heading", { name: "Needs attention" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Visit records" }));
    expect(await screen.findByRole("heading", { name: "Visit records" })).toBeInTheDocument();
  });

  it("office roles see the client's name (code alongside) in visit records; the agency logo shows in the header", async () => {
    renderAws("/service-verification/reports", "manager");
    expect(await screen.findByAltText("Synthetic Care Co logo")).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Visit details" });
    expect(await within(table).findByText("Synthetic Person")).toBeInTheDocument();
    expect(within(table).getByText("C-104")).toBeInTheDocument();
  });

  it("a caregiver sees no billing or records navigation", async () => {
    renderAws("/", "caregiver");
    await screen.findByRole("heading", { name: "Today's visits" });
    expect(screen.getByText("CAREGIVER VIEW")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Needs attention/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Billing review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Visit records" })).not.toBeInTheDocument();
  });
});

describe("AWS build: sign-in states", () => {
  it("signed-out users are sent to the login page, which starts managed login with the return path", async () => {
    const { auth } = renderAws("/service-verification", "caregiver", false);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith("/service-verification"));
  });

  it("the callback page completes sign-in once and strips code/state from the address bar", async () => {
    window.history.replaceState(null, "", "/auth/callback?code=synthetic&state=synthetic");
    const { auth } = renderAws("/auth/callback", "caregiver", false);
    await waitFor(() => expect(auth.handleCallback).toHaveBeenCalledTimes(1));
    expect(window.location.search).toBe("");
  });

  it("a failed callback shows a safe error with a way back", async () => {
    const api = fakeApi("caregiver");
    const auth = fakeAuth(false);
    auth.handleCallback.mockRejectedValueOnce(new AuthError("state_mismatch", "Sign-in could not be verified. Please try again."));
    const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: api.fetchImpl as never });
    render(
      <MemoryRouter initialEntries={["/auth/callback"]}>
        <QueryClientProvider client={new QueryClient()}>
          <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
            <AwsRoutes api={client} publicApi={client} />
          </CognitoAuthProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeInTheDocument();
  });
});

describe("AWS runtime configuration fails closed", () => {
  const env = {
    VITE_COGNITO_REGION: "us-west-2",
    VITE_COGNITO_USER_POOL_ID: "us-west-2_TESTPOOL1",
    VITE_COGNITO_CLIENT_ID: "testclient0000000000000000",
    VITE_COGNITO_DOMAIN: "https://ogevia-test.auth.us-west-2.amazoncognito.com",
    VITE_COGNITO_REDIRECT_URI: "https://app.example.test/auth/callback",
    VITE_COGNITO_LOGOUT_URI: "https://app.example.test/",
    VITE_SV_API_BASE_URL: "https://api.example.test",
  };
  it("accepts a complete configuration", () => {
    expect(() => createAwsRuntime(env)).not.toThrow();
  });
  it.each([
    ["missing API URL", { VITE_SV_API_BASE_URL: undefined }],
    ["http API URL", { VITE_SV_API_BASE_URL: "http://api.example.test" }],
    ["missing client id", { VITE_COGNITO_CLIENT_ID: undefined }],
    ["http redirect", { VITE_COGNITO_REDIRECT_URI: "http://app.example.test/auth/callback" }],
  ])("rejects %s", (_l, patch) => {
    expect(() => createAwsRuntime({ ...env, ...patch } as AwsEnv)).toThrow();
  });
});

describe("AWS API client", () => {
  it("refuses to call the API without a token and maps server errors safely", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: "forbidden", message: "Not permitted" } }), { status: 403 }));
    const noToken = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => null, fetch: fetchImpl as never });
    await expect(noToken.get("/v1/me")).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();
    const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "t", fetch: fetchImpl as never });
    await expect(client.get("/v1/me")).rejects.toMatchObject({ status: 403, code: "forbidden", message: "Not permitted" });
    const offline = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "t", fetch: (async () => { throw new TypeError("offline"); }) as never });
    await expect(offline.post("/v1/visits", {})).rejects.toMatchObject({ code: "network_error" });
  });
  it("sends no cookies and disables caching", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = vi.fn(async (...args: [string, RequestInit?]) => {
      seen.push(args[1] ?? {});
      return new Response("{}", { status: 200 });
    });
    const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "t", fetch: fetchImpl as never });
    await act(async () => {
      await client.get("/v1/me");
    });
    expect(seen[0]).toMatchObject({ credentials: "omit", cache: "no-store" });
  });
});

describe("runtime /config.json", () => {
  const fetchJson = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("overrides build-time values with deployment values", async () => {
    const env = await loadRuntimeEnv({ VITE_COGNITO_CLIENT_ID: "build" } as AwsEnv, fetchJson({ VITE_COGNITO_CLIENT_ID: "runtime0000000000000000000", VITE_SV_API_BASE_URL: "https://api.example.test" }));
    expect(env.VITE_COGNITO_CLIENT_ID).toBe("runtime0000000000000000000");
    expect(env.VITE_SV_API_BASE_URL).toBe("https://api.example.test");
  });
  it("ignores unknown keys and non-strings, and falls back when the file is missing", async () => {
    const env = await loadRuntimeEnv({ VITE_COGNITO_CLIENT_ID: "build" } as AwsEnv, fetchJson({ VITE_AUTH_PROVIDER: "supabase", VITE_COGNITO_CLIENT_ID: 7, EVIL: "x" }));
    expect(env).toEqual({ VITE_COGNITO_CLIENT_ID: "build" });
    const missing = await loadRuntimeEnv({ VITE_COGNITO_CLIENT_ID: "build" } as AwsEnv, fetchJson({}, 404));
    expect(missing.VITE_COGNITO_CLIENT_ID).toBe("build");
    const offline = await loadRuntimeEnv({ VITE_COGNITO_CLIENT_ID: "build" } as AwsEnv, (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch);
    expect(offline.VITE_COGNITO_CLIENT_ID).toBe("build");
  });
});
