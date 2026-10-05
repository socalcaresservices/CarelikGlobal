// Billing rounding (0029): policy settings and the rounding section of Billing
// review, against an in-memory fake of the AWS API. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const SVC = "dddddddd-0000-4000-8000-000000000001";
const VISIT = "77777777-0000-4000-8000-000000000001";
const LINEAGE = "88888888-0000-4000-8000-000000000001";
type Role = "owner" | "manager";
type Call = { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> };

function fakeApi(role: Role) {
  const calls: Call[] = [];
  const permissions = role === "owner"
    ? ["billing.read", "billing.approve", "billing.visits.read", "billing.rounding.manage", "visits.read", "authorizations.read", "organization.update"]
    : ["billing.approve", "billing.visits.read", "visits.read", "authorizations.read"];
  let adjusted = false;
  const unit = () => ({
    unitKind: "visit", unitKey: VISIT, visitId: VISIT, visitNumber: "CL1-RND-051026-0900-AB", visitCount: 1, authorizationLineageId: LINEAGE,
    clientCode: "CL-1", serviceName: "Respite (synthetic)", payer: "Synthetic Payer", serviceDate: "2026-10-05", workedMinutes: 50, billableMinutes: 50,
    approvedMinutes: 50, allApproved: true, policyVersion: 2, method: "up", incrementMinutes: 15, basis: "per_visit",
    proposedMinutes: 60, adjustmentMinutes: 10, proposedUnits: "4.00", cappedByAuthorization: false,
    adjustmentId: adjusted ? "99999999-0000-4000-8000-000000000001" : null, adjustedBaseMinutes: adjusted ? 50 : null,
    adjustedProposedMinutes: adjusted ? 60 : null, adjustedMinutes: adjusted ? 10 : null, adjustedPolicyVersion: adjusted ? 2 : null,
    state: adjusted ? "approved" : "ready_to_approve",
  });
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body, headers: (init?.headers ?? {}) as Record<string, string> });
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: role === "owner" ? "organization_owner" : "manager", permissions }], profile: { displayName: "Synthetic Person" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case "GET /v1/billing-review":
        return json(200, { visits: [] });
      case "GET /v1/billing-approvals":
        return json(200, { approvals: [] });
      case "GET /v1/billing-rounding/preview":
        return json(200, { units: [unit()] });
      case "POST /v1/billing-rounding/adjustments":
        adjusted = true;
        return json(201, { adjustment: { adjustmentId: "99999999-0000-4000-8000-000000000001", baseMinutes: 50, proposedMinutes: 60, adjustmentMinutes: 10, proposedUnits: "4.00", cappedByAuthorization: false } });
      case "GET /v1/services":
        return json(200, { services: [{ serviceId: SVC, code: "RND", name: "Respite (synthetic)", isActive: true }] });
      case "GET /v1/billing-rounding/policies":
        return json(200, { policies: [
          { policyId: "p2", payer: "Synthetic Payer", serviceId: SVC, serviceName: "Respite (synthetic)", version: 2, method: "up", incrementMinutes: 15, basis: "per_visit", payerRuleReference: "Synthetic manual 4.2", payerRuleDate: "2026-01-15", effectiveFrom: "2026-02-01", reason: "15-minute units", createdByName: "Synthetic Owner", createdAt: "2026-10-05T10:00:00Z", inEffectToday: true },
          { policyId: "p1", payer: "Synthetic Payer", serviceId: SVC, serviceName: "Respite (synthetic)", version: 1, method: "none", incrementMinutes: null, basis: null, payerRuleReference: null, payerRuleDate: null, effectiveFrom: "2026-01-01", reason: "Default", createdByName: "Synthetic Owner", createdAt: "2026-10-01T10:00:00Z", inEffectToday: false },
        ] });
      case "POST /v1/billing-rounding/policies":
        return json(201, { policy: { policyId: "p3", version: 3 } });
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

describe("Billing review: rounding section", () => {
  it("shows actual duration, approved minutes, the adjustment and proposed units separately, and approves the adjustment with a key", async () => {
    const api = renderAt("/billing-review", "manager");
    const list = await screen.findByRole("list", { name: "Rounding by visit or day" });
    await within(list).findByText(/visit CL1-RND-051026-0900-AB/);
    // Re-query each time: the list re-renders when the visit approvals finish loading.
    const cardOf = () => within(screen.getByRole("list", { name: "Rounding by visit or day" })).getByText(/visit CL1-RND-051026-0900-AB/).closest("li")!;
    const card = cardOf();
    expect(within(card).getByText("Actual duration").nextSibling).toHaveTextContent("50 min");
    expect(within(card).getByText("Approved (visit)").nextSibling).toHaveTextContent("50 min");
    expect(within(card).getByText("Billing adjustment").nextSibling).toHaveTextContent("+10 min");
    expect(within(card).getByText("Proposed billable").nextSibling).toHaveTextContent("60 min · 4.00 units");
    expect(within(cardOf()).getByText(/policy v2: Round up, 15 min, Each visit/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Rounding policies" })).toBeNull();
    fireEvent.click(within(cardOf()).getByRole("button", { name: "Approve adjustment" }));
    expect(await screen.findByText(/Rounding adjustment approved: \+10 min, 60 min proposed for billing\. Visit records are unchanged\./)).toBeInTheDocument();
    const post = api.calls.find((c) => c.path === "/v1/billing-rounding/adjustments")!;
    expect(post.body).toEqual({ organizationId: ORG, visitId: VISIT });
    expect(Object.keys(post.headers).map((h) => h.toLowerCase())).toContain("idempotency-key");
    expect(await within(list).findByText("Adjustment approved")).toBeInTheDocument();
  });
});

describe("Rounding policies page", () => {
  it("lists every dated version, and requires the payer rule before enabling rounding", async () => {
    const api = renderAt("/settings/billing-rounding", "owner");
    expect(await screen.findByText(/Synthetic Payer · Respite \(synthetic\) · v2/)).toBeInTheDocument();
    expect(screen.getByText(/Payer rule: Synthetic manual 4.2 \(01\/15\/2026\)/)).toBeInTheDocument();
    expect(screen.getByText("in effect today")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Payer (as on the authorizations)"), { target: { value: "Synthetic Payer" } });
    fireEvent.change(await screen.findByLabelText("Service"), { target: { value: SVC } });
    fireEvent.click(screen.getByLabelText("Nearest increment"));
    fireEvent.click(screen.getByLabelText("Daily total (client, service, day)"));
    fireEvent.change(screen.getByLabelText("Effective from (service date)"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("Reason for the change"), { target: { value: "Payer changed its rule (synthetic)" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Record the payer rule");
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(screen.getByLabelText("Payer rule (document and section)"), { target: { value: "Synthetic manual 4.3" } });
    fireEvent.change(screen.getByLabelText("Date of that payer document"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));
    expect(await screen.findByText(/Saved as version 3, effective 11\/01\/2026\. Earlier versions and approved adjustments are unchanged\./)).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({
      organizationId: ORG, payer: "Synthetic Payer", serviceId: SVC, method: "nearest", incrementMinutes: 15, basis: "daily_total",
      payerRuleReference: "Synthetic manual 4.3", payerRuleDate: "2026-10-01", effectiveFrom: "2026-11-01", reason: "Payer changed its rule (synthetic)",
    });
  });

  it("a manager can read the policies but not change them", async () => {
    renderAt("/settings/billing-rounding", "manager");
    expect(await screen.findByText(/Synthetic Payer · Respite \(synthetic\) · v2/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save new version" })).toBeNull();
  });
});
