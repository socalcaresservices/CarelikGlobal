// Billing states on the Billing review screen (0062, owner directive 2026-10-17): Needs Correction, Ready for Review, Approved for Billing, Voided, and the
// preserved "Reviewed — not billable". Approval is not submission or payment; there is no "Already Billed". SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { APPROVAL_STATUS_LABEL, billingStateOf } from "./billing-format";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PERMS = ["visits.read", "billing.visits.read", "billing.approve", "clients.names.read"];
const base = (n: number, o: Record<string, unknown>) => ({
  visitId: `bbbbbbbb-0000-4000-8000-00000000000${n}`, visitNumber: `V-${n}`, serviceCode: "862", serviceName: "Respite Care", serviceDate: "2026-10-05",
  workedMinutes: 60, verifiedMinutes: 60, billableMinutes: 60, visitStatus: "signed", authorizationStatus: null, authorizationVersion: 1, confirmationMethod: "signature",
  hasSignatureEvidence: false, isCorrection: false, reviewState: "ready", clientCode: `C-${n}`, clientName: `Client ${n}`, caregiverName: "Pat A",
  timeIn: "2026-10-05T17:00:00Z", timeOut: "2026-10-05T18:00:00Z", eligibleMinutes: 60, ...o,
});
const ROWS = [
  base(1, { billingState: "ready_for_review" }),
  base(2, { billingState: "needs_correction", visitStatus: "administrator_review", reviewState: "needs_review" }),
  base(3, { billingState: "approved_for_billing", activeApprovalId: "cccccccc-0000-4000-8000-000000000003" }),
  base(4, { billingState: "voided", lastVoidAt: "2026-10-06T10:00:00Z", lastVoidReason: "Wrong minutes approved (synthetic)", lastVoidedByName: "Morgan Manager" }),
  base(5, { billingState: "reviewed_not_billable", visitStatus: "administrator_review", reviewState: "reviewed_not_billable", reviewDecision: "close_not_billable" }),
];
const APPROVALS = [{ billingApprovalId: "cccccccc-0000-4000-8000-000000000003", visitId: ROWS[2]!.visitId, visitNumber: "V-3", serviceDate: "2026-10-05", approvedMinutes: 60,
  billableMinutesAtApproval: 60, approvedAt: "2026-10-06T00:00:00Z", approvedByName: "Morgan Manager", notes: null, voidedAt: null, voidedByName: null, voidReason: null, rateCents: null, amountCents: null }];

function renderPage() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
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
}
afterEach(() => vi.clearAllMocks());
const tableRows = () => screen.getAllByRole("row").slice(1);

describe("billing states on the Billing review screen", () => {
  it("shows the server's state for each visit, with the approved words", async () => {
    renderPage();
    await screen.findByText("5 visits in this date range");
    const text = (i: number) => tableRows()[i]!.textContent ?? "";
    expect(text(0)).toContain("Ready for Review");
    expect(text(1)).toContain("Needs Correction");
    expect(text(2)).toContain("Approved for Billing");
    expect(text(3)).toContain("Voided");
    expect(text(4)).toContain("Reviewed — not billable");
  });

  it("Approved for Billing says it is not submitted or paid; nothing says billed, submitted or paid as a state", async () => {
    renderPage();
    await screen.findByText("5 visits in this date range");
    const approved = tableRows()[2]!;
    expect(within(approved).getAllByText(/Not submitted or paid|not submitted or paid/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Already Billed/i)).toBeNull();
    for (const label of Object.values(APPROVAL_STATUS_LABEL)) expect(label).not.toMatch(/billed|paid|submitted/i);
    expect(screen.getByText(/approval is not submission or payment/)).toBeInTheDocument();
  });

  it("a Voided visit shows when, why and by whom, and can be approved again; Reviewed — not billable stays neutral with no approve action", async () => {
    renderPage();
    await screen.findByText("5 visits in this date range");
    const voided = tableRows()[3]!;
    expect(within(voided).getByTestId("void-history")).toHaveTextContent("10/06/2026 by Morgan Manager: Wrong minutes approved (synthetic)");
    expect(within(voided).getByRole("button", { name: "Approve" })).toBeInTheDocument();
    const closed = tableRows()[4]!;
    expect(within(closed).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(closed).queryByRole("link", { name: /Correct or resolve|Review visit/ })).toBeNull();
    expect(within(tableRows()[1]!).getByRole("link", { name: "Correct or resolve" })).toHaveAttribute("href", `/visits/${ROWS[1]!.visitId}`);
  });

  it("the Approval status filter offers exactly the states that are present, including Voided", async () => {
    renderPage();
    await screen.findByText("5 visits in this date range");
    fireEvent.change(screen.getByLabelText("Approval status"), { target: { value: "voided" } });
    await waitFor(() => expect(tableRows()).toHaveLength(1));
    expect(tableRows()[0]!.textContent).toContain("Voided");
  });
});

describe("billingStateOf: an older server without billingState is read by the same rules", () => {
  it("maps review states and an active approval to the new states", () => {
    expect(billingStateOf({ reviewState: "ready" })).toBe("ready_for_review");
    expect(billingStateOf({ reviewState: "reviewed_eligible" })).toBe("ready_for_review");
    expect(billingStateOf({ reviewState: "needs_review" })).toBe("needs_correction");
    expect(billingStateOf({ reviewState: "ready" }, true)).toBe("approved_for_billing");
    expect(billingStateOf({ reviewState: "reviewed_not_billable" })).toBe("reviewed_not_billable");
    expect(billingStateOf({ reviewState: "awaiting_signature" })).toBe("waiting_for_signature");
    expect(billingStateOf({ billingState: "voided", reviewState: "ready" })).toBe("voided");
  });
});
