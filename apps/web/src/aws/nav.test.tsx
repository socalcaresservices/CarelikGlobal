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
    ["/", "Dashboard"],
    ["/service-verification", "Verify visit"],
    ["/service-verification/reports", "Visits"],
    ["/service-verification/reports?view=exceptions", "Visits to review"],
    ["/billing-review", "Approvals"],
    ["/schedule", "Shifts"],
    ["/schedule/shift-requests", "Requests"],
    ["/care-requests", "Requests"],
    ["/service-verification/reports?view=calendar", "Calendar"],
    ["/action-needed", "Action Needed"],
    ["/care-team/recruiting", "Recruiting"],
    ["/documents", "Documents"],
    ["/authorization-impacts", "Authorization changes"],
    ["/services", "Services"],
    ["/settings/services", "Services"],
    ["/settings/appearance", "Appearance"],
    ["/clients", "Clients"],
    ["/clients/cccccccc-0000-4000-8000-000000000001", "Clients"],
    ["/care-team/abababab-0000-4000-8000-000000000001", "Caregivers"],
    ["/continuity", "Continuity"],
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

  it("moving between Verify visit and Visits keeps exactly one current item", async () => {
    renderAt("/service-verification/reports", "manager");
    await waitFor(async () => expect(await currentItems()).toEqual(["Visits"]));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Verify visit" }));
    await waitFor(async () => expect(await currentItems()).toEqual(["Verify visit"]));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Visits" }));
    await waitFor(async () => expect(await currentItems()).toEqual(["Visits"]));
  });

  it("the caregiver menu is unchanged: Verify visit is current on its page", async () => {
    renderAt("/service-verification", "caregiver");
    await waitFor(async () => expect(await currentItems()).toEqual(["Verify visit"]));
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: "Visits" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "My shifts" })).toBeInTheDocument();
  });
});

describe("main menu hierarchy", () => {
  it("five sections, collapsible; tabs sit 32px in and smaller links 48px in, regular weight, one row each; every earlier destination is still reachable", async () => {
    renderAt("/", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const sections = Array.from(nav.querySelectorAll<HTMLElement>('[data-nav-level="section"]'));
    expect(sections.map((s) => s.textContent?.replace(/\d+$/, "").trim())).toEqual(["Home", "Schedule", "People", "Operations", "Settings"]);
    for (const s of sections) { expect(s.className).toMatch(/font-semibold/); expect(s.className).not.toMatch(/\bml-\d/); expect(s).toHaveAttribute("aria-expanded"); }
    // only the current section is open until the person opens another
    expect(sections.map((s) => s.getAttribute("aria-expanded"))).toEqual(["true", "false", "false", "false", "false"]);
    for (const s of sections.filter((x) => x.getAttribute("aria-expanded") === "false")) fireEvent.click(s);
    expect(Array.from(nav.querySelectorAll('[data-nav-level="section"]')).every((s) => s.getAttribute("aria-expanded") === "true")).toBe(true);
    const tabs = Array.from(nav.querySelectorAll<HTMLElement>('[data-nav-level="tab"]'));
    const children = Array.from(nav.querySelectorAll<HTMLElement>('[data-nav-level="child"]'));
    expect(tabs.length).toBeGreaterThan(8);
    expect(children.length).toBeGreaterThan(2);
    for (const tab of tabs) { expect(tab.className).toMatch(/ml-8/); if (tab.getAttribute("aria-current") !== "page") expect(tab.className).toMatch(/font-normal/); }
    for (const c of children) { expect(c.className).toMatch(/ml-12/); expect(c.className).toMatch(/font-normal/); expect(c.className).not.toMatch(/font-medium/); expect(c.closest("li")?.querySelectorAll("a").length).toBe(1); }
    const hrefs = Array.from(nav.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    for (const h of ["/", "/action-needed", "/schedule", "/schedule/shift-requests", "/service-verification/reports?view=calendar", "/service-verification/reports?view=exceptions", "/documents", "/clients", "/authorization-impacts", "/care-team", "/care-team/recruiting", "/billing-review", "/outage-visits", "/service-verification", "/settings/services", "/settings/appearance", "/continuity"]) expect(hrefs, h).toContain(h);
  });

  it("the current section's tabs are also a horizontal strip above the page, with the current tab marked", async () => {
    renderAt("/schedule/shift-requests", "manager");
    const strip = await screen.findByRole("navigation", { name: "Section tabs" });
    expect(within(strip).getAllByRole("link").map((a) => a.textContent)).toEqual(["Calendar", "Shifts", "Requests"]);
    expect(within(strip).getByRole("link", { name: "Requests" })).toHaveAttribute("aria-current", "page");
    expect(within(strip).getByRole("link", { name: "Shifts" })).not.toHaveAttribute("aria-current");
  });

  it("a smaller link keeps its tab highlighted in the strip (Verify visit under Visits)", async () => {
    renderAt("/service-verification", "manager");
    const strip = await screen.findByRole("navigation", { name: "Section tabs" });
    expect(within(strip).getByRole("link", { name: "Visits" })).toHaveAttribute("aria-current", "page");
    expect(within(strip).queryByRole("link", { name: "Verify visit" })).toBeNull();
  });

  it("the caregiver has no tab strip", async () => {
    renderAt("/service-verification", "caregiver");
    await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByRole("navigation", { name: "Section tabs" })).toBeNull();
  });
});
