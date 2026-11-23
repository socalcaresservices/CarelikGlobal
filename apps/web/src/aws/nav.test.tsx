// Main menu: exactly one item is current (highlighted, aria-current="page") on
// its own page and its child pages. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const hrefsIn = (el: HTMLElement) => Array.from(el.querySelectorAll("a")).map((a) => a.getAttribute("href"));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("main menu: one current item", () => {
  // [path, the sidebar item that is current]. The section tab strip is gone: the sidebar is the only navigation, so every page of a section is a sidebar item.
  it.each([
    ["/", "Dashboard"],
    ["/action-needed", "Dashboard"],
    ["/clients", "Clients"],
    ["/clients/cccccccc-0000-4000-8000-000000000001", "Clients"],
    ["/authorization-impacts", "Authorization changes"],
    ["/care-team", "Caregivers"],
    ["/care-team/abababab-0000-4000-8000-000000000001", "Caregivers"],
    ["/care-team/recruiting", "Recruiting"],
    ["/documents", "Documents"],
    ["/schedule", "Schedule"],
    ["/schedule/shift-requests", "Requests"],
    ["/care-requests", "Requests"],
    ["/service-verification/reports?view=calendar", "Calendar"],
    ["/service-verification/reports?view=overview", "Reports"],
    ["/billing-review", "Billing"],
    ["/service-verification/reports", "Visits"],
    ["/service-verification/reports?view=exceptions", "Visits to review"],
    ["/outage-visits", "Outage records"],
    ["/services", "Agency Settings"],
    ["/settings/services", "Agency Settings"],
    ["/continuity", "Continuity"],
    ["/settings/appearance", "Agency Settings"],
  ])("manager on %s: %s is the one current menu item, and there is no strip of tabs", async (path, item) => {
    renderAt(path, "manager");
    await waitFor(async () => expect(await currentItems()).toEqual([item]));
    expect(screen.queryByRole("navigation", { name: "Section tabs" })).toBeNull();
  });

  it("Verify visit is the caregiver's task: it is not in the manager's menu", async () => {
    renderAt("/service-verification/reports", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: /^Verify visit$/i })).toBeNull();
  });

  it("a page outside the menu (Profile) marks nothing current", async () => {
    renderAt("/profile", "manager");
    await screen.findByRole("navigation", { name: "Main" });
    expect(await currentItems()).toEqual([]);
  });

  it("moving between Visits and Visits to review keeps exactly one current item", async () => {
    renderAt("/service-verification/reports", "manager");
    await waitFor(async () => expect(await currentItems()).toEqual(["Visits"]));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "Main" })).getByRole("link", { name: "Visits to review" }));
    await waitFor(async () => expect(await currentItems()).toEqual(["Visits to review"]));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Visits" }));
    await waitFor(async () => expect(await currentItems()).toEqual(["Visits"]));
  });

  it("the caregiver menu is the caregiver's own day: My Schedule, Verify Visit, Availability and My documents, and no strip of tabs", async () => {
    renderAt("/service-verification", "caregiver");
    await waitFor(async () => expect(await currentItems()).toEqual(["Verify Visit"]));
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: "Reports" })).toBeNull();
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["My Schedule", "Verify Visit", "Availability", "My documents"]);
    expect(screen.queryByRole("navigation", { name: "Section tabs" })).toBeNull();
  });
});

