// Billing review record filters: client, caregiver, service, visit status and approval
// status over the loaded date range. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { applyBillingFilters, filterOptions, NO_FILTERS } from "./billing-filters";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PERMS = ["visits.read", "billing.visits.read", "billing.approve", "clients.names.read"];
const row = (n: number, o: Record<string, unknown>) => ({
  visitId: `bbbbbbbb-0000-4000-8000-00000000000${n}`, visitNumber: `V-${n}`, serviceCode: "862", serviceName: "Respite Care", serviceDate: "2026-10-05",
  workedMinutes: 60, verifiedMinutes: 60, billableMinutes: 60, visitStatus: "signed", authorizationStatus: null, authorizationVersion: 1, confirmationMethod: "signature",
  hasSignatureEvidence: false, isCorrection: false, reviewState: "ready", clientCode: "C-1", clientName: "Client One", caregiverName: "Pat A",
  timeIn: "2026-10-05T17:00:00Z", timeOut: "2026-10-05T18:00:00Z", eligibleMinutes: 60, ...o,
});
const ROWS = [
  row(1, {}),
  row(2, { clientCode: "C-2", clientName: "Client Two", caregiverName: "Sam B", serviceCode: "T1019", serviceName: "Personal Care" }),
  row(3, { visitStatus: "administrator_review", reviewState: "needs_review", clientCode: "C-2", clientName: "Client Two", caregiverName: "Pat A" }),
  row(4, {}), // approved below
];
const APPROVALS = [{ billingApprovalId: "cccccccc-0000-4000-8000-000000000001", visitId: ROWS[3]!.visitId, visitNumber: "V-4", serviceDate: "2026-10-05", approvedMinutes: 60,
  billableMinutesAtApproval: 60, approvedAt: "2026-10-06T00:00:00Z", approvedByName: "Morgan Manager", notes: null, voidedAt: null, voidedByName: null, voidReason: null, rateCents: null, amountCents: null }];

function renderPage(width = 1024) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.matchMedia = ((q: string) => ({ matches: width < 768 && /max-width/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.pathname + url.search);
    switch (url.pathname) {
      case "/v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions: PERMS }], profile: { displayName: "Morgan Manager" } });
      case "/v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "/v1/attention": return json(200, { summary: null });
      case "/v1/billing-review": return json(200, { visits: ROWS });
      case "/v1/billing-approvals": return json(200, { approvals: APPROVALS });
      case "/v1/billing-rounding/preview": return json(200, { units: [] });
      default: return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "m@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={["/billing-review"]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { seen };
}

afterEach(() => vi.clearAllMocks());
const pick = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const tableRows = () => screen.getAllByRole("row").slice(1);

describe("Billing review filters", () => {
  it("filters the loaded date range by client, caregiver, service, visit status and approval status; Clear filters restores everything", async () => {
    const { seen } = renderPage();
    await screen.findByText("4 visits in this date range");
    expect(tableRows()).toHaveLength(4);

    pick("Client", "C-2");
    expect(await screen.findByText("Showing 2 of 4 visits in this date range")).toBeInTheDocument();
    expect(screen.getByText("Filters (1 active)")).toBeInTheDocument();
    expect(tableRows()).toHaveLength(2);

    pick("Caregiver", "Sam B");
    expect(await screen.findByText("Showing 1 of 4 visits in this date range")).toBeInTheDocument();
    expect(screen.getByText("Filters (2 active)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(tableRows()).toHaveLength(4));
    expect(screen.getByText("Filters")).toBeInTheDocument();

    pick("Service", "Personal Care (T1019)");
    await waitFor(() => expect(tableRows()).toHaveLength(1));
    pick("Service", "");
    pick("Visit status", "administrator_review");
    await waitFor(() => expect(tableRows()).toHaveLength(1));
    pick("Visit status", "");
    pick("Approval status", "approved_for_billing");
    await waitFor(() => expect(tableRows()).toHaveLength(1));
    expect(within(tableRows()[0]!).getByText(/Approved 1 h/)).toBeInTheDocument();

    // Filtering never refetches or changes records: one billing-review request for the date range.
    expect(seen.filter((s) => s.startsWith("/v1/billing-review"))).toHaveLength(1);
  });

  it("no match: says so, offers Clear filters, and the records are untouched", async () => {
    renderPage();
    await screen.findByText("4 visits in this date range");
    pick("Client", "C-1");
    pick("Visit status", "administrator_review");
    expect(await screen.findByText(/No visits match these filters/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    await waitFor(() => expect(tableRows()).toHaveLength(4));
  });

  it("phone width: the filters sit in a compact collapsible block that is closed by default", async () => {
    renderPage(390);
    const summary = await screen.findByText("Filters");
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });
});

describe("applyBillingFilters (pure)", () => {
  const approvalOf = (r: { visitId: string }) => (r.visitId === ROWS[3]!.visitId ? ("approved_for_billing" as const) : ("ready_for_review" as const));
  it("combines filters with AND and offers only values that exist in the loaded rows", () => {
    const rows = ROWS as never[];
    expect(applyBillingFilters(rows, { ...NO_FILTERS, client: "C-2", visitStatus: "signed" }, approvalOf as never)).toHaveLength(1);
    const o = filterOptions(rows, approvalOf as never);
    expect(o.clients.map(([k]) => k)).toEqual(["C-1", "C-2"]);
    expect(o.approvals.map(([k]) => k).sort()).toEqual(["approved_for_billing", "ready_for_review"]);
  });
});
