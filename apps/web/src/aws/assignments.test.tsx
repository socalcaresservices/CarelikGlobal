// Assignments (0024) on the client and caregiver pages, against an in-memory
// fake of the AWS API through the real API client and routes. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { baseCompliance } from "./readiness/fake-api";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const CG = "abababab-0000-4000-8000-000000000001";
const CG_NO_LOGIN = "abababab-0000-4000-8000-000000000002";
const SVC = "dddddddd-0000-4000-8000-000000000001";
const ASG = "efefefef-0000-4000-8000-000000000001";
type Call = { method: string; path: string; body: Record<string, unknown> | null };

function fakeApi(opts: { covered: boolean }) {
  const calls: Call[] = [];
  const permissions = ["assignments.manage", "authorizations.read", "caregivers.manage", "clients.manage", "clients.names.manage", "clients.names.read", "visits.manage", "visits.read"];
  const assignment = { assignmentId: ASG, caregiverRecordId: CG, caregiverCode: "CG-1", caregiverName: "Synthetic Caregiver One", clientId: CLIENT, clientCode: "CL-1", clientName: "Synthetic Client Alpha",
    serviceId: SVC, serviceCode: "PCS", serviceName: "Personal care", effectiveStart: "2026-10-01", effectiveEnd: null, state: "current", hasAuthorization: true };
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body });
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions }], profile: { displayName: "Synthetic Manager" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case "GET /v1/clients":
        return json(200, { clients: [{ clientId: CLIENT, clientCode: "CL-1", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client Alpha", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0 }] });
      case `GET /v1/caregivers/${CG}/onboarding`:
      case `GET /v1/caregivers/${CG_NO_LOGIN}/onboarding`:
        return json(200, { onboarding: { caregiverRecordId: CG, status: "active", onboardingRequired: false, done: 0, total: 0, complete: true, items: [] } });
      case "GET /v1/caregivers":
        return json(200, { caregivers: [
          { caregiverRecordId: CG, caregiverCode: "CG-1", firstName: "Synthetic", lastName: "Caregiver One", preferredName: null, status: "active", hasSignIn: true, signInStatus: "active", activeAssignments: 1, openVisits: 0 },
          { caregiverRecordId: CG_NO_LOGIN, caregiverCode: "CG-2", firstName: "Synthetic", lastName: "Caregiver Two", preferredName: null, status: "ready", hasSignIn: false, signInStatus: null, activeAssignments: 0, openVisits: 0 },
        ] });
      case "GET /v1/services":
        return json(200, { services: [{ serviceId: SVC, code: "PCS", name: "Personal care", isActive: true }] });
      case "GET /v1/client-types":
        return json(200, { clientTypes: [] });
      case `GET /v1/clients/${CLIENT}/authorizations`:
        return json(200, { authorizations: [] });
      case "GET /v1/reports/monthly-service-summary":
        return json(200, { services: [] });
      case "GET /v1/assignments":
        return json(200, { assignments: [assignment] });
      case "POST /v1/assignments":
        return json(201, { assignment: { assignmentId: "new", hasAuthorization: opts.covered, grantsAccess: body?.caregiverRecordId !== CG_NO_LOGIN } });
      case `POST /v1/assignments/${ASG}/end`:
        return json(200, { outcome: "ended" });
      case `GET /v1/caregivers/${CG}/compliance`:
      case `GET /v1/caregivers/${CG_NO_LOGIN}/compliance`:
        return json(200, { compliance: baseCompliance() }); // 0053: the profile also shows compliance; this test is about assignments
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

function renderAt(path: string, opts = { covered: true }) {
  const api = fakeApi(opts);
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

describe("assignments", () => {
  it("client page: lists the assigned caregiver; caregivers without a sign-in can be planned (0025); an uncovered assignment is flagged", async () => {
    const api = renderAt(`/clients/${CLIENT}`, { covered: false });
    const card = (await screen.findByRole("heading", { name: "Caregivers assigned" })).closest("div")!.parentElement!;
    expect(await within(card).findByText(/Synthetic Caregiver One/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Assign" }));
    await screen.findByRole("option", { name: /Synthetic Caregiver Two.*planned: no sign-in yet/ });
    expect((screen.getByRole("option", { name: /Synthetic Caregiver Two/ }) as HTMLOptionElement).disabled).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "Assign" }).at(-1)!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose the caregiver");
    fireEvent.change(screen.getByLabelText("Caregiver"), { target: { value: CG } });
    await screen.findByRole("option", { name: "Personal care (PCS)" });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: SVC } });
    fireEvent.click(screen.getAllByRole("button", { name: "Assign" }).at(-1)!);
    expect(await screen.findByText(/no current authorization covers it/i)).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === "POST" && c.path === "/v1/assignments")!;
    expect(post.body).toMatchObject({ organizationId: ORG, caregiverRecordId: CG, clientId: CLIENT, serviceId: SVC, effectiveEnd: null });
    expect(post.body!.effectiveStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("planning for a caregiver without a sign-in says plainly that no access is given yet", async () => {
    renderAt(`/clients/${CLIENT}`, { covered: true });
    const card = (await screen.findByRole("heading", { name: "Caregivers assigned" })).closest("div")!.parentElement!;
    fireEvent.click(within(card).getByRole("button", { name: "Assign" }));
    await screen.findByRole("option", { name: /Synthetic Caregiver Two/ });
    fireEvent.change(screen.getByLabelText("Caregiver", { exact: true }), { target: { value: CG_NO_LOGIN } });
    await screen.findByRole("option", { name: "Personal care (PCS)" });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: SVC } });
    fireEvent.click(screen.getAllByRole("button", { name: "Assign" }).at(-1)!);
    expect(await screen.findByText(/Planned\. Access starts once the caregiver has signed in/)).toBeInTheDocument();
  });

  it("caregiver page: ending an assignment needs a reason and reports that access stopped", async () => {
    const api = renderAt(`/care-team/${CG}`);
    expect(await screen.findByRole("heading", { name: "Clients assigned" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Synthetic Client Alpha \(CL-1\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    fireEvent.click(screen.getByRole("button", { name: "End assignment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Give a reason");
    fireEvent.change(screen.getByLabelText("Last day of work"), { target: { value: "2026-10-02" } });
    fireEvent.change(screen.getByLabelText("Reason for ending"), { target: { value: "Schedule change" } });
    fireEvent.click(screen.getByRole("button", { name: "End assignment" }));
    expect(await screen.findByText("Assignment ended. Access has stopped.")).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST" && c.path.endsWith("/end"))!.body).toMatchObject({ lastDay: "2026-10-02", reason: "Schedule change" });
  });
});
