// Left sidebar (expanded / collapsed / mobile drawer) and the restyled Home. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { currentLink, visibleGroups, type NavLinkDef } from "./nav-model";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const SERVICE = "bbbbbbbb-0000-4000-8000-000000000001";
type Role = "caregiver" | "manager" | "organization_owner";
const PERMS: Record<Role, string[]> = {
  manager: ["visits.read", "visits.manage", "billing.visits.read", "shifts.manage", "care_requests.read", "clients.names.read", "caregivers.manage",
    "authorizations.read", "documents.read", "continuity.export"],
  organization_owner: ["visits.read", "visits.manage", "billing.visits.read", "billing.read", "organization.update", "shifts.manage", "care_requests.read",
    "clients.names.read", "caregivers.manage", "authorizations.read", "documents.read", "continuity.export"],
  caregiver: ["availability.manage_own", "documents.manage_own"],
};
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

const SUMMARY = { missingTimeOut: 1, notConfirmed: 0, needsReview: 2, lateResponsesToReview: 0, uncoveredShifts: 0, documentsBlocking: 0, documentsToReview: 0, billingReadyUnapproved: 3, awaitingSignature: 0, documentsExpiring: 2, total: 3 };
const OVERVIEW = {
  asOf: "2026-10-18T12:00:00Z", urgentWindowHours: 48,
  urgent: { items: [{ kind: "visit", id: "v1", startsAt: "2026-10-18T09:00:00Z", endsAt: null, reasons: ["missing_clock_out"], severity: "amber", inProgress: true, caregiverRecordId: null, caregiverCode: null, clientCode: "C-104", serviceCode: "862" }], itemCount: 1, issueCount: 1, shifts: 0, visits: 1 },
  upcoming: { count: 0, nextStartsAt: null, shifts: [] },
  documents: { overdue: 0, dueSoon: 2, awaitingReview: 0, rejected: 0 },
  visitReview: { visitsNeedingAttention: 5, awaitingConfirmation: 0, needsReview: 2, lateResponses: 0, readyForApproval: 3, reviewIssues: 2, awaitingResponse: 0 },
};
const ROW = {
  serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care", clientCount: 2, authorizedMinutes: 6000, scheduledMinutes: 240, workedMinutes: 1590,
  billableMinutes: 1470, reviewMinutes: 120, approvedMinutes: 600, remainingMinutes: 4530, lineagesWithoutRate: 0,
  committedMinutes: 1470, overLimitMinutes: 0, nearLimitAuthorizations: 0, criticalAuthorizations: 0, expiringAuthorizations: 0,
};

