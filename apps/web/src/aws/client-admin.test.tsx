// Client and authorization screens (0022) against an in-memory fake of the AWS
// API, through the real API client and routes. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { dollarsToCents, groupByLineage, hoursToMinutes, type AuthorizationVersion } from "./client-admin";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const SERVICE = "dddddddd-0000-4000-8000-000000000001";
const AUTH1 = "a1a1a1a1-0000-4000-8000-000000000001";
type Role = "caregiver" | "manager" | "organization_owner";
type Call = { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> };

const version = (over: Partial<AuthorizationVersion> = {}): AuthorizationVersion => ({
  authorizationId: AUTH1, lineageId: AUTH1, versionNumber: 1, isCurrent: true, serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care",
  payer: "Synthetic Regional Center", authorizationNumber: "SYN-1", monthlyAuthorizedMinutes: 1800, periodStart: "2026-10-01", periodEnd: "2026-12-31",
  receivedDate: null, sourceReference: null, changeReason: "Created", createdAt: "2026-10-01T00:00:00Z", createdByName: "Morgan Manager", hourlyRateCents: null, ...over,
});

function fakeApi(role: Role) {
  const calls: Call[] = [];
  const permissions =
    role === "manager" ? ["authorizations.read", "authorizations.update", "clients.manage", "clients.names.manage", "clients.names.read", "visits.manage", "visits.read"]
    : role === "organization_owner" ? ["authorizations.rates.manage", "authorizations.read", "authorizations.update", "billing.read", "clients.manage", "clients.names.manage", "clients.names.read", "organization.update", "visits.manage", "visits.read"]
    : ["availability.manage_own", "documents.manage_own"];
  let versions: AuthorizationVersion[] = [version({ hourlyRateCents: role === "organization_owner" ? 3000 : null })];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body, headers });
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName: "Synthetic Person" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case "GET /v1/clients":
        return json(200, { clients: [{ clientId: CLIENT, clientCode: "CL-ABCDEF1234", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client Alpha", city: "Riverside", clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0 }] });
      case "GET /v1/client-types":
        return json(200, { clientTypes: [{ clientTypeId: "t1", name: "Respite", isActive: true }] });
      case "GET /v1/services":
        return json(200, { services: [{ serviceId: SERVICE, code: "862", name: "Respite Care", isActive: true }] });
      case "POST /v1/clients":
        return json(201, { client: { clientId: "cccccccc-0000-4000-8000-000000000002", clientCode: "CL-1234567890" } });
      case `GET /v1/clients/${CLIENT}/authorizations`:
        return json(200, { authorizations: versions });
      case "GET /v1/reports/monthly-service-summary":
        return json(200, { services: [{ serviceId: SERVICE, serviceName: "Respite Care", authorizationLineageId: AUTH1, authorizedMinutes: 1800, workedMinutes: 600, billableMinutes: 540, remainingMinutes: 1020, reviewMinutes: 60 }] });
      case `POST /v1/clients/${CLIENT}/authorizations`:
        if (body?.hourlyRateCents !== undefined && role !== "organization_owner") return json(403, { error: { code: "forbidden", message: "Only the agency Administrator can set a billing rate" } });
        return json(409, { error: { code: "conflict", message: "This client already has an authorization for this service that overlaps these dates; amend that one instead" } });
      case `POST /v1/authorizations/${AUTH1}/amend`:
        versions = [version({ authorizationId: "a2", versionNumber: 2, monthlyAuthorizedMinutes: body?.monthlyAuthorizedMinutes as number, changeReason: body?.reason as string }), version({ isCurrent: false })];
        return json(200, { newAuthorizationId: "a2", newVersionNumber: 2, affectedVisits: [{ visitId: "v1", status: "signed", serviceDate: "2026-10-02", workedMinutes: 120, billableMinutes: 120, impact: "decrease_now_exceeds" }] });
      case "GET /v1/assignments":
        return json(200, { assignments: [] });
      case "GET /v1/action-issues":
        return json(200, { asOf: new Date().toISOString(), matching: 0, limit: 50, offset: 0, counts: { total: 0, critical: 0, urgent: 0, routine: 0, actionNeeded: 0, byQueue: {} }, issues: [] });
      case `GET /v1/clients/${CLIENT}/issue-history`:
        return json(200, { history: { resolved: [] } });
      case `GET /v1/clients/${CLIENT}/readiness`:
        return json(200, { readiness: { clientId: CLIENT, status: "active", stage: "active", stageNote: null, canSchedule: true, ready: true, services: [] } });
      case `GET /v1/clients/${CLIENT}/documents`:
        return json(200, { documents: [] });
      case "GET /v1/shifts":
        return json(200, { shifts: [] });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

function renderAt(path: string, role: Role) {
  const api = fakeApi(role);
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
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

afterEach(() => vi.clearAllMocks());

describe("hours, rates and history helpers", () => {
  it("reads hours as decimals or h:mm and refuses values outside 1 minute to 744 hours", () => {
    expect(hoursToMinutes("30")).toBe(1800);
    expect(hoursToMinutes("30.5")).toBe(1830);
    expect(hoursToMinutes("7:30")).toBe(450);
    expect(hoursToMinutes("0")).toBeNull();
    expect(hoursToMinutes("745")).toBeNull();
    expect(hoursToMinutes("1800 minutes")).toBeNull();
    expect(hoursToMinutes("7:75")).toBeNull();
  });
  it("reads dollar rates and refuses invalid ones", () => {
    expect(dollarsToCents("")).toBeNull();
    expect(dollarsToCents("$25.50")).toBe(2550);
    expect(dollarsToCents("25.555")).toBeNaN();
    expect(dollarsToCents("1000.01")).toBeNaN();
  });
  it("groups versions by authorization, newest version first", () => {
    const g = groupByLineage([version({ isCurrent: false }), version({ authorizationId: "a2", versionNumber: 2 })]);
    expect(g).toHaveLength(1);
    expect(g[0]!.map((v) => v.versionNumber)).toEqual([2, 1]);
  });
});

describe("Clients screens", () => {
  it("manager: list with name, code and status; adding a client sends an idempotency key and shows the next step", async () => {
    const api = renderAt("/clients", "manager");
    expect(await screen.findByText(/Synthetic Client Alpha/)).toBeInTheDocument();
    expect(screen.queryByText("(CL-ABCDEF1234)")).toBeNull(); // the code appears only where the name is shared (duplicateName)
    fireEvent.click(screen.getByRole("button", { name: "Add client" }));
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add client" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("first and last name");
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Synthetic" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Client Bravo" } });
    fireEvent.click(screen.getByRole("button", { name: "Add client" }));
    expect(await screen.findByText(/Client added/)).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === "POST" && c.path === "/v1/clients")!;
    expect(post.body).toMatchObject({ organizationId: ORG, firstName: "Synthetic", lastName: "Client Bravo", city: null, clientTypeId: null });
    expect(Object.keys(post.headers).map((h) => h.toLowerCase())).toContain("idempotency-key");
  });

  it("caregiver: no Clients menu and the page refuses", async () => {
    renderAt("/clients", "caregiver");
    expect(await screen.findByText("You do not have access to client records.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Clients" })).not.toBeInTheDocument();
  });

  it("manager: client detail shows the month's balance from the shared calculation, no rate, and no rate field", async () => {
    renderAt(`/clients/${CLIENT}`, "manager");
    expect(await screen.findByRole("heading", { name: "Synthetic Client Alpha" })).toBeInTheDocument();
    const balances = await screen.findByRole("list", { name: /Authorized, used and remaining/ });
    expect(within(balances).getByText("17 hr")).toBeInTheDocument();
    expect(await screen.findByText(/30 hr per month/)).toBeInTheDocument();
    expect(screen.queryByText(/\/hr/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add authorization" }));
    expect(screen.queryByLabelText(/Billing rate/)).not.toBeInTheDocument();
  });

  it("Administrator sees the rate and can enter one; an overlapping authorization shows the server's 'amend instead' message", async () => {
    const api = renderAt(`/clients/${CLIENT}`, "organization_owner");
    expect(await screen.findByText(/\$30\.00\/hr/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add authorization" }));
    await screen.findByRole("option", { name: "Respite Care (862)" });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: SERVICE } });
    fireEvent.change(screen.getByLabelText("Payer"), { target: { value: "Synthetic Regional Center" } });
    fireEvent.change(screen.getByLabelText("Authorized hours per month"), { target: { value: "30" } });
    expect(screen.getByText("= 30 hr each month")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-11-30" } });
    fireEvent.change(screen.getByLabelText(/Billing rate/), { target: { value: "25.50" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add authorization" }).at(-1)!);
    await waitFor(() => expect(screen.queryAllByRole("alert").map((a) => a.textContent).join(" | ")).toMatch(/amend that one instead/));
    const post = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/authorizations"))!;
    expect(post.body).toMatchObject({ serviceId: SERVICE, monthlyAuthorizedMinutes: 1800, periodStart: "2026-11-01", periodEnd: "2026-11-30", hourlyRateCents: 2550 });
  });

  it("amend: needs a reason, saves a new version and lists the visits to review", async () => {
    const api = renderAt(`/clients/${CLIENT}`, "manager");
    fireEvent.click(await screen.findByRole("button", { name: "Amend" }));
    const readinessReads = () => api.calls.filter((c) => c.method === "GET" && c.path === `/v1/clients/${CLIENT}/readiness`).length;
    await waitFor(() => expect(readinessReads()).toBeGreaterThan(0));
    const before = readinessReads();
    fireEvent.change(screen.getByLabelText("Authorized hours per month"), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save version 2" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reason");
    fireEvent.change(screen.getByLabelText("Reason for the amendment"), { target: { value: "Reduced by the payer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save version 2" }));
    expect(await screen.findByText(/Saved as version 2/)).toBeInTheDocument();
    expect(screen.getByText(/may now exceed the new limit/)).toBeInTheDocument();
    // The readiness card and alerts are read again after an authorization changes (end-to-end finding D1: they stayed stale until a reload).
    await waitFor(() => expect(readinessReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByText(/History \(1 earlier version\)/)).toBeInTheDocument());
    expect(screen.getByText(/Latest change: Reduced by the payer/)).toBeInTheDocument();
  });
});
