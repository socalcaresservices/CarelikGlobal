// Authorization balances and tiers on Home and the client page (0057): the real over-limit amount, the approved tiers, the 30-day expiry warning,
// totals that reconcile. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { buildContinuityHtml, type ContinuityPack } from "./continuity-pack";
import { caregiverDifferenceNote, hoursEquation, hoursLeftFigure } from "@/lib/hours-accounting";
import { authorizationStatus, caregiverLeftMinutes, CAREGIVER_BALANCE_NOTE, formatBalance, formatDuration } from "@/lib/service-verification";
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

/** The hours section starts folded; open it unless an earlier test already saved it open. */
function expandHours(hours: HTMLElement) {
  const show = within(hours).queryByRole("button", { name: "Show the hours" });
  if (show) fireEvent.click(show);
}

describe("Home: the over-limit amount and the tiers", () => {
  it("shows Over limit in the summary line, an Over limit column, and the tier line; Hours left stays the unused time only", async () => {
    renderAt("/", { "/v1/reports/utilisation": () => json(200, { services: [{ ...SERVICE_ROW, remainingMinutes: 3000, overLimitMinutes: 300, committedMinutes: 3300, nearLimitAuthorizations: 1, criticalAuthorizations: 2, expiringAuthorizations: 1 }] }) });
    const hours = (await screen.findByRole("heading", { name: "Hours this month" })).closest("section")!;
    const stat = within(await within(hours).findByTestId("hours-summary")).getByText("Over limit").closest("div")!;
    expect(stat).toHaveTextContent("5 h"); // in the summary line: visible while the section is folded
    expandHours(hours);
    expect(within(hours).getByRole("columnheader", { name: "Over limit", hidden: true })).toBeInTheDocument();
    expect(await within(hours).findByTestId("authorization-tiers")).toHaveTextContent("Authorizations: ● 2 Critical · ▲ 1 Near Limit · ▲ 1 ending within 30 days");
  });
  it("nothing over and every authorization Healthy: no over-limit stat and no tier line", async () => {
    renderAt("/", { "/v1/reports/utilisation": () => json(200, { services: [SERVICE_ROW] }) });
    const hours = (await screen.findByRole("heading", { name: "Hours this month" })).closest("section")!;
    expandHours(hours);
    await within(hours).findAllByText("Authorized");
    expect(within(hours).queryByTestId("hours-summary")).not.toHaveTextContent("Over limit");
    expect(within(hours).queryByTestId("authorization-tiers")).toBeNull();
  });
});

describe("the client page: tier, percentage, over-limit amount and the 30-day warning", () => {
  const page = (b: object) => renderAt(`/clients/${CLIENT}`, {
    "/v1/clients": () => json(200, { clients: [CLIENT_ROW] }),
    "/v1/reports/monthly-service-summary": () => json(200, { services: [{ ...BALANCE, ...b }] }),
  });
  it("Critical with 100% committed, nothing over: ONE figure, 'Hours left' 0 h; the tier badge carries no second balance", async () => {
    page({});
    expect(await screen.findByTestId("authorization-tier")).toHaveTextContent(/^●Critical$/);
    expect(screen.getAllByTestId("hours-left-figure")).toHaveLength(1);
    expect(screen.getByTestId("hours-left-figure")).toHaveTextContent("Hours left: 0 h");
  });
  it("over the limit: the label becomes Over limit and the real amount is shown, not 0", async () => {
    page({ committedMinutes: 1360, remainingMinutes: -360, overLimitMinutes: 360, utilizationPercent: 136 });
    expect(await screen.findByTestId("authorization-tier")).toHaveTextContent(/Critical$/);
    expect(screen.getAllByTestId("hours-left-figure")).toHaveLength(1);
    expect(screen.getByTestId("hours-left-figure")).toHaveTextContent("Over limit: 6 h");
    expect(screen.queryByText("Hours left")).toBeNull();
  });
  it("Near Limit and Healthy carry their own words and symbols; the expiry warning is separate", async () => {
    page({ committedMinutes: 850, remainingMinutes: 150, utilizationPercent: 85, authorizationTier: "near_limit", expiringSoon: true, daysUntilExpiry: 12 });
    expect(await screen.findByTestId("authorization-tier")).toHaveTextContent(/^▲Near Limit$/);
    expect(screen.getByTestId("authorization-expiry")).toHaveTextContent("Ends in 12 days");
  });
  it("Healthy, far from expiry: no warning", async () => {
    page({ committedMinutes: 200, remainingMinutes: 800, utilizationPercent: 20, authorizationTier: "healthy" });
    expect(await screen.findByTestId("authorization-tier")).toHaveTextContent(/^✓Healthy$/);
    expect(screen.queryByTestId("authorization-expiry")).toBeNull();
  });
});

describe("the caregiver's left-to-record figure (Start Visit / active visit)", () => {
  it("is signed: room left, exactly zero, and over the limit are three different readings, never a silent 0", () => {
    expect(formatBalance(caregiverLeftMinutes(1000, 90))).toBe("15 hr 10 min");
    expect(formatBalance(caregiverLeftMinutes(1000, 1000))).toBe("0 min");
    expect(formatBalance(caregiverLeftMinutes(100, 140))).toBe("Over by 40 min");
  });
  it("converting through hours (as the API adapter does) never shifts a minute", () => {
    for (let m = 0; m <= 6000; m += 7) expect(caregiverLeftMinutes((m / 60) * 60, 0)).toBe(m);
    for (let used = 0; used <= 600; used += 13) expect(caregiverLeftMinutes(1000, (used / 60) * 60)).toBe(1000 - used);
  });
  it("the note says plainly why the office balance can be lower", () => {
    expect(CAREGIVER_BALANCE_NOTE).toMatch(/confirmed time only/);
    expect(CAREGIVER_BALANCE_NOTE).toMatch(/office Hours left also deducts time that is Pending and Reserved for scheduled visits/);
  });
});

