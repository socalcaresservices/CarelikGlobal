// Offices (0110): Settings > Offices, a client's responsible office, and the Office filters. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { applyBillingFilters, NO_FILTERS } from "./billing-filters";
import { officeMatches } from "./offices";
import type { BillingReviewRow } from "@/lib/sv-backend";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const NORTH = "dddddddd-0000-4000-8000-000000000001";
const SOUTH = "dddddddd-0000-4000-8000-000000000002";
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const OFFICES = [
  { officeId: NORTH, name: "North Office", isActive: true, clientCount: 1 },
  { officeId: SOUTH, name: "South Office", isActive: false, clientCount: 0 },
];

function renderAt(path: string, opts: { perms: string[]; offices?: "on" | "off"; clientOffice?: string | null }) {
  const posts: Array<{ path: string; body: unknown }> = [];
  let assigned = opts.clientOffice ?? null;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); posts.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/office")) { assigned = (body as { officeId: string | null }).officeId; return json(200, { status: assigned ? "set" : "cleared" }); }
      if (url.pathname === "/v1/offices") return json(200, { officeId: "new" });
      return json(200, { status: "ok" });
    }
    switch (url.pathname) {
      case "/v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "owner", permissions: opts.perms }], profile: { displayName: "Synthetic Person" } });
      case "/v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "/v1/offices": return opts.offices === "on" ? json(200, { offices: OFFICES }) : (() => { throw new TypeError("Failed to fetch"); })();   // switch off: the browser sees a failed request, not a clean 404
      case "/v1/client-offices": return opts.offices === "on" ? json(200, { clientOffices: assigned ? [{ clientId: CLIENT, clientCode: "CL-TEST000001", officeId: assigned }] : [] }) : (() => { throw new TypeError("Failed to fetch"); })();
      case "/v1/clients": return json(200, { clients: [{ clientId: CLIENT, clientCode: "CL-TEST000001", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client", city: "Anaheim", clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0 }] });
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

describe("Settings > Offices", () => {
  it("lists offices with their client counts, marks a retired one, and adds an office", async () => {
    const { posts } = renderAt("/settings/offices", { perms: ["organization.update", "visits.read"], offices: "on" });
    const list = await screen.findByRole("list", { name: "Offices" }, { timeout: 15000 });
    expect(within(list).getByText("North Office")).toBeInTheDocument();
    expect(within(list).getByText("Retired")).toBeInTheDocument();
    expect(within(list).getByText("1 client")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New office"), { target: { value: "East Office" } });
    fireEvent.click(screen.getByRole("button", { name: "Add office" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/v1/offices", body: { organizationId: ORG, name: "East Office" } }));
  });
  it("retiring needs a reason, then posts it", async () => {
    const { posts } = renderAt("/settings/offices", { perms: ["organization.update", "visits.read"], offices: "on" });
    const list = await screen.findByRole("list", { name: "Offices" }, { timeout: 15000 });
    fireEvent.click(within(list).getByRole("button", { name: "Retire" }));
    fireEvent.click(screen.getByRole("button", { name: "Retire office" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A reason is required.");
    expect(posts).toEqual([]);
    fireEvent.change(screen.getByLabelText("Reason for retiring (required)"), { target: { value: "Merged into South (synthetic)" } });
    fireEvent.click(screen.getByRole("button", { name: "Retire office" }));
    await waitFor(() => expect(posts).toContainEqual({ path: `/v1/offices/${NORTH}/retire`, body: { organizationId: ORG, reason: "Merged into South (synthetic)" } }));
  });
  it("where the switch is off it says offices are not available yet and shows no controls; a non-Administrator is refused", async () => {
    renderAt("/settings/offices", { perms: ["organization.update", "visits.read"], offices: "off" });
    expect(await screen.findByText("Offices are not available in this environment yet.", {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add office" })).not.toBeInTheDocument();
    cleanup();
    renderAt("/settings/offices", { perms: ["visits.read", "clients.manage"], offices: "on" });
    expect(await screen.findByText("Only the agency Administrator can manage offices.", {}, { timeout: 15000 })).toBeInTheDocument();
  });
});

describe("a client's responsible office", () => {
  it("the client page offers the active offices (and the client's current one even if retired) and saves the choice", async () => {
    const { posts } = renderAt(`/clients/${CLIENT}`, { perms: ["clients.names.read", "clients.manage", "visits.read"], offices: "on" });
    const select = await screen.findByLabelText("Responsible office", {}, { timeout: 15000 });
    expect(within(select).getByRole("option", { name: "North Office" })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: /South Office/ })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: NORTH } });
    await waitFor(() => expect(posts).toContainEqual({ path: `/v1/clients/${CLIENT}/office`, body: { organizationId: ORG, officeId: NORTH } }));
  });
  it("is not shown where offices are not available", async () => {
    renderAt(`/clients/${CLIENT}`, { perms: ["clients.names.read", "clients.manage", "visits.read"], offices: "off" });
    await screen.findByText("Details", {}, { timeout: 15000 });
    expect(screen.queryByLabelText("Responsible office")).not.toBeInTheDocument();
  });
});

describe("the Clients list Office filter", () => {
  it("filters the list by office and by No office, and is absent where offices are not available", async () => {
    renderAt("/clients", { perms: ["clients.names.read", "visits.read"], offices: "on", clientOffice: NORTH });
    const filter = await screen.findByLabelText("Office", {}, { timeout: 15000 });
    expect(await screen.findByText(/Synthetic Client/)).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: SOUTH } });
    expect(await screen.findByText("No clients match.")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: NORTH } });
    expect(await screen.findByText(/Synthetic Client/)).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "none" } });
    expect(await screen.findByText("No clients match.")).toBeInTheDocument();
    cleanup();
    renderAt("/clients", { perms: ["clients.names.read", "visits.read"], offices: "off" });
    expect(await screen.findByText(/Synthetic Client/, {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByLabelText("Office")).not.toBeInTheDocument();
  });
});

describe("Billing review office filter (pure)", () => {
  const row = (code: string): BillingReviewRow => ({ visitId: code, visitNumber: null, serviceCode: "RSP", serviceDate: "2026-11-02", workedMinutes: 60, verifiedMinutes: 60, billableMinutes: 60, visitStatus: "verified", authorizationStatus: null, authorizationVersion: null, confirmationMethod: null, hasSignatureEvidence: true, isCorrection: false, reviewState: "ready", clientCode: code } as unknown as BillingReviewRow);
  const rows = [row("CL-A"), row("CL-B"), row("CL-C")];
  const officeOf = (r: BillingReviewRow) => ({ "CL-A": NORTH, "CL-B": SOUTH } as Record<string, string>)[r.clientCode ?? ""];
  const approval = () => "ready" as never;
  it("keeps only the chosen office's clients; None keeps clients with no office; without an office map the choice is ignored", () => {
    expect(applyBillingFilters(rows, { ...NO_FILTERS, office: NORTH }, approval, officeOf).map((r) => r.visitId)).toEqual(["CL-A"]);
    expect(applyBillingFilters(rows, { ...NO_FILTERS, office: "none" }, approval, officeOf).map((r) => r.visitId)).toEqual(["CL-C"]);
    expect(applyBillingFilters(rows, { ...NO_FILTERS, office: NORTH }, approval).map((r) => r.visitId)).toEqual(["CL-A", "CL-B", "CL-C"]);
    expect(applyBillingFilters(rows, NO_FILTERS, approval, officeOf)).toHaveLength(3);
  });
});

describe("the one Office filter rule (Billing review, Reports, Clients)", () => {
  it("no choice shows all; None shows only clients with no office; an office shows only its clients", () => {
    expect([officeMatches("", undefined), officeMatches("", NORTH)]).toEqual([true, true]);
    expect([officeMatches("none", undefined), officeMatches("none", NORTH)]).toEqual([true, false]);
    expect([officeMatches(NORTH, NORTH), officeMatches(NORTH, SOUTH), officeMatches(NORTH, undefined)]).toEqual([true, false, false]);
  });
});
