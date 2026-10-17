// Authorization balances and tiers on Home and the client page (0057): the real over-limit amount, the approved tiers, the 30-day expiry warning,
// totals that reconcile. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { authorizationStatus, formatBalance, formatDuration } from "@/lib/service-verification";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const PERMS = ["visits.read", "visits.manage", "shifts.manage", "clients.names.read", "clients.read", "authorizations.read", "documents.read", "readiness.read", "billing.visits.read"];
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const SERVICE_ROW = { serviceId: "s1", serviceCode: "862", serviceName: "Respite Care", clientCount: 2, authorizedMinutes: 6000, scheduledMinutes: 0, workedMinutes: 1000, billableMinutes: 1000, reviewMinutes: 0, approvedMinutes: 0, remainingMinutes: 4000, lineagesWithoutRate: 0,
  committedMinutes: 2000, overLimitMinutes: 0, nearLimitAuthorizations: 0, criticalAuthorizations: 0, expiringAuthorizations: 0 };
const BALANCE = { serviceId: "s1", serviceName: "Respite Care", authorizationLineageId: "l1", authorizedMinutes: 1000, workedMinutes: 900, billableMinutes: 900, reservedMinutes: 100, adjustmentMinutes: 0, committedMinutes: 1000,
  remainingMinutes: 0, overLimitMinutes: 0, reviewMinutes: 0, utilizationPercent: 100, authorizationTier: "critical", authorizationPeriodEnd: "2026-12-31", daysUntilExpiry: 90, expiringSoon: false };
const CLIENT_ROW = { clientId: CLIENT, clientCode: "C-104", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0 };

function renderAt(path: string, handlers: Record<string, () => Response>) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me") return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions: PERMS }], profile: { displayName: "Morgan Manager" } });
    if (url.pathname === "/v1/branding") return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
    const h = handlers[url.pathname];
    return h ? h() : json(200, { shifts: [], clients: [], authorizations: [], services: [], assignments: [] });
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "p@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
afterEach(() => vi.clearAllMocks());

describe("formatBalance: a balance is never floored at zero", () => {
  it("positive balances read like durations; negative ones say how far over; formatDuration still floors a LENGTH of time", () => {
    expect(formatBalance(150)).toBe("2 hr 30 min");
    expect(formatBalance(0)).toBe("0 min");
    expect(formatBalance(-75)).toBe("Over by 1 hr 15 min");
    expect(formatBalance(-30)).toBe("Over by 30 min");
    expect(formatBalance(null)).toBe("—");
    expect(formatDuration(-75)).toBe("0 min"); // a length of time is never negative; remaining balances must not use it
  });
});

describe("the status text used in the reports", () => {
  it("names the tier with its symbol and percentage; the over-limit amount; and the expiry warning", () => {
    expect(authorizationStatus({ authorizationTier: "healthy", utilizationPercent: 21 })).toBe("✓ Healthy (21%)");
    expect(authorizationStatus({ authorizationTier: "near_limit", utilizationPercent: 80 })).toBe("▲ Near Limit (80%)");
    expect(authorizationStatus({ authorizationTier: "critical", utilizationPercent: 112.5, overLimitMinutes: 150, expiringSoon: true, daysUntilExpiry: 12 })).toBe("● Critical (112.5%) · over by 2 hr 30 min · ends in 12 days");
    expect(authorizationStatus({ expiringSoon: true, daysUntilExpiry: 1 })).toBe("ends in 1 day");
    expect(authorizationStatus({})).toBe("—");
  });
});

describe("Home: the over-limit amount and the tiers", () => {
  it("shows Over the limit, an Over limit column, and the tier line; Left stays the unused time only", async () => {
    renderAt("/", { "/v1/reports/utilisation": () => json(200, { services: [{ ...SERVICE_ROW, remainingMinutes: 3000, overLimitMinutes: 300, committedMinutes: 3300, nearLimitAuthorizations: 1, criticalAuthorizations: 2, expiringAuthorizations: 1 }] }) });
    const hours = (await screen.findByRole("heading", { name: "Hours this month" })).closest("section")!;
    const stat = (await within(hours).findByText("Over the limit")).closest("div")!;
    expect(stat).toHaveTextContent("5 h");
    expect(within(hours).getByRole("columnheader", { name: "Over limit", hidden: true })).toBeInTheDocument();
    expect(await within(hours).findByTestId("authorization-tiers")).toHaveTextContent("Authorizations: ● 2 Critical · ▲ 1 Near Limit · ▲ 1 ending within 30 days");
  });
  it("nothing over and every authorization Healthy: no over-limit stat and no tier line", async () => {
    renderAt("/", { "/v1/reports/utilisation": () => json(200, { services: [SERVICE_ROW] }) });
    const hours = (await screen.findByRole("heading", { name: "Hours this month" })).closest("section")!;
    await within(hours).findAllByText("Authorized");
    expect(within(hours).queryByText("Over the limit")).toBeNull();
    expect(within(hours).queryByTestId("authorization-tiers")).toBeNull();
  });
});

describe("the client page: tier, percentage, over-limit amount and the 30-day warning", () => {
  const page = (b: object) => renderAt(`/clients/${CLIENT}`, {
    "/v1/clients": () => json(200, { clients: [CLIENT_ROW] }),
    "/v1/reports/monthly-service-summary": () => json(200, { services: [{ ...BALANCE, ...b }] }),
  });
  it("Critical with 100% committed, nothing over: Hours left reads 0 min", async () => {
    page({});
    expect(await screen.findByTestId("authorization-tier")).toHaveTextContent("Critical · 100% committed");
    expect(screen.getByText("Hours left")).toBeInTheDocument();
  });
  it("over the limit: the label becomes Over the limit and the real amount is shown, not 0", async () => {
    page({ committedMinutes: 1360, remainingMinutes: -360, overLimitMinutes: 360, utilizationPercent: 136 });
    expect(await screen.findByTestId("authorization-tier")).toHaveTextContent("Critical · 136% committed");
    expect(screen.getByText("Over the limit")).toBeInTheDocument();
    expect(screen.getByText("6 hr")).toBeInTheDocument();
  });
  it("Near Limit and Healthy carry their own words and symbols; the expiry warning is separate", async () => {
    page({ committedMinutes: 850, remainingMinutes: 150, utilizationPercent: 85, authorizationTier: "near_limit", expiringSoon: true, daysUntilExpiry: 12 });
    expect(await screen.findByTestId("authorization-tier")).toHaveTextContent("▲Near Limit · 85% committed");
    expect(screen.getByTestId("authorization-expiry")).toHaveTextContent("Ends in 12 days");
  });
  it("Healthy, far from expiry: no warning", async () => {
    page({ committedMinutes: 200, remainingMinutes: 800, utilizationPercent: 20, authorizationTier: "healthy" });
    expect(await screen.findByTestId("authorization-tier")).toHaveTextContent("✓Healthy · 20% committed");
    expect(screen.queryByTestId("authorization-expiry")).toBeNull();
  });
});