describe("main menu structure", () => {
  it("groups in the agreed order, each collapsible; the Dashboard is a plain link; children are indented alike and carry no icons", async () => {
    renderAt("/", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const sections = Array.from(nav.querySelectorAll<HTMLElement>('[data-nav-level="section"]'));
    expect(sections.map((s) => s.textContent?.replace(/\d+$/, "").trim())).toEqual(["Clients", "Staff", "Scheduling", "Operations", "Settings"]);
    expect(within(nav).getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    for (const s of sections) { expect(s).toHaveAttribute("aria-expanded"); expect(s).toHaveAttribute("aria-controls"); }
    // nothing is open on the Dashboard until the person opens a group
    expect(sections.map((s) => s.getAttribute("aria-expanded"))).toEqual(["false", "false", "false", "false", "false"]);
    for (const s of sections) fireEvent.click(s);
    expect(Array.from(nav.querySelectorAll('[data-nav-level="section"]')).every((s) => s.getAttribute("aria-expanded") === "true")).toBe(true);
    const children = Array.from(nav.querySelectorAll<HTMLElement>('[data-nav-level="child"]'));
    expect(children.map((c) => c.textContent?.replace(/\d+$/, "").trim())).toEqual(["Clients", "Authorization changes", "Caregivers", "Recruiting", "Documents", "Schedule", "Calendar", "Requests", "Reports", "Billing", "Visits", "Visits to review", "Outage records", "Agency Settings", "Continuity"]);
    for (const c of children) { expect(c.querySelector("svg")).toBeNull(); expect(c.closest("li")?.querySelectorAll("a").length).toBe(1); }
    expect(new Set(children.map((c) => c.className.match(/min-h-\[30px\]/)?.[0])).size).toBe(1);
  });

  it("every destination the menu had stays reachable from the sidebar (Action Needed from the Dashboard and the header badge, Appearance from the footer)", async () => {
    const seen = new Set<string | null>();
    for (const start of ["/", "/clients", "/care-team", "/schedule", "/service-verification/reports?view=overview", "/settings/services"]) {
      renderAt(start, "manager");
      const nav = await screen.findByRole("navigation", { name: "Main" });
      for (const s of nav.querySelectorAll<HTMLElement>('[data-nav-level="section"][aria-expanded="false"]')) fireEvent.click(s);
      hrefsIn(nav).forEach((h) => seen.add(h));
      expect(screen.queryByRole("navigation", { name: "Section tabs" })).toBeNull();
      cleanup();
    }
    for (const h of ["/", "/clients", "/authorization-impacts", "/care-team", "/care-team/recruiting", "/documents", "/schedule", "/schedule/shift-requests",
      "/service-verification/reports?view=calendar", "/service-verification/reports?view=overview", "/billing-review", "/service-verification/reports", "/service-verification/reports?view=exceptions",
      "/outage-visits", "/settings/services", "/continuity"]) expect(seen, h).toContain(h);
  });

  it("the current group opens by itself, a group the person opened stays open as they move, and a group closed by hand stays closed until the page moves into it again", async () => {
    renderAt("/clients", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const section = (name: string) => within(nav).getByRole("button", { name });
    expect(section("Clients")).toHaveAttribute("aria-expanded", "true");
    expect(section("Scheduling")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(section("Scheduling"));
    fireEvent.click(within(nav).getByRole("link", { name: "Authorization changes" }));
    await waitFor(async () => expect(await currentItems()).toEqual(["Authorization changes"]));
    expect(section("Scheduling")).toHaveAttribute("aria-expanded", "true");
    expect(section("Clients")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(section("Clients"));
    expect(section("Clients")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(nav).getByRole("link", { name: "Schedule" }));
    await waitFor(async () => expect(await currentItems()).toEqual(["Schedule"]));
    fireEvent.click(section("Clients"));
    fireEvent.click(within(nav).getByRole("link", { name: "Clients" }));
    await waitFor(async () => expect(await currentItems()).toEqual(["Clients"]));
    expect(section("Clients")).toHaveAttribute("aria-expanded", "true");
  });

  it("there is no second strip of tabs: the pages of a section are sidebar items, the current one marked", async () => {
    renderAt("/schedule/shift-requests", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByRole("navigation", { name: "Section tabs" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "Requests" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Schedule" })).not.toHaveAttribute("aria-current");
  });

  it("Staff and Staff Types, Roles & Permissions are for the people allowed to use them; Agency Settings and Continuity are sidebar items", async () => {
    renderAt("/settings/services", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByRole("navigation", { name: "Section tabs" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "Agency Settings" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Continuity" })).toBeInTheDocument();
    for (const name of ["Staff", "Staff Types", "Roles & Permissions"]) expect(within(nav).queryByRole("link", { name })).toBeNull();
  });
});
