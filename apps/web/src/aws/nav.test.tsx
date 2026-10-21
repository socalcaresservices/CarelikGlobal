// Main menu: exactly one item is current (highlighted, aria-current="page") on
// its own page and its child pages. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
type Role = "caregiver" | "manager";
const PERMS: Record<Role, string[]> = {
  manager: ["visits.read", "visits.manage", "billing.visits.read", "shifts.manage", "care_requests.read", "clients.names.read", "caregivers.manage",
    "authorizations.read", "documents.read", "continuity.export"],
  caregiver: ["availability.manage_own", "documents.manage_own"],
};

function renderAt(path: string, role: Role) {
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me") {
      return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions: PERMS[role] }], profile: { displayName: "Synthetic Person" } });
    }
    if (url.pathname === "/v1/branding") return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
    if (url.pathname === "/v1/attention") return json(200, { summary: null });
    return json(404, { error: { code: "not_found", message: "No such endpoint." } });
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
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

async function currentItems() {
  const nav = await screen.findByRole("navigation", { name: "Main" });
  return within(nav).queryAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent);
}

afterEach(() => vi.clearAllMocks());

describe("main menu: one current item", () => {
  it.each([
    ["/", "Home"],
    ["/service-verification", "Verify visit"],
    ["/service-verification/reports", "Visit records"],
    ["/service-verification/reports?view=exceptions", "Visits to review"],
    ["/billing-review", "Approvals"],
    ["/schedule", "Schedule"],
    ["/schedule/shift-requests", "Shift requests"],
    ["/care-requests", "Shift requests"],
    ["/service-verification/reports?view=calendar", "Monthly calendar"],
    ["/care-team/recruiting", "Recruiting"],
    ["/documents", "Documents"],
    ["/authorization-impacts", "Authorization changes"],
    ["/services", "Services"],
    ["/settings/services", "Services"],
    ["/settings/appearance", "Appearance"],
    ["/clients", "Clients"],
    ["/clients/cccccccc-0000-4000-8000-000000000001", "Clients"],
    ["/care-team/abababab-0000-4000-8000-000000000001", "Caregivers"],
    ["/continuity", "Continuity pack"],
    ["/outage-visits", "Outage records"],
  ])("manager on %s: only %s is current", async (path, label) => {
    renderAt(path, "manager");
    await waitFor(async () => expect(await currentItems()).toEqual([label]));
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: label })).toHaveStyle({ backgroundColor: expect.anything() });
  });

  it("a page outside the menu (Profile) marks nothing current", async () => {
    renderAt("/profile", "manager");
    await screen.findByRole("navigation", { name: "Main" });
    expect(await currentItems()).toEqual([]);
  });

  it("moving between Verify visit and Visit records keeps exactly one current item", async () => {
    renderAt("/service-verification/reports", "manager");
    await waitFor(async () => expect(await currentItems()).toEqual(["Visit records"]));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Verify visit" }));
    await waitFor(async () => expect(await currentItems()).toEqual(["Verify visit"]));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Visit records" }));
    await waitFor(async () => expect(await currentItems()).toEqual(["Visit records"]));
  });

  it("the caregiver menu is unchanged: Verify visit is current on its page", async () => {
    renderAt("/service-verification", "caregiver");
    await waitFor(async () => expect(await currentItems()).toEqual(["Verify visit"]));
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: "Visit records" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "My shifts" })).toBeInTheDocument();
  });
});

describe("main menu hierarchy", () => {
  it("every item is marked parent or child; parents are bold and aligned, children are indented, regular weight and sit on their own rows under a parent; routes are unchanged", async () => {
    renderAt("/", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const levelled = Array.from(nav.querySelectorAll<HTMLElement>("[data-nav-level]"));
    expect(levelled.length).toBeGreaterThan(8);
    const parents = levelled.filter((e) => e.dataset.navLevel === "parent");
    const children = levelled.filter((e) => e.dataset.navLevel === "child");
    expect(parents.length).toBeGreaterThan(4);
    expect(children.length).toBeGreaterThan(4);
    for (const p of parents) { expect(p.className).toMatch(/font-semibold/); expect(p.className).not.toMatch(/\bml-\d/); }
    for (const c of children) { expect(c.className).toMatch(/ml-6/); expect(c.className).toMatch(/font-normal/); expect(c.className).not.toMatch(/font-medium/); }
    // a child is its own row: its own list item, after a parent in document order
    const order = levelled.map((e) => e.dataset.navLevel);
    expect(order[0]).toBe("parent");
    for (const c of children) expect(c.closest("li")?.querySelectorAll("a").length).toBe(1);
    const hrefs = Array.from(nav.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    for (const h of ["/schedule", "/schedule/shift-requests", "/service-verification/reports?view=exceptions", "/documents", "/clients", "/authorization-impacts", "/care-team/recruiting"]) expect(hrefs).toContain(h);
  });
});
