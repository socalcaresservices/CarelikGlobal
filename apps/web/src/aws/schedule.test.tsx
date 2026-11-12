// Schedule and My shifts (0026) against an in-memory fake of the AWS API,
// through the real API client and routes. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const SVC = "dddddddd-0000-4000-8000-000000000001";
const CG1 = "abababab-0000-4000-8000-000000000001";
const CG2 = "abababab-0000-4000-8000-000000000002";
const OPEN = "51515151-0000-4000-8000-000000000001";
const COVERED = "51515151-0000-4000-8000-000000000002";
type Role = "caregiver" | "manager";
type Call = { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> };
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
// Shift times always in the future, whenever the suite runs.
const later = (hours: number) => new Date(Date.now() + hours * 3600e3).toISOString();

function fakeApi(role: Role) {
  const calls: Call[] = [];
  const permissions = role === "manager"
    ? ["assignments.manage", "authorizations.read", "caregivers.manage", "clients.names.read", "shifts.manage", "visits.manage", "visits.read"]
    : ["availability.manage_own", "documents.manage_own"];
  const base = { clientId: CLIENT, clientCode: "CL-1", clientName: "Synthetic Client Alpha", serviceId: SVC, serviceCode: "PCS", serviceName: "Personal care",
    localDate: today, hasSignIn: true, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null as string | null };
  let covered = { ...base, shiftId: COVERED, startsAt: later(26), endsAt: later(27), coverageState: "covered", caregiverRecordId: CG1, caregiverCode: "CG-1", caregiverName: "Synthetic Caregiver One" };
  let open = { ...base, shiftId: OPEN, startsAt: later(25), endsAt: later(26), coverageState: "needs_coverage", caregiverRecordId: null as string | null, caregiverCode: null as string | null, caregiverName: null as string | null };
  let mine = { shiftId: COVERED, startsAt: later(26), endsAt: later(27), clientCode: "CL-1", serviceName: "Personal care", coverageState: "covered", canCallOut: true };
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
      case "GET /v1/shifts":
        return json(200, { shifts: [open, covered] });
      case "POST /v1/shifts":
        return json(201, { shift: { shiftId: "new", startsAt: "x", endsAt: "y", reservedMinutes: 180, remainingMinutes: "420" } });
      case `POST /v1/shifts/${COVERED}/callout`:
        covered = { ...covered, coverageState: "needs_coverage", lastCalloutReason: String(body?.reason) };
        return json(200, { coverageState: "needs_coverage" });
      case `POST /v1/shifts/${OPEN}/caregiver`:
        open = { ...open, coverageState: "covered", caregiverRecordId: CG2, caregiverCode: "CG-2", caregiverName: "Synthetic Caregiver Two" };
        return json(200, { coverageState: "covered" });
      case `GET /v1/shifts/${COVERED}/coverage`:
        return json(200, { events: [{ eventType: "called_out", createdAt: `${today}T18:00:00Z`, reason: "Sick (synthetic)", originalCaregiverName: "Synthetic Caregiver One", replacementCaregiverName: null, recordedBy: "caregiver" }] });
      case "GET /v1/my-shifts":
        return json(200, { shifts: [mine] });
      case "GET /v1/open-shifts":
        return json(200, { shifts: [] });
      case `POST /v1/my-shifts/${COVERED}/callout`:
        mine = { ...mine, coverageState: "called_out", canCallOut: false };
        return json(200, { coverageState: "needs_coverage" });
      case "GET /v1/clients":
        return json(200, { clients: [{ clientId: CLIENT, clientCode: "CL-1", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client Alpha", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0 }] });
      case "GET /v1/services":
        return json(200, { services: [{ serviceId: SVC, code: "PCS", name: "Personal care", isActive: true }] });
      case "GET /v1/caregivers":
        return json(200, { caregivers: [
          { caregiverRecordId: CG1, caregiverCode: "CG-1", firstName: "Synthetic", lastName: "Caregiver One", preferredName: null, status: "active", hasSignIn: true, signInStatus: "active", activeAssignments: 1, openVisits: 0 },
          { caregiverRecordId: CG2, caregiverCode: "CG-2", firstName: "Synthetic", lastName: "Caregiver Two", preferredName: null, status: "ready", hasSignIn: false, signInStatus: null, activeAssignments: 0, openVisits: 0 },
        ] });
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

describe("Schedule (staff)", () => {
  it("shows what needs coverage, records a call-out with a reason, and fills the open shift", async () => {
    const api = renderAt("/schedule", "manager");
    expect(await screen.findByText("Unfilled (1)")).toBeInTheDocument();
    expect(screen.queryByText("Open: no caregiver")).toBeNull(); // one Unfilled badge, not a second line
    expect(screen.getAllByTestId("shift-state").map((e) => e.textContent)).toContain("Unfilled");
    const coveredRow = screen.getByText(/Synthetic Caregiver One/).closest("tbody")!;
    fireEvent.click(within(coveredRow).getByRole("button", { name: "Record call-out" }));
    fireEvent.click(within(coveredRow).getAllByRole("button", { name: "Record call-out" }).at(-1)!);
    expect(await within(coveredRow).findByRole("alert")).toHaveTextContent("reason");
    fireEvent.change(within(coveredRow).getByLabelText("Reason for the call-out"), { target: { value: "Sick (synthetic)" } });
    fireEvent.click(within(coveredRow).getAllByRole("button", { name: "Record call-out" }).at(-1)!);
    expect(await screen.findByText(/Call-out recorded\. The shift now needs coverage/)).toBeInTheDocument();
    expect(await screen.findByText("Unfilled (2)")).toBeInTheDocument();
    const callout = api.calls.find((c) => c.path.endsWith("/callout"))!;
    expect(callout.body).toEqual({ organizationId: ORG, reason: "Sick (synthetic)" });
    expect(Object.keys(callout.headers).map((h) => h.toLowerCase())).toContain("idempotency-key");

    const openRow = screen.getAllByTestId("shift-state").find((e) => e.textContent === "Unfilled")!.closest("tbody")!;
    fireEvent.click(within(openRow).getByRole("button", { name: /^Assign caregiver to shift for / }));
    fireEvent.change(within(openRow).getByLabelText("Caregiver"), { target: { value: CG2 } });
    fireEvent.click(within(openRow).getByRole("button", { name: "Assign" }));
    expect(await screen.findByText("Caregiver assigned. The shift is covered.")).toBeInTheDocument();
    expect(api.calls.find((c) => c.path.endsWith("/caregiver"))!.body).toMatchObject({ caregiverRecordId: CG2, reason: null });
  });

  it("schedules a shift: agency-local date and times, open if no caregiver, reports reserved and remaining hours", async () => {
    const api = renderAt("/schedule", "manager");
    fireEvent.click(await screen.findByRole("button", { name: "Add shift" }));
    fireEvent.click(screen.getByRole("button", { name: "Schedule shift" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose the client");
    await screen.findByRole("option", { name: /Synthetic Client Alpha/ });
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: CLIENT } });
    await screen.findByRole("option", { name: "Personal care (PCS)" });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: SVC } });
    fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "22:00" } });
    fireEvent.change(screen.getByLabelText("End time"), { target: { value: "01:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule shift" }));
    expect(await screen.findByText(/Shift scheduled as OPEN \(no caregiver yet\)\. 3 h reserved; 7 h of authorized time left this month\./)).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/shifts")!.body).toEqual({
      organizationId: ORG, clientId: CLIENT, serviceId: SVC, date: today, startTime: "22:00", endTime: "01:00", caregiverRecordId: null,
    });
  });

  it("history lists call-outs with who recorded them; caregivers have no Schedule", async () => {
    renderAt("/schedule", "manager");
    const coveredRow = (await screen.findByText(/Synthetic Caregiver One/)).closest("tbody")!;
    fireEvent.click(within(coveredRow).getByRole("button", { name: "More actions" }));
    fireEvent.click(within(coveredRow).getByRole("button", { name: "History" }));
    expect(await within(coveredRow).findByText(/Synthetic Caregiver One called out \(caregiver\) — Sick \(synthetic\)/)).toBeInTheDocument();
  });
});

