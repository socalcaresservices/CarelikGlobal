// Batch 4 route map (docs/releases/2026-10-19-review-updates/ROUTE_MAP.md): every mapped route resolves to its screen for
// the roles that may open it, every OLD address still lands on the right screen, and the menu shows each link only to the
// roles that hold its permission. The screens are replaced by markers here so wording changes cannot break routing;
// route-denial.test.tsx covers the real screens' refusals. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const { marker } = vi.hoisted(() => ({ marker: (id: string) => () => <div data-testid="page">{id}</div> }));
vi.mock("./care-requests-page", () => ({ CareRequestsPage: marker("care-requests") }));
vi.mock("./services-page", () => ({ ServicesPage: marker("services") }));
vi.mock("./schedule-page", () => ({ SchedulePage: marker("schedule"), MyShiftsPage: marker("my-shifts") }));
vi.mock("./recruiting", () => ({ RecruitingPage: marker("recruiting") }));
vi.mock("./documents-page", () => ({ DocumentsPage: marker("documents") }));
vi.mock("./clients-page", () => ({ ClientsPage: marker("clients"), ClientTypeField: () => null }));
vi.mock("./client-detail-page", () => ({ ClientDetailPage: marker("client-detail") }));
vi.mock("./care-team-page", () => ({ CareTeamPage: marker("care-team"), CaregiverDetailPage: marker("caregiver-detail") }));
vi.mock("./amendment-impacts", () => ({ AuthorizationImpactsPage: marker("authorizations") }));
vi.mock("./continuity-page", () => ({ ContinuityPage: marker("continuity") }));
vi.mock("./outage-visits-page", () => ({ OutageVisitsPage: marker("outage-visits") }));
vi.mock("./accounts-page", () => ({ AccountsPage: marker("accounts") }));
vi.mock("./caregiver-availability-page", () => ({ CaregiverAvailabilityPage: marker("availability") }));
vi.mock("./billing-review-page", () => ({ BillingReviewPage: marker("billing-review") }));
vi.mock("./appearance/appearance-page", () => ({ AppearancePage: marker("appearance") }));
vi.mock("./home-page", () => ({ AwsHomePage: marker("home") }));
vi.mock("@/pages/service-verification-page", () => ({ ServiceVerificationPage: marker("verify-visit") }));
vi.mock("@/pages/service-verification-reports-page", () => ({
  ServiceVerificationReportsPage: () => {
    const { search } = useLocation();
    return <div data-testid="page">{`reports${search}`}</div>;
  },
}));

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
type Role = "caregiver" | "manager" | "scheduler" | "organization_owner";
const PERMS: Record<Role, string[]> = {
  manager: ["visits.read", "visits.manage", "billing.visits.read", "shifts.manage", "care_requests.read", "clients.names.read", "caregivers.manage",
    "authorizations.read", "authorizations.update", "documents.read", "continuity.export"],
  organization_owner: ["visits.read", "visits.manage", "billing.visits.read", "billing.read", "organization.update", "accounts.manage", "shifts.manage", "care_requests.read",
    "clients.names.read", "caregivers.manage", "authorizations.read", "authorizations.update", "documents.read", "continuity.export"],
  scheduler: ["shifts.manage", "visits.read", "clients.names.read", "care_requests.read"],
  caregiver: ["availability.manage_own", "documents.manage_own"],
};
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

function renderAt(path: string, role: Role) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me") return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions: PERMS[role] }], profile: { displayName: "Synthetic Person" } });
    if (url.pathname === "/v1/branding") return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
    return json(404, { error: { code: "not_found", message: "No such endpoint." } });
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ID = "cccccccc-0000-4000-8000-000000000001";
// [address, page it must show, role that may open it]  (every row of ROUTE_MAP.md section 3 and 4)
const REACHABLE: [string, string, Role][] = [
  ["/", "home", "manager"],
  ["/schedule", "schedule", "scheduler"],
  ["/schedule/shift-requests", "care-requests", "scheduler"],
  ["/care-requests", "care-requests", "scheduler"], // OLD address
  ["/service-verification/reports?view=calendar", "reports?view=calendar", "manager"],
  ["/service-verification/reports", "reports", "manager"],
  ["/service-verification/reports?view=exceptions", "reports?view=exceptions", "manager"],
  ["/service-verification/reports?view=overview", "reports?view=overview", "manager"],
  ["/service-verification", "verify-visit", "manager"],
  ["/billing-review", "billing-review", "manager"],
  ["/clients", "clients", "manager"],
  [`/clients/${ID}`, "client-detail", "manager"],
  ["/authorization-impacts", "authorizations", "manager"],
  ["/care-team", "care-team", "manager"],
  ["/care-team/recruiting", "recruiting", "manager"],
  [`/care-team/${ID}`, "caregiver-detail", "manager"],
  ["/documents", "documents", "manager"],
  ["/settings/services", "services", "manager"],
  ["/services", "services", "manager"], // OLD address
  ["/settings/appearance", "appearance", "manager"],
  ["/continuity", "continuity", "manager"],
  ["/outage-visits", "outage-visits", "manager"],
  ["/accounts", "accounts", "organization_owner"],
  ["/my-shifts", "my-shifts", "caregiver"],
  ["/availability", "availability", "caregiver"],
  ["/documents", "documents", "caregiver"],
  ["/service-verification", "verify-visit", "caregiver"],
  ["/settings/appearance", "appearance", "caregiver"],
];

