// Names, not codes, on administrator screens: the code appears beside a name only where the server flags duplicateName. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import type { AuthorizationVersion } from "./client-admin";
import { nameWithCode } from "./name-label";

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
        return json(200, { clients: [
          { clientId: CLIENT, clientCode: "CL-TWIN0000A1", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Twin", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0, duplicateName: true },
          { clientId: "cccccccc-0000-4000-8000-000000000002", clientCode: "CL-TWIN0000B2", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Twin", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0, duplicateName: true },
          { clientId: "cccccccc-0000-4000-8000-000000000003", clientCode: "CL-ONLY0000C3", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Unique", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0 },
        ] });
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

describe("names with codes only for duplicates", () => {
  it("nameWithCode adds the code only for a flagged duplicate, and keeps the code when no name is visible", () => {
    expect(nameWithCode("Ana Lee", "CL-1", false)).toBe("Ana Lee");
    expect(nameWithCode("Ana Lee", "CL-1", undefined)).toBe("Ana Lee");
    expect(nameWithCode("Ana Lee", "CL-1", true)).toBe("Ana Lee (CL-1)");
    expect(nameWithCode(null, "CL-1", false)).toBe("Name not set (CL-1)");
  });

  it("administrator client list: a unique name shows no code; two clients with the same name show their existing codes", async () => {
    renderAt("/clients", "manager");
    expect(await screen.findByText("Synthetic Unique")).toBeInTheDocument();
    expect(screen.getByText("Synthetic Twin (CL-TWIN0000A1)")).toBeInTheDocument();
    expect(screen.getByText("Synthetic Twin (CL-TWIN0000B2)")).toBeInTheDocument();
    expect(screen.queryByText(/CL-ONLY0000C3/)).toBeNull();
  });
});