// 0079 hours accounting: Authorized = Billable + Rounding + Pending + Reserved + Hours left, per authorization. The server computes it; these tests pin what is shown.
const HOURS = { hoursBillableMinutes: 300, hoursRoundingMinutes: 15, hoursPendingMinutes: 130, hoursPendingReviewMinutes: 0, hoursPendingHeldMinutes: 130, hoursPendingUnreservedMinutes: 0,
  hoursReservedMinutes: 90, hoursLeftMinutes: 465, hoursOverLimitMinutes: 0, hoursWorkedNotBillableMinutes: 40 };
describe("hours accounting: the equation is visible and adds up", () => {
  it("lists Authorized, Billable, Rounding (only when not zero), Pending, Reserved and Hours left, and they add up", () => {
    const lines = hoursEquation({ authorizedMinutes: 1000, ...HOURS });
    expect(lines.map((l) => l.label)).toEqual(["Authorized", "Billable", "Rounding", "Pending", "Reserved", "Hours left"]);
    const by = Object.fromEntries(lines.map((l) => [l.key, l.minutes])) as Record<string, number>;
    expect(by.billable! + by.rounding! + by.pending! + by.reserved! + by.left!).toBe(by.authorized);
    expect(hoursEquation({ authorizedMinutes: 1000, ...HOURS, hoursRoundingMinutes: 0 }).map((l) => l.label)).not.toContain("Rounding");
  });
  it("a negative Hours left is shown as Over limit, with the amount over, for that authorization only", () => {
    expect(hoursLeftFigure(-60)).toEqual({ label: "Over limit", value: "1 hr", over: true });
    expect(hoursLeftFigure(90)).toEqual({ label: "Hours left", value: "1 hr 30 min", over: false });
    expect(hoursEquation({ authorizedMinutes: 100, ...HOURS, hoursLeftMinutes: -60 }).at(-1)).toMatchObject({ label: "Over limit", minutes: 60 });
  });
  it("the client page shows the equation under Details, with Worked, not billable as its own line", async () => {
    renderAt(`/clients/${CLIENT}`, {
      "/v1/clients": () => json(200, { clients: [CLIENT_ROW] }),
      "/v1/reports/monthly-service-summary": () => json(200, { services: [{ ...BALANCE, authorizedMinutes: 1000, remainingMinutes: 465, ...HOURS }] }),
    });
    const details = await screen.findByTestId("hours-breakdown");
    fireEvent.click(within(details).getByText("Details"));
    for (const label of ["Authorized", "Billable", "Rounding", "Pending", "Reserved", "Hours left"]) expect(within(details).getAllByText(new RegExp(`^${label}`)).length).toBeGreaterThan(0);
    expect(within(details).getByTestId("worked-not-billable")).toHaveTextContent("Worked, not billable: 40 min");
    expect(details).toHaveTextContent("Authorized = Billable + Rounding + Pending + Reserved + Hours left");
  });
  it("the caregiver note names the intentional difference: what the office also deducts", () => {
    expect(caregiverDifferenceNote({ leftToRecordMinutes: 600, hoursLeftMinutes: 380, officePendingMinutes: 130, officeReservedMinutes: 90 })).toMatch(/lower by 1 hr 30 min Reserved for scheduled visits and 2 hr 10 min Pending/);
    expect(caregiverDifferenceNote({ leftToRecordMinutes: 600, hoursLeftMinutes: 600, officePendingMinutes: 0, officeReservedMinutes: 0 })).toMatch(/the same today/);
    expect(caregiverDifferenceNote(null)).toMatch(/Pending and Reserved/);
  });
  it("the continuity pack prints the same buckets, with Over limit shown instead of a negative", () => {
    const pack = { agency: "Synthetic Agency", timezone: "America/Los_Angeles", data_as_of: "2026-10-19T17:00:00Z", export_id: "e", exported_by: "Synthetic", includes_client_names: false, outage_numbers: { first: 1, last: 25 }, shifts: [], clients: [], caregivers: [],
      authorizations: [{ client_code: "C-1", client_label: null, service: "Respite", period_start: "2026-10-01", period_end: "2026-10-31", authorized_minutes: 100, reserved_minutes: 160, billable_minutes: 100, review_minutes: 0, remaining_minutes: -160,
        hours_billable_minutes: 0, hours_rounding_minutes: 0, hours_pending_minutes: 100, hours_reserved_minutes: 60, hours_left_minutes: -60, hours_over_limit_minutes: 60 }] } as unknown as ContinuityPack;
    const html = buildContinuityHtml(pack);
    expect(html).toContain("<th>Pending</th>");
    expect(html).toContain("<th>Over limit</th>");
    expect(html).toContain("<td>1 h 00 min</td>"); // the Over limit amount (60 minutes)
    expect(html).toContain("Authorized = Billable + Rounding + Pending + Reserved + Hours left");
  });
});
