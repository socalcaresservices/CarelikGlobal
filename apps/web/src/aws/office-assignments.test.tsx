// Caregiver offices, service counties and Caregiver Color (0111). SYNTHETIC data only. A caregiver with two offices and two counties appears under both
// office filters and once in All Offices; the filters combine with search and status; red/yellow/blue save and show as a swatch next to the name.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { CA_COUNTIES } from "./ca-counties";
import { CAREGIVER_COLORS } from "./caregiver-colors";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const TEM = "dddddddd-0000-4000-8000-000000000001";
const MOV = "dddddddd-0000-4000-8000-000000000002";
const OLD = "dddddddd-0000-4000-8000-000000000003";
const CG1 = "abababab-0000-4000-8000-000000000001";   // Temecula primary + Moreno Valley secondary, Riverside + San Bernardino, yellow
const CG2 = "abababab-0000-4000-8000-000000000002";   // no office, no county, no color
const CG3 = "abababab-0000-4000-8000-000000000003";   // Moreno Valley only, Riverside, red, inactive
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const OFFICES = [
  { officeId: TEM, name: "Temecula Office", isActive: true, clientCount: 0, caregiverCount: 1, county: "Riverside", city: "Temecula" },
  { officeId: MOV, name: "Moreno Valley Office", isActive: true, clientCount: 0, caregiverCount: 2, county: "Riverside", city: "Moreno Valley" },
  { officeId: OLD, name: "Old Office", isActive: false, clientCount: 0, caregiverCount: 0 },
];
const person = (id: string, first: string, workStatus: string) => ({ caregiverRecordId: id, caregiverCode: `CG-${id.slice(-4)}`, firstName: first, lastName: "Tester", preferredName: null, status: workStatus === "inactive" ? "inactive" : "active", workStatus, readinessMet: 5, readinessTotal: 5, signedIn: true, hasContact: true, hasSignIn: true, signInStatus: "active", activeAssignments: 0, openVisits: 0 });

