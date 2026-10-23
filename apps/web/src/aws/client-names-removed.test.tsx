// A retained, INACTIVE client whose legal name was removed (test-data cleanup): the clients list and the client page still work, show the code
// instead of a name, and keep the authorizations. In-memory fake of the AWS API, through the real API client and routes. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import type { AdminClient, AuthorizationVersion } from "./client-admin";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const SERVICE = "dddddddd-0000-4000-8000-000000000001";
const AUTH = "a1a1a1a1-0000-4000-8000-000000000001";
const NAMELESS = (n: number): AdminClient => ({
  clientId: `cccccccc-0000-4000-8000-00000000000${n}`, clientCode: `CL-${String(n).repeat(10)}`, caregiverDisplayCode: null, status: "inactive",
  legalFirstName: null, legalLastName: null, city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0,
});
const CLIENTS = [NAMELESS(1), NAMELESS(2), NAMELESS(3), NAMELESS(4)];
const authorization: AuthorizationVersion = {
  authorizationId: AUTH, lineageId: AUTH, versionNumber: 1, isCurrent: true, serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care",
  payer: "Synthetic Regional Center", authorizationNumber: "SYN-1", monthlyAuthorizedMinutes: 1800, periodStart: "2026-10-01", periodEnd: "2026-12-31",
  receivedDate: null, sourceReference: null, changeReason: "Created", createdAt: "2026-10-01T00:00:00Z", createdByName: "Morgan Manager", hourlyRateCents: null,
};

function renderAt(path: string) {
  const permissions = ["authorizations.read", "authorizations.update", "clients.manage", "clients.names.manage", "clients.names.read", "visits.manage", "visits.read"];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const one = CLIENTS[0]!.clientId;
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions }], profile: { displayName: "Synthetic Person" } });
      case "GET /v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention": return json(200, { summary: null });
      case "GET /v1/clients": return json(200, { clients: CLIENTS });
      case "GET /v1/client-types": return json(200, { clientTypes: [] });
      case "GET /v1/services": return json(200, { services: [{ serviceId: SERVICE, code: "862", name: "Respite Care", isActive: true }] });
      case `GET /v1/clients/${one}/authorizations`: return json(200, { authorizations: [authorization] });
      case "GET /v1/reports/monthly-service-summary": return json(200, { services: [] });
      case "GET /v1/assignments": return json(200, { assignments: [] });
      case "GET /v1/action-issues": return json(200, { asOf: new Date().toISOString(), matching: 0, limit: 50, offset: 0, counts: { total: 0, critical: 0, urgent: 0, routine: 0, actionNeeded: 0, byQueue: {} }, issues: [] });
      case `GET /v1/clients/${one}/issue-history`: return json(200, { history: { resolved: [] } });
      case `GET /v1/clients/${one}/readiness`: return json(200, { readiness: { clientId: one, status: "inactive", stage: "on_hold", stageNote: null, canSchedule: false, ready: false, services: [] } });
      case `GET /v1/clients/${one}/documents`: return json(200, { documents: [] });
      case "GET /v1/shifts": return json(200, { shifts: [] });
      default: return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const api = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={api} publicApi={api} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
const COLD = 15_000;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("retained inactive clients with no names", () => {
  it("the clients list shows each by its code ('Name not set'), counts the retained authorizations, and search by code still works", async () => {
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
    renderAt("/clients");
    await screen.findByLabelText("Status", undefined, { timeout: COLD });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "inactive" } });
    const table = await screen.findByRole("table", { name: "Clients as a list" }, { timeout: COLD });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    for (const c of CLIENTS) expect(within(table).getByText(new RegExp(`Name not set \\(${c.clientCode}\\)`))).toBeInTheDocument();
    for (const r of rows) expect(r).toHaveTextContent("1 current authorization");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: CLIENTS[2]!.clientCode } });
    await waitFor(() => expect(within(table).getAllByRole("row").slice(1)).toHaveLength(1));
  });

  it("the client page opens with 'Name not set', keeps the authorization and shows no error", async () => {
    renderAt(`/clients/${CLIENTS[0]!.clientId}`);
    expect(await screen.findByRole("heading", { name: "Name not set" }, { timeout: COLD })).toBeInTheDocument();
    expect(await screen.findByText(/Respite Care/, undefined, { timeout: COLD })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
