// Care Team and Services screens (0023) against an in-memory fake of the AWS
// API, through the real API client and routes. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CG = "abababab-0000-4000-8000-000000000001";
const SVC = "dddddddd-0000-4000-8000-000000000001";
type Role = "caregiver" | "manager" | "organization_owner";
type Call = { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> };

function fakeApi(role: Role) {
  const calls: Call[] = [];
  const permissions =
    role === "manager" ? ["authorizations.read", "caregivers.manage", "visits.manage", "visits.read"]
    : role === "organization_owner" ? ["authorizations.read", "caregivers.manage", "services.manage", "visits.manage", "visits.read", "organization.update"]
    : ["availability.manage_own", "documents.manage_own"];
  let status = "active";
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body, headers: (init?.headers ?? {}) as Record<string, string> });
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName: "Synthetic Person" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case "GET /v1/caregivers":
        return json(200, { caregivers: [{ caregiverRecordId: CG, caregiverCode: "CG-1A2B3C4D", firstName: "Synthetic", lastName: "Caregiver One", preferredName: null, status, hasSignIn: true, signInStatus: status === "inactive" ? "suspended" : "active", activeAssignments: status === "inactive" ? 0 : 2, openVisits: 0 }] });
      case "POST /v1/caregivers":
        return json(201, { caregiver: { caregiverRecordId: "abababab-0000-4000-8000-000000000002", caregiverCode: "CG-99999999" } });
      case `POST /v1/caregivers/${CG}/status`:
        status = String(body?.status);
        return json(200, { result: { endedAssignments: 2, signInStatus: "suspended" } });
      case "GET /v1/services":
        return json(200, { services: [{ serviceId: SVC, code: "PCS", name: "Personal care", isActive: true }] });
      case "POST /v1/services":
        return json(201, { serviceId: "s2" });
      case `POST /v1/services/${SVC}/status`:
        return json(409, { error: { code: "conflict", message: "Clients still have current authorizations for this service; let them end or amend them first" } });
      case "GET /v1/assignments":
        return json(200, { assignments: [] });
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

describe("Care Team", () => {
  it("manager lists caregivers with sign-in state and adds one with an idempotency key", async () => {
    const api = renderAt("/care-team", "manager");
    expect(await screen.findByText(/Synthetic Caregiver One/)).toBeInTheDocument();
    expect(screen.getByText(/Sign-in active · 2 active assignments/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add caregiver" }));
    fireEvent.click(screen.getByRole("button", { name: "Add caregiver" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("first and last name");
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Synthetic" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Caregiver Two" } });
    fireEvent.change(screen.getByLabelText("Starting status"), { target: { value: "ready" } });
    fireEvent.click(screen.getByRole("button", { name: "Add caregiver" }));
    expect(await screen.findByText(/Caregiver added/)).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === "POST" && c.path === "/v1/caregivers")!;
    expect(post.body).toMatchObject({ organizationId: ORG, firstName: "Synthetic", lastName: "Caregiver Two", preferredName: null, status: "ready" });
    expect(Object.keys(post.headers).map((h) => h.toLowerCase())).toContain("idempotency-key");
  });

  it("making a caregiver inactive needs a reason and reports ended assignments and the suspended sign-in", async () => {
    renderAt(`/care-team/${CG}`, "manager");
    expect(await screen.findByRole("heading", { name: "Synthetic Caregiver One" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Change to"), { target: { value: "inactive" } });
    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reason");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Left the agency (synthetic)" } });
    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    expect(await screen.findByText(/2 assignments ended\. Their sign-in is suspended for this agency\./)).toBeInTheDocument();
  });

  it("caregivers have no Care Team or Services menu and the pages refuse", async () => {
    renderAt("/care-team", "caregiver");
    expect(await screen.findByText("You do not have access to the Care Team.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Care Team" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Services" })).not.toBeInTheDocument();
  });
});

describe("Services", () => {
  it("manager sees the list read-only", async () => {
    renderAt("/services", "manager");
    expect(await screen.findByText(/Personal care/)).toBeInTheDocument();
    expect(screen.getByText(/Only the agency Administrator can change this list/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add service" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
  });

  it("Administrator adds a service; deactivating one in use shows the server's reason", async () => {
    const api = renderAt("/services", "organization_owner");
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "bad code!" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic Respite" } });
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 to 20 letters");
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "RSP" } });
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    expect(await screen.findByText("Service added.")).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/services")!.body).toMatchObject({ code: "RSP", name: "Synthetic Respite" });
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    fireEvent.change(screen.getByLabelText("Reason to deactivate PCS"), { target: { value: "No longer offered" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Deactivate" }).at(-1)!);
    expect(await screen.findByText(/still have current authorizations/)).toBeInTheDocument();
  });
});
