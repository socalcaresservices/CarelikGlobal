// Administrator lists show the client's NAME only (owner TEST finding 5). The code is added beside a name only when the server flags a shared name, and stays in Details
// on the client page. Rows with no name visible to the role keep their code. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { clientLabel } from "./name-label";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const PERMS = ["visits.read", "visits.manage", "shifts.manage", "clients.names.read", "clients.read", "documents.read", "readiness.read", "care_requests.read", "care_requests.manage", "authorizations.read", "compliance.read", "assignments.manage"];
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const at = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();

function renderAt(path: string, routes: Record<string, unknown>, permissions = PERMS) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me") return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions }], profile: { displayName: "Morgan Manager" } });
    if (url.pathname === "/v1/branding") return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
    if (url.pathname in routes) return json(200, routes[url.pathname]);
    return json(200, {});
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "p@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("clientLabel", () => {
  it("name only; the code beside it only when the name is shared; the code alone when no name is visible", () => {
    expect(clientLabel({ clientName: "Robin Unique", clientCode: "CL-1", duplicateName: false })).toBe("Robin Unique");
    expect(clientLabel({ clientName: "Dana Sample", clientCode: "CL-2", duplicateName: true })).toBe("Dana Sample (CL-2)");
    expect(clientLabel({ clientCode: "CL-3" })).toBe("CL-3");
    expect(clientLabel({ clientCode: "CL-3" }, true)).toBe("Client CL-3");
    expect(clientLabel({})).toBeNull();
  });
});