function renderAt(path: string, perms: string[]) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const facets = {
    clientOffices: [], clientCounties: [],
    caregiverOffices: [
      { caregiverRecordId: CG1, caregiverCode: "CG-0001", officeId: TEM, isPrimary: true }, { caregiverRecordId: CG1, caregiverCode: "CG-0001", officeId: MOV, isPrimary: false },
      { caregiverRecordId: CG3, caregiverCode: "CG-0003", officeId: MOV, isPrimary: true },
    ],
    caregiverCounties: [{ caregiverRecordId: CG1, county: "Riverside" }, { caregiverRecordId: CG1, county: "San Bernardino" }, { caregiverRecordId: CG3, county: "Riverside" }],
    caregiverColors: [{ caregiverRecordId: CG1, userId: null, color: "yellow" }, { caregiverRecordId: CG3, userId: null, color: "red" }],
  };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push({ path: url.pathname, body });
      return json(200, { status: "ok" });
    }
    switch (url.pathname) {
      case "/v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "owner", permissions: perms }], profile: { displayName: "Synthetic Person" } });
      case "/v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "/v1/offices": return json(200, { offices: OFFICES });
      case "/v1/people-facets": return json(200, { facets });
      case "/v1/caregivers": return json(200, { caregivers: [person(CG1, "Alpha", "active"), person(CG2, "Bravo", "active"), person(CG3, "Charlie", "inactive")] });
      case "/v1/action-issues": return json(200, { asOf: new Date().toISOString(), matching: 0, limit: 50, offset: 0, counts: { total: 0, critical: 0, urgent: 0, routine: 0, actionNeeded: 0 }, issues: [] });
      default: return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "p@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}><AwsRoutes api={client} publicApi={client} /></CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { posts };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const MANAGER = ["caregivers.manage", "visits.manage", "visits.read", "organization.update"];
const rows = () => screen.getAllByRole("row").slice(1).map((r) => r.textContent ?? "");

describe("Care Team list: offices, counties, colour", () => {
  it("shows primary and additional offices, counties and a swatch beside the name; Unassigned for a caregiver with none", async () => {
    renderAt("/care-team", MANAGER);
    await screen.findByText(/Alpha Tester/, {}, { timeout: 15000 });
    await waitFor(() => expect(screen.getAllByTestId("office-names").length).toBe(1));
    const alpha = rows().find((t) => t.includes("Alpha"))!;
    expect(alpha).toContain("Temecula Office (primary), Moreno Valley Office");
    expect(alpha).toContain("Riverside, San Bernardino");
    expect(rows().find((t) => t.includes("Bravo"))).toContain("Unassigned");
    const swatches = screen.getAllByTestId("caregiver-swatch");
    expect(swatches.map((s) => s.getAttribute("data-color"))).toEqual(["yellow"]);   // Charlie (red) is Inactive and hidden under the default Current status
  });
  it("a caregiver with two offices is found by either office and appears once in All Offices; filters combine with status and search", async () => {
    renderAt("/care-team", MANAGER);
    await screen.findByText(/Alpha Tester/, {}, { timeout: 15000 });
    const office = await screen.findByLabelText("Office");
    expect(rows().filter((t) => t.includes("Alpha"))).toHaveLength(1);
    fireEvent.change(office, { target: { value: TEM } });
    expect(rows().filter((t) => t.includes("Alpha"))).toHaveLength(1);
    expect(rows().some((t) => t.includes("Bravo"))).toBe(false);
    fireEvent.change(office, { target: { value: MOV } });
    expect(rows().filter((t) => t.includes("Alpha"))).toHaveLength(1);              // secondary office matches too
    fireEvent.change(office, { target: { value: "none" } });
    expect(rows().map((t) => t.includes("Bravo"))).toEqual([true]);                  // Unassigned: only Bravo
    fireEvent.change(office, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("County"), { target: { value: "San Bernardino" } });
    expect(rows().map((t) => t.includes("Alpha"))).toEqual([true]);                  // matches any county covered
    fireEvent.change(screen.getByLabelText("County"), { target: { value: "Riverside" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    expect(rows()).toHaveLength(2);                                                  // Alpha and Charlie, each once
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "Charlie" } });
    expect(rows()).toHaveLength(1);
  });
});

describe("Caregiver profile", () => {
  it("manages offices (primary change, add, remove), service counties and the colour; the colour saves red, yellow or blue", async () => {
    const { posts } = renderAt(`/care-team/${CG1}`, MANAGER);
    const list = await screen.findByRole("list", { name: "Assigned Offices" }, { timeout: 15000 });
    expect(list).toHaveTextContent("Temecula Office");
    expect(within(list).getAllByText("Primary")).toHaveLength(1);
    fireEvent.click(within(list).getByRole("button", { name: "Make primary" }));
    await waitFor(() => expect(posts).toContainEqual({ path: `/v1/caregivers/${CG1}/offices`, body: { organizationId: ORG, primaryOfficeId: MOV, secondaryOfficeIds: [TEM] } }));
    fireEvent.click(within(list).getByRole("button", { name: "Remove Moreno Valley Office" }));
    await waitFor(() => expect(posts).toContainEqual({ path: `/v1/caregivers/${CG1}/offices`, body: { organizationId: ORG, primaryOfficeId: TEM, secondaryOfficeIds: [] } }));
    expect(screen.queryByLabelText("Add an office")).not.toBeInTheDocument();   // both active offices are already assigned and the retired one cannot take new assignments
    const counties = await screen.findByRole("list", { name: "Service Counties" });
    fireEvent.click(within(counties).getByRole("button", { name: "Remove San Bernardino County" }));
    await waitFor(() => expect(posts).toContainEqual({ path: `/v1/caregivers/${CG1}/service-counties`, body: { organizationId: ORG, counties: ["Riverside"] } }));
    fireEvent.change(screen.getByLabelText("Add a county"), { target: { value: "Orange" } });
    await waitFor(() => expect(posts).toContainEqual({ path: `/v1/caregivers/${CG1}/service-counties`, body: { organizationId: ORG, counties: ["Riverside", "San Bernardino", "Orange"] } }));
    const group = screen.getByRole("radiogroup", { name: "Caregiver Color" });
    for (const c of ["Red", "Yellow", "Blue"]) expect(within(group).getByRole("radio", { name: new RegExp(c) })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("radio", { name: /Blue/ }));
    await waitFor(() => expect(posts).toContainEqual({ path: `/v1/caregivers/${CG1}/color`, body: { organizationId: ORG, color: "blue" } }));
    fireEvent.click(within(group).getByRole("radio", { name: "No color" }));
    await waitFor(() => expect(posts).toContainEqual({ path: `/v1/caregivers/${CG1}/color`, body: { organizationId: ORG, color: null } }));
    expect(screen.getAllByTestId("caregiver-swatch").length).toBeGreaterThan(0);   // the saved yellow shows beside the name in the heading
  });
  it("a user who may only view (visits.manage) sees the assignments but no editing controls", async () => {
    renderAt(`/care-team/${CG1}`, ["visits.manage", "visits.read"]);
    const list = await screen.findByRole("list", { name: "Assigned Offices" }, { timeout: 15000 });
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Caregiver Color" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add a county")).not.toBeInTheDocument();
  });
});

describe("shared lists", () => {
  it("the palette has red, yellow and blue with a visible outline, and every key is one the database accepts", () => {
    const keys = CAREGIVER_COLORS.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["red", "yellow", "blue"]));
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of CAREGIVER_COLORS) expect(c.line).not.toBe(c.fill);
  });
  it("lists 58 distinct California counties", () => {
    expect(CA_COUNTIES).toHaveLength(58);
    expect(new Set(CA_COUNTIES).size).toBe(58);
    expect(CA_COUNTIES).toContain("Riverside");
  });
});