describe("route map: every mapped route is reachable by its authorised role", () => {
  it.each(REACHABLE)("%s shows %s for %s", async (path, page, role) => {
    renderAt(path, role);
    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent(new RegExp(`^${page.replace(/[?.]/g, "\\$&")}$`)));
  });

  it("old direct links keep their query string when they redirect", async () => {
    renderAt("/care-requests?client=abc#r1", "scheduler");
    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("care-requests"));
  });

  it("an unknown address still falls back to Home", async () => {
    renderAt("/no-such-screen", "manager");
    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("home"));
  });
});

const linkNames = async () => within(await screen.findByRole("navigation", { name: "Main" })).getAllByRole("link").map((a) => a.textContent?.replace(/\d+$/, ""));
const sectionNames = async (nav: HTMLElement) => within(nav).queryAllByTestId("nav-section").map((e) => e.textContent);

describe("route map: the menu shows each destination only to the roles that hold its permission", () => {
  it("manager: main order Home, Schedule, Visits, Approvals, Clients, Caregivers, Documents, Reports, Settings with the moved items under their parents", async () => {
    renderAt("/", "manager");
    expect(await linkNames()).toEqual([
      "Home", "Schedule", "Shift requests", "Monthly calendar", "Visit records", "Verify visit", "Approvals", "Visits to review", "Clients", "Authorizations",
      "Caregivers", "Recruiting", "Documents", "Reports", "Services", "Continuity pack", "Outage records", "Appearance",
    ]);
    expect(await sectionNames(screen.getByRole("navigation", { name: "Main" }))).toEqual(["Visits", "Settings"]);
  });

  it("scheduler (shifts.manage, care_requests.read, no billing, no documents): sees Schedule and Shift requests, never Services, Accounts, Documents, Recruiting", async () => {
    renderAt("/", "scheduler");
    const names = await linkNames();
    expect(names).toContain("Schedule");
    expect(names).toContain("Shift requests");
    expect(names).toContain("Authorizations"); // shifts.manage may open the Authorization changes screen
    for (const hidden of ["Services", "Accounts", "Documents", "Recruiting", "Continuity pack", "Approvals", "Caregivers"]) expect(names).not.toContain(hidden);
  });

  it("owner also sees Settings as a link to Branding and Accounts under it; the manager sees Settings only as a label", async () => {
    renderAt("/", "organization_owner");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings/branding");
    expect(within(nav).getByRole("link", { name: "Accounts" }).getAttribute("href")).toBe("/accounts");
    cleanup();
    renderAt("/", "manager");
    const nav2 = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav2).queryByRole("link", { name: "Settings" })).toBeNull();
    expect(within(nav2).queryByRole("link", { name: "Accounts" })).toBeNull();
  });

  it("caregiver keeps the simple list: Verify visit, My shifts, Availability, My documents, Appearance", async () => {
    renderAt("/my-shifts", "caregiver");
    expect((await linkNames()).sort()).toEqual(["Appearance", "Availability", "My documents", "My shifts", "Verify visit"]);
  });

  it("no queue appears twice: Visits to review exists once (under Approvals) and Visit records once (under Visits)", async () => {
    renderAt("/", "manager");
    const names = await linkNames();
    for (const once of ["Visits to review", "Visit records", "Verify visit", "Approvals"]) expect(names.filter((n) => n === once)).toHaveLength(1);
  });

  it("the new links open the new addresses", async () => {
    renderAt("/", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const href = (name: string) => within(nav).getByRole("link", { name }).getAttribute("href");
    expect(href("Shift requests")).toBe("/schedule/shift-requests");
    expect(href("Services")).toBe("/settings/services");
    expect(href("Authorizations")).toBe("/authorization-impacts");
    expect(href("Monthly calendar")).toBe("/service-verification/reports?view=calendar");
    fireEvent.click(within(nav).getByRole("link", { name: "Services" }));
    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("services"));
    await waitFor(() => expect(within(nav).getByRole("link", { name: "Services" })).toHaveAttribute("aria-current", "page"));
  });
});