describe("administrator rows show the name, not the code", () => {
  it("Upcoming staffing rows", async () => {
    const shift = { shiftId: "s1", startsAt: at(5), endsAt: at(8), reason: "open", clientCode: "CL-ROBIN1", clientName: "Robin Unique", duplicateName: false, serviceCode: "RSP", serviceName: "Respite" };
    renderAt("/staffing", { "/v1/attention/overview": { overview: { asOf: new Date().toISOString(), urgentWindowHours: 48, urgent: null, upcoming: { count: 1, nextStartsAt: at(5), shifts: [shift] }, documents: null, visitReview: null } } });
    const row = await screen.findByText(/Robin Unique/);
    expect(row).toHaveTextContent("Robin Unique · Respite");
    expect(screen.queryByText(/CL-ROBIN1/)).toBeNull();
  });

  it("Authorization changes: the group heading carries the name; a shared name keeps its code; a role with no name shows 'Client CODE'", async () => {
    const impact = (over: object) => ({ impactId: "i1", createdAt: "2026-10-18T10:00:00Z", impactKind: "visit_over_cap", clientCode: "CL-DANA02", serviceCode: "RSP", serviceName: "Respite", newVersionNumber: 2, newMonthlyMinutes: 1200,
      shiftId: null, shiftStartsAt: null, shiftEndsAt: null, visitId: "v1", serviceDate: "2026-10-10", minutes: 60, bucket: null, stillApplicable: true, acknowledgedAt: null, acknowledgedByName: null, acknowledgementNote: null,
      amendedByName: "Olivia Owner", visitBillingState: null, reviewOpen: null, detail: null, ...over });
    renderAt("/authorization-impacts", { "/v1/authorization-impacts": { impacts: [impact({ clientName: "Dana Sample", duplicateName: true })] } });
    expect(await screen.findByRole("heading", { name: /Dana Sample \(CL-DANA02\) · Respite · version 2/ })).toBeInTheDocument();
    cleanup();
    renderAt("/authorization-impacts", { "/v1/authorization-impacts": { impacts: [impact({ clientName: "Robin Unique", duplicateName: false, clientCode: "CL-ROBIN1" })] } });
    const h = await screen.findByRole("heading", { name: /Robin Unique · Respite · version 2/ });
    expect(h).not.toHaveTextContent("CL-ROBIN1");
    cleanup();
    renderAt("/authorization-impacts", { "/v1/authorization-impacts": { impacts: [impact({})] } });
    expect(await screen.findByRole("heading", { name: /Client CL-DANA02 · Respite · version 2/ })).toBeInTheDocument();
  });

  it("Care requests: the request rows and the client-link selector show names", async () => {
    const request = { requestId: "r1", clientCode: "CL-ROBIN1", clientName: "Robin Unique", duplicateName: false, serviceCode: "RSP", serviceName: "Respite", startsAt: at(30), endsAt: at(33), requestedMinutes: 180, status: "open", shortNotice: false, availableCount: 1, awaitingCount: 0 };
    renderAt("/schedule/shift-requests", {
      "/v1/care-requests": { requests: [request] },
      "/v1/care-portals/clients": { clients: [{ clientId: CLIENT, clientCode: "CL-ROBIN1", clientName: "Robin Unique", duplicateName: false }] },
      "/v1/care-notifications": { notifications: [] }, "/v1/care-alert-staff": { staff: [] },
    });
    const row = await screen.findByText(/Robin Unique · Respite/);
    expect(row).toBeInTheDocument();
    expect(screen.queryByText(/CL-ROBIN1 · Respite/)).toBeNull();
    const option = await screen.findByRole("option", { name: "Robin Unique" });
    expect(option).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "CL-ROBIN1" })).toBeNull();
  });

  it("Compliance holds: shifts at risk name the client", async () => {
    renderAt("/compliance", { "/v1/compliance/holds": { holds: [], totals: { holds: 0, shiftsAtRisk: 1, shiftsAtRiskInProgress: 0 }, shiftsAtRisk: [{ shiftId: "sh1", requirement: "cpr", caregiverRecordId: "g1", caregiverCode: "CG-1", caregiverName: "Alex Lee", clientCode: "CL-ROBIN1", clientName: "Robin Unique", duplicateName: false, startsAt: at(20), endsAt: at(24), inProgress: false, onHold: false, visitId: null, validUntil: null }] } });
    const text = await screen.findByText(/Alex Lee/, { exact: false });
    await waitFor(() => expect(text.closest("li")).toHaveTextContent("· Robin Unique ·"));
    expect(text.closest("li")).not.toHaveTextContent("CL-ROBIN1");
  });

  it("The client page header shows the name only; the code is in Details; a shared name keeps the code beside it", async () => {
    const extra = { [`/v1/clients/${CLIENT}/authorizations`]: { authorizations: [] }, "/v1/reports/monthly-service-summary": { services: [] }, "/v1/client-types": { clientTypes: [] }, "/v1/services": { services: [] }, "/v1/attention": { summary: null } };
    const row = (over: object) => ({ clientId: CLIENT, clientCode: "CL-ROBIN1", caregiverDisplayCode: null, status: "active", legalFirstName: "Robin", legalLastName: "Unique", city: "Pasadena", clientTypeId: null, clientTypeName: null, ...over });
    renderAt(`/clients/${CLIENT}`, { ...extra, "/v1/clients": { clients: [row({ duplicateName: false })] } });
    const heading = await screen.findByRole("heading", { name: "Robin Unique" });
    expect(heading.parentElement).not.toHaveTextContent("CL-ROBIN1");
    expect(screen.queryByTestId("client-code-shared-name")).toBeNull();
    await waitFor(() => expect(screen.getAllByText(/Code: CL-ROBIN1/).length).toBeGreaterThan(0)); // in Details
    cleanup();
    renderAt(`/clients/${CLIENT}`, { ...extra, "/v1/clients": { clients: [row({ duplicateName: true })] } });
    await screen.findByRole("heading", { name: "Robin Unique" });
    expect(await screen.findByTestId("client-code-shared-name")).toHaveTextContent("CL-ROBIN1");
    expect(within(screen.getByTestId("client-code-shared-name").parentElement!).getByRole("heading")).toBeInTheDocument();
  });
});