describe("My shifts (caregiver)", () => {
  it("lists upcoming shifts by client code and sends a call-out with a reason", async () => {
    const api = renderAt("/my-shifts", "caregiver");
    const shiftDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(later(26)));
    const nextSunday = new Date(`${today}T12:00:00Z`);
    nextSunday.setUTCDate(nextSunday.getUTCDate() + 7 - nextSunday.getUTCDay());
    if (shiftDate >= nextSunday.toISOString().slice(0, 10)) {
      fireEvent.click(await screen.findByRole("button", { name: "Next week" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: /shifts available/ }));
    expect(await screen.findByText(/Client CL-1 · Personal care/)).toBeInTheDocument();
    expect(screen.queryByText(/Synthetic Client Alpha/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Schedule" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I can't make it" }));
    fireEvent.click(screen.getByRole("button", { name: "Tell the office" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("why you can't come");
    fireEvent.change(screen.getByLabelText("Why can't you come?"), { target: { value: "Car broke down (synthetic)" } });
    fireEvent.click(screen.getByRole("button", { name: "Tell the office" }));
    expect(await screen.findByText(/The office has been told/)).toBeInTheDocument();
    expect(await screen.findByText(/You called out\. The office is finding cover\./)).toBeInTheDocument();
    expect(api.calls.find((c) => c.path.endsWith("/callout"))!.body).toEqual({ organizationId: ORG, reason: "Car broke down (synthetic)" });
  });
});
