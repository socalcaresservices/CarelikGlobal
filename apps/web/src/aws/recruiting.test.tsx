// Recruiting and onboarding (0054) against an in-memory fake of the AWS API, through the real API client and routes.
// SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const AP = "abababab-0000-4000-8000-0000000000a1";
const OB = "abababab-0000-4000-8000-0000000000b2";
type Call = { method: string; path: string; body: Record<string, unknown> | null };

const item = (key: string, label: string, category: string, state: string, extra: Record<string, unknown> = {}) =>
  ({ requirementId: key, key, label, category, required: true, state, detail: null, completedOn: null, expiresOn: null, note: null, expiringSoon: false, ...extra });

function fakeApi(role: "manager" | "caregiver" = "manager") {
  const calls: Call[] = [];
  const permissions = role === "manager" ? ["caregivers.manage", "visits.read", "visits.manage", "documents.read"] : ["availability.manage_own"];
  let training = item("training", "Required training completed", "training", "outstanding");
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName: "Synthetic Person" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case "GET /v1/onboarding/overview":
        return json(200, { caregivers: [
          { caregiverRecordId: AP, caregiverCode: "CG-AP", caregiverName: "Synthetic Applicant", status: "applicant", hireType: null, onboardingRequired: true, done: 0, total: 5, nextExpiry: null,
            outstanding: [{ label: "Background check cleared", state: "outstanding", detail: null, category: "background_check" }, { label: "CPR certificate current", state: "expired", detail: "Expired", category: "document" }] },
          { caregiverRecordId: OB, caregiverCode: "CG-OB", caregiverName: "Synthetic Onboardee", status: "pending_documents", hireType: null, onboardingRequired: true, done: 5, total: 5, nextExpiry: "2027-06-01", outstanding: [] },
        ] });
      case "POST /v1/caregivers":
        return json(201, { caregiver: { caregiverRecordId: AP, caregiverCode: "CG-AP" } });
      case `POST /v1/caregivers/${AP}/status`:
        return json(200, { result: { endedAssignments: 0, signInStatus: null } });
      case `POST /v1/caregivers/${OB}/status`:
        return json(409, { error: { code: "conflict", message: "Onboarding is not complete: Compliance clearance" } });
      case "GET /v1/caregivers":
        return json(200, { caregivers: [{ caregiverRecordId: AP, caregiverCode: "CG-AP", firstName: "Synthetic", lastName: "Applicant", preferredName: null, status: "applicant", hasSignIn: false, signInStatus: null, activeAssignments: 0, openVisits: 0, onboardingRequired: true, onboardingDone: 0, onboardingTotal: 5 }] });
      case `GET /v1/caregivers/${AP}/onboarding`:
        return json(200, { onboarding: { caregiverRecordId: AP, status: "applicant", onboardingRequired: true, done: training.state === "done" ? 1 : 0, total: 5, complete: false, items: [
          item("background_check", "Background check cleared", "background_check", "outstanding"), training,
          item("cpr", "CPR certificate current", "document", "outstanding", { detail: "No document uploaded" }), item("tb", "TB clearance current", "document", "outstanding"),
          item("clearance", "Compliance clearance", "clearance", "outstanding")] } });
      case `POST /v1/caregivers/${AP}/onboarding/items`:
        training = item("training", "Required training completed", "training", "done", { completedOn: "2026-10-15", expiresOn: body?.expiresOn ?? null });
        return json(200, { onboarding: {} });
      case "GET /v1/documents/people":
      case "GET /v1/shifts":
        return json(200, { shifts: [], people: [] });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

function renderAt(path: string, role: "manager" | "caregiver" = "manager") {
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

describe("Recruiting board", () => {
  it("shows each stage with progress and exactly what is outstanding", async () => {
    renderAt("/care-team/recruiting");
    expect(await screen.findByRole("heading", { name: "Recruiting" })).toBeInTheDocument();
    const applicant = (await screen.findByText("Synthetic Applicant")).closest("li")!;
    expect(within(applicant).getByRole("img", { name: "0 of 5 requirements satisfied" })).toBeInTheDocument();
    expect(applicant).toHaveTextContent("Outstanding: Background check cleared, CPR certificate current (expired)");
    const stage = screen.getByRole("region", { name: "Applicant" });
    expect(within(stage).getByText("Synthetic Applicant")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Pending documents" })).getByText("Every required item is satisfied.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Interview" })).getByText("None")).toBeInTheDocument();
  });

  it("adds an applicant, moves a person to the next stage, and leaves approval to Approve for work on the record", async () => {
    const api = renderAt("/care-team/recruiting");
    fireEvent.change(await screen.findByLabelText("First name"), { target: { value: "Synthetic" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Newcomer" } });
    fireEvent.click(screen.getByRole("button", { name: "Add applicant" }));
    expect(await screen.findByText(/Applicant added/)).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/caregivers")!.body).toMatchObject({ status: "applicant", firstName: "Synthetic", lastName: "Newcomer" });

    const applicant = screen.getByText("Synthetic Applicant").closest("li")!;
    fireEvent.click(within(applicant).getByRole("button", { name: "Move to Interview" }));
    await vi.waitFor(() => expect(api.calls.some((c) => c.path === `/v1/caregivers/${AP}/status` && (c.body as { status: string }).status === "interview")).toBe(true));

    // 0086: after Pending documents the last step is Approve for work on the caregiver's page, not a stage move
    const pending = screen.getByText("Synthetic Onboardee").closest("li")!;
    expect(within(pending).queryByRole("button", { name: /Move to/ })).not.toBeInTheDocument();
    expect(within(pending).getByRole("link", { name: "Open the record to approve" })).toHaveAttribute("href", `/care-team/${OB}`);
  });

  it("is not available to a caregiver", async () => {
    renderAt("/care-team/recruiting", "caregiver");
    expect(await screen.findByText("You do not have access to recruiting.")).toBeInTheDocument();
  });
});