function renderAt(path: string, role: Role) {
  const owner = role === "organization_owner";
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    switch (url.pathname) {
      case "/v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions: PERMS[role] }], profile: { displayName: "Synthetic Person" } });
      case "/v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "/v1/attention":
        return json(200, { summary: role === "caregiver" ? null : SUMMARY });
      case "/v1/attention/overview":
        return json(200, { overview: OVERVIEW });
      case "/v1/reports/utilisation":
        return json(200, { services: [{ ...ROW, billableValueCents: owner ? 7350 : null, approvedValueCents: owner ? 3000 : null, unusedValueCents: owner ? 22650 : null }] });
      case "/v1/clients":
        return json(200, { clients: [{ clientId: "cccccccc-0000-4000-8000-000000000001", clientCode: "C-104", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client Alpha", city: "Riverside", clientTypeId: null, clientTypeName: null, currentAuthorizations: 2, openVisits: 0 }] });
      case "/v1/services":
        return json(200, { services: [{ serviceId: SERVICE, code: "862", name: "Respite Care", isActive: true }] });
      case "/v1/caregivers":
        return json(200, { caregivers: [] });
      case "/v1/shifts": {
        const at = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
        return json(200, { shifts: [{ shiftId: "s1", clientId: "cccccccc-0000-4000-8000-000000000001", clientCode: "C-104", clientName: "Synthetic Client Alpha", serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care", localDate: "2026-12-01", startsAt: at(30), endsAt: at(32),
          hasSignIn: true, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null, coverageState: "covered", caregiverRecordId: "g1", caregiverCode: "CG-1", caregiverName: "Synthetic Caregiver" }] });
      }
      case "/v1/continuity/status":
        return json(200, { status: { lastDownloadedAt: "2026-10-05T10:00:00Z", lastDownloadedBy: "Synthetic Manager", hoursSince: "30", downloadsLast7Days: 1, outageNumbersIssued: 25 } });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
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

function mockMobile(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }));
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const hrefs = (nav: HTMLElement) => Object.fromEntries(within(nav).getAllByRole("link").map((a) => [(a.textContent ?? "").replace(/\d+$/, ""), a.getAttribute("href")]));

describe("navigation model", () => {
  const icon = (() => null) as never;
  const link = (over: Partial<NavLinkDef>): NavLinkDef => ({ to: "/x", label: "X", group: "HOME", show: true, icon, ...over });

  it("keeps the group order and drops groups with nothing visible", () => {
    const groups = visibleGroups([link({ label: "A", group: "SETUP" }), link({ label: "B", group: "HOME" }), link({ label: "C", group: "WORK", show: false })]);
    expect(groups.map((g) => g.group)).toEqual(["HOME", "SETUP"]);
  });

  it("one current link per address: Visit records, Reports and Client monthly calendar share a route but not a view", () => {
    const path = "/service-verification/reports";
    const links = [
      link({ to: path, label: "Visit records", matchView: (v) => v !== "overview" && v !== "calendar" }),
      link({ to: path, search: "?view=overview", label: "Reports", matchView: (v) => v === "overview" }),
      link({ to: path, search: "?view=calendar", label: "Client monthly calendar", matchView: (v) => v === "calendar" }),
    ];
    expect(currentLink(links, path, "")?.label).toBe("Visit records");
    expect(currentLink(links, path, "?view=overview")?.label).toBe("Reports");
    expect(currentLink(links, path, "?view=calendar")?.label).toBe("Client monthly calendar");
    expect(currentLink(links, "/visits/abc", "")?.label).toBe("Visit records");
  });
});

describe("sidebar: expanded", () => {
  it("manager: grouped links, every earlier destination kept, Reports and Client monthly calendar added on the existing reports route", async () => {
    renderAt("/", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByText(/^(HOME|MY WORK|WORK|SETUP)$/).map((e) => e.textContent)).toEqual(["WORK", "SETUP"]);
    // Five areas in workflow order, each with its related pages beneath it; administration last.
    expect(within(nav).getAllByRole("link").map((a) => a.textContent?.replace(/\d+$/, ""))).toEqual([
      "Home", "Clients", "Care requests", "Monthly calendar", "Caregivers", "Recruiting", "Documents & compliance", "Scheduling", "Approvals", "Visits to review", "Visit records",
      "Verify visit", "Reports", "Services", "Continuity pack", "Outage records", "Appearance",
    ]);
    // Authorizations are a section of each client's page, not a separate menu item.
    expect(within(nav).queryByRole("link", { name: /^Authorizations$/ })).toBeNull();
    expect(hrefs(nav)).toEqual({
      "Home": "/", "Verify visit": "/service-verification", "Scheduling": "/schedule", "Care requests": "/care-requests",
      "Visit records": "/service-verification/reports", "Reports": "/service-verification/reports?view=overview",
      "Visits to review": "/service-verification/reports?view=exceptions", "Monthly calendar": "/service-verification/reports?view=calendar",
      "Approvals": "/billing-review", "Clients": "/clients", "Caregivers": "/care-team", "Recruiting": "/care-team/recruiting", "Documents & compliance": "/documents", "Services": "/services",
      "Continuity pack": "/continuity", "Outage records": "/outage-visits", "Appearance": "/settings/appearance",
    });
    // Settings stays Administrator-only (organization.update), unchanged.
    expect(within(nav).queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("owner also sees Settings; the footer shows the view, name, email, Profile and Sign out", async () => {
    renderAt("/", "organization_owner");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings/branding");
    expect(await screen.findByText("ADMINISTRATOR VIEW")).toBeInTheDocument();
    expect(screen.getByText("Synthetic Person")).toBeInTheDocument();
    expect(screen.getByText("person@example.test")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Profile" }).getAttribute("href")).toBe("/profile");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("the agency card shows the agency name from existing data and no hard-coded name or environment badge", async () => {
    renderAt("/", "manager");
    expect(await screen.findByText("Synthetic Care Co", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText(/synthetic data|test environment/i)).toBeNull();
  });

  it("caregiver: only the caregiver links under MY WORK (and Appearance, which every person may set for themselves)", async () => {
    renderAt("/service-verification", "caregiver");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(Object.keys(hrefs(nav)).sort()).toEqual(["Appearance", "Availability", "My documents", "My shifts", "Verify visit"]);
    expect(within(nav).getAllByText(/^(MY WORK|WORK|SETUP)$/).map((e) => e.textContent)).toEqual(["MY WORK", "SETUP"]);
  });

  it("hides the sidebar and gives the page the full width when printing", async () => {
    renderAt("/", "manager");
    const aside = (await screen.findByRole("navigation", { name: "Main" })).closest("aside")!;
    expect(aside.className).toMatch(/print:hidden/);
    expect(document.querySelector("header")!.className).toMatch(/print:hidden/);
    expect(document.querySelector("main")!.parentElement!.className).toMatch(/print:pr-0/);
  });
});

describe("sidebar: collapse", () => {
  it("collapses to icons with accessible names, shows a tooltip, and remembers the choice", async () => {
    const first = renderAt("/", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const aside = nav.closest("aside")!;
    expect(aside.className).toMatch(/w-64/);
    fireEvent.click(screen.getByRole("button", { name: "Collapse menu" }));
    expect(aside.className).toMatch(/w-\[76px\]/);
    expect(window.localStorage.getItem("ogevia.sidebar.collapsed")).toBe("1");
    // Icon-only, but every control still has its name.
    expect(within(nav).getByRole("link", { name: "Scheduling" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    fireEvent.mouseEnter(within(nav).getByRole("link", { name: "Scheduling" }));
    expect(screen.getByText("Scheduling", { selector: "div[role=presentation]" })).toBeInTheDocument();
    fireEvent.keyDown(within(nav).getByRole("link", { name: "Scheduling" }), { key: "Escape" });
    expect(screen.queryByText("Scheduling", { selector: "div[role=presentation]" })).toBeNull();

    first.unmount();
    renderAt("/", "manager");
    const again = (await screen.findByRole("navigation", { name: "Main" })).closest("aside")!;
    expect(again.className).toMatch(/w-\[76px\]/);
    fireEvent.click(screen.getByRole("button", { name: "Expand menu" }));
    expect(again.className).toMatch(/w-64/);
    expect(window.localStorage.getItem("ogevia.sidebar.collapsed")).toBe("0");
  });
});

describe("sidebar: Option B styling contract", () => {
  it("applies the specified palette, heading, divider, link and selected-row styles", async () => {
    renderAt("/schedule", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const aside = nav.closest("aside")!;
    expect(aside.className).toContain("bg-og-side");
    expect(aside.className).toContain("border-l");
    expect(aside.className).toContain("right-0");
    expect(aside.className).toContain("border-og-line");
    const heading = within(nav).getAllByTestId("nav-group-heading")[0]!;
    expect(heading.textContent).toBe("WORK");
    for (const c of ["text-[11px]", "font-semibold", "leading-[18px]", "tracking-[0.08em]", "text-og-sub"]) {
      expect(heading.className).toContain(c);
    }
    const current = within(nav).getByRole("link", { name: "Scheduling" });
    expect(current).toHaveAttribute("aria-current", "page");
    for (const c of ["bg-og-active", "text-og-accent", "font-semibold", "rounded-md", "min-h-[40px]", "text-[14px]", "gap-2", "[@media(pointer:coarse)]:min-h-[44px]", "focus-visible:outline-og-accent"]) {
      expect(current.className).toContain(c);
    }
    expect(current.className).not.toMatch(/border-l|before:|shadow-\[inset/); // no vertical accent bar
    const other = within(nav).getByRole("link", { name: "Caregivers" });
    for (const c of ["text-og-ink", "font-medium", "hover:bg-og-ink/5"]) expect(other.className).toContain(c);
    expect(other).not.toHaveAttribute("aria-current");
    // Icons are 18px; long labels wrap rather than clip.
    expect(other.querySelector("svg")!.getAttribute("class")).toContain("h-[18px]");
    expect(other.querySelector("span")!.className).toContain("break-words");
  });

  it("collapsed mode hides headings and dividers but keeps accessible link names", async () => {
    window.localStorage.setItem("ogevia.sidebar.collapsed", "1");
    renderAt("/", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).queryAllByTestId("nav-group-heading")).toHaveLength(0);
    expect(nav.querySelector(".border-t")).toBeNull();
    expect(within(nav).getByRole("link", { name: "Caregivers" })).toBeInTheDocument();
    // Collapsed: the five areas, Home, Setup and Appearance only; the smaller related links appear when expanded.
    expect(within(nav).getAllByRole("link")).toHaveLength(10);
  });

  it("keyboard: every link is reachable by Tab order (real anchors) and the collapse control is a labelled button", async () => {
    renderAt("/", "manager");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    for (const a of within(nav).getAllByRole("link")) expect(a).toHaveAttribute("href");
    expect(screen.getByRole("button", { name: "Collapse menu" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("sidebar: mobile drawer", () => {
  it("below 768px the menu button opens the drawer; Escape closes it and returns focus; choosing a link closes it", async () => {
    mockMobile(true);
    renderAt("/", "manager");
    const menu = await screen.findByRole("button", { name: /^Menu/ });
    expect(menu).toHaveTextContent("Home");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    // Closed: the sidebar is removed from the accessibility tree.
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    fireEvent.click(menu);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(menu).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.getByRole("button", { name: "Close menu" })).toHaveFocus());
    fireEvent.keyDown(nav, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull());
    expect(menu).toHaveFocus();
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole("link", { name: "Scheduling" }));
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull());
  });
});

describe("Home layout", () => {
  it("keeps the Home essentials: title, month, four alert tiles, hours with the service table behind details, Outage readiness", async () => {
    renderAt("/", "manager");
    expect(await screen.findByRole("heading", { name: "Home", level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText("Month")).toHaveAttribute("type", "month");
    const tiles = await screen.findByRole("region", { name: "What needs attention" }).catch(() => screen.findByLabelText("What needs attention"));
    for (const [key, label, href] of [["now", "Needs attention now", "/attention"], ["staffing", "Upcoming staffing", "/staffing"], ["documents", "Documents & compliance", "/documents"], ["visits", "Visit review", "/visit-review"]] as const) {
      const tile = await within(tiles).findByTestId(`stream-${key}`);
      expect(tile).toHaveTextContent(label);
      expect(tile).toHaveAttribute("href", href);
    }
    // Visit review counts the unique visits (5), not the sum of unlike things.
    expect(screen.getByTestId("stream-visits")).toHaveTextContent("5");
    const hours = (await screen.findByRole("heading", { name: "Hours this month" })).closest("section")!;
    for (const k of ["Authorized", "Worked", "Billable (confirmed)", "Hours left"]) expect((await within(hours).findAllByText(k)).length).toBeGreaterThan(0);
    // The per-service table is behind a native disclosure, with the same figures and a keyboard-reachable scroller.
    const table = within(hours).getByRole("table", { name: "Hours by service for the selected month" });
    expect(within(table).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Service", "Authorized", "Worked", "Billable", "In review", "Approved", "Scheduled ahead", "Held for review", "To reconcile", "Committed", "Left", "Over limit"]);
    const row = within(table).getAllByRole("row")[1]!;
    expect(row).toHaveTextContent("Respite Care");
    expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual(["100 h", "26.5 h", "24.5 h", "2 h", "10 h", "4 h", "24.5 h", "75.5 h", "0 h"]);
    for (const c of within(row).getAllByRole("cell")) expect(c.className).toMatch(/text-right/);
    const scroller = within(hours).getByRole("region", { name: /scrolls sideways/ });
    expect(scroller.className).toMatch(/overflow-x-auto/);
    expect(scroller).toHaveAttribute("tabindex", "0");
    expect(within(hours).getByRole("link", { name: /Monthly reconciliation/ }).getAttribute("href")).toBe("/service-verification/reports?view=reconciliation");
    expect(screen.queryByText("Financial impact")).toBeNull();
    const outage = (await screen.findByRole("heading", { name: "Outage readiness" })).closest("section")!;
    expect(outage).toHaveTextContent("OUTAGE READINESS: Continuity pack last downloaded 30 hours ago by Synthetic Manager.");
    expect(within(outage).getByRole("link", { name: "Continuity pack" }).getAttribute("href")).toBe("/continuity");
  });

  it("no old catch-all: the removed 'Action needed' sum and its mixed list are gone from Home", async () => {
    renderAt("/", "manager");
    await screen.findByTestId("stream-now");
    expect(screen.queryByText(/^Action needed/)).toBeNull();
    expect(screen.queryByText("Reminders (not counted)")).toBeNull();
  });

  it("Financial impact: the Administrator sees values, no 'Unavailable' cards and no cost/margin tile; the manager sees no dollar value", async () => {
    renderAt("/", "organization_owner");
    expect(await screen.findByText("Financial impact")).toBeInTheDocument();
    expect(screen.getByText("$74")).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(screen.queryByText("Caregiver cost and margin", { selector: "dt" })).toBeNull();
    cleanup();
    renderAt("/", "manager");
    await screen.findByTestId("stream-now");
    expect(screen.queryByText(/\$\d/)).toBeNull();
    expect(screen.queryByText("Financial impact")).toBeNull();
  });
});

describe("Clearer actions and records (presentation only)", () => {
  it("Clients: each row points to the client's authorized hours, and still opens the same client page", async () => {
    renderAt("/clients", "organization_owner");
    // List view (the default on a wide screen): the row names the authorization count and its action points to the authorized hours.
    const link = (await screen.findByText("View authorized hours →")).closest("a")!;
    expect(link.getAttribute("href")).toBe("/clients/cccccccc-0000-4000-8000-000000000001");
    expect(link.closest("tr")).toHaveTextContent("2 current authorizations");
  });

  it("Schedule: shift actions are buttons at least 40px tall, and Cancel shift is visibly different from the others", async () => {
    renderAt("/schedule", "organization_owner");
    const cancel = await screen.findByRole("button", { name: "Cancel shift" });
    const change = screen.getByRole("button", { name: "Change time" });
    for (const b of [cancel, change, screen.getByRole("button", { name: "Record call-out" })]) expect(b.className).toMatch(/min-h-\[40px\]/);
    expect(cancel.className).toMatch(/border-red-700/);
    expect(change.className).not.toMatch(/border-red-700/);
  });
});
