// Each count on screen equals the list it opens (owner directive 2026-10-18, item 2.5). SYNTHETIC data only.
// The sidebar badges show the SERVER's counts (GET /v1/attention -> counts, migration 0080) and never recompute them; Approvals keeps exception review and
// billing approval (Ready for Approval) apart; red follows the server's Critical number, not the colour of an item; the Scheduling page agrees with its badge and
// puts a running unfilled shift in "Unfilled" but never an ended one.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const SERVICE = "bbbbbbbb-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const BILL = ["visits.read", "visits.manage", "billing.visits.read", "shifts.manage", "care_requests.read", "clients.names.read", "caregivers.manage", "authorizations.read", "documents.read"];
const NO_BILL = BILL.filter((p) => p !== "billing.visits.read");

type Counts = Record<string, unknown> | null;
const COUNTS = {
  asOf: "2026-10-18T12:00:00Z",
  needsAttention: { count: 4, critical: 1 },
  needsAction: { count: 9, critical: 1 },
  scheduling: { count: 3, critical: 1 },
  caregivers: { count: 2, critical: 0 },
  approvals: { exceptions: { count: 5, critical: 0 }, readyForApproval: 4 },
};
const at = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
const shift = (id: string, startH: number, endH: number, coverageState: string, displayState: string) => ({
  shiftId: id, clientId: CLIENT, clientCode: "C-104", clientName: "Synthetic Client Alpha", serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care", localDate: "2026-12-01",
  startsAt: at(startH), endsAt: at(endH), hasSignIn: false, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null, coverageState, displayState,
  caregiverRecordId: null, caregiverCode: null, caregiverName: null,
});

function renderAt(path: string, permissions: string[], counts: Counts, shifts: unknown[] = []) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    switch (url.pathname) {
      case "/v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions }], profile: { displayName: "Synthetic Person" } });
      case "/v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "/v1/attention": return json(200, { summary: null, counts });
      case "/v1/attention/overview": return json(200, { overview: { asOf: new Date().toISOString(), urgentWindowHours: 48, urgent: null, upcoming: { count: 0, nextStartsAt: null, shifts: [] }, documents: null, visitReview: null } });
      case "/v1/action-issues": return json(200, { asOf: new Date().toISOString(), matching: 0, limit: 50, offset: 0, counts: { total: 0, critical: 0, urgent: 0, routine: 0, actionNeeded: 0, byQueue: {} }, issues: [] });
      case "/v1/shifts": return json(200, { shifts });
      case "/v1/shifts-to-reconcile": return json(200, { shifts: [] });
      case "/v1/services": return json(200, { services: [{ serviceId: SERVICE, code: "862", name: "Respite Care", isActive: true }] });
      case "/v1/clients": return json(200, { clients: [] });
      case "/v1/caregivers": return json(200, { caregivers: [] });
      default: return json(200, {});
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

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

/** The badge on the sidebar link with this accessible name (links read "Label5"), or null. */
async function badgeOn(label: RegExp) {
  const nav = await screen.findByRole("navigation", { name: "Main" });
  for (const b of Array.from(nav.querySelectorAll<HTMLElement>('[data-nav-level="section"][aria-expanded="false"]'))) fireEvent.click(b);   // a group is closed until the page moves into it
  const link = within(nav).getAllByRole("link").find((a) => label.test((a.textContent ?? "").replace(/\d+$/, "")));
  if (!link) throw new Error(`no sidebar link ${label}`);
  const b = within(link).queryByTestId("nav-badge");
  return b ? { n: Number(b.textContent), red: b.className.includes("bg-red-100") } : null;
}
describe("sidebar badges are the server's counts", () => {
  it("someone who may bill: Caregivers 2, Schedule 3 (red: the server says 1 is Critical), Billing shows Ready for Approval 4, the Visits to review item shows exception review 5; none is a sum", async () => {
    renderAt("/billing-review", BILL, COUNTS);
    await waitFor(async () => expect(await badgeOn(/^Schedule$/)).toEqual({ n: 3, red: true }));
    expect(await badgeOn(/^Caregivers$/)).toEqual({ n: 2, red: false }); // amber: nothing Critical, even though documents are shown as overdue elsewhere
    expect(await badgeOn(/^Billing$/)).toEqual({ n: 4, red: false }); // billing approval only; not 4 + 5
    expect(await badgeOn(/^Billing$/)).toEqual({ n: 4, red: false });
    expect(await badgeOn(/^Visits to review$/)).toEqual({ n: 5, red: false }); // exception review only
  });

  it("a closed group with work waiting in two places shows a dot, never a sum of unlike counts", async () => {
    renderAt("/schedule", BILL, COUNTS);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const operations = await waitFor(() => { const s = within(nav).getAllByTestId("nav-section").find((e) => e.querySelector("button")?.textContent?.startsWith("Operations")); if (!s || !s.querySelector('[data-testid="nav-badge"]')) throw new Error("no badge yet"); return s; });
    const badge = operations.querySelector('[data-testid="nav-badge"]')!;
    expect(badge.textContent).toBe("•");
    expect(badge).toHaveAttribute("aria-label", "Items waiting");
  });

  it("someone who may not bill: Visits to review is exception review (5), there is no Billing, and Ready for Approval appears nowhere", async () => {
    renderAt("/service-verification/reports?view=exceptions", NO_BILL, { ...COUNTS, approvals: { exceptions: { count: 5, critical: 0 }, readyForApproval: null } });
    await waitFor(async () => expect(await badgeOn(/^Visits to review$/)).toEqual({ n: 5, red: false }));
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: /Billing/ })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Section tabs" })).toBeNull();
  });

  it("a count the person may not see is null: no badge, never a zero; a zero count shows no badge either", async () => {
    renderAt("/billing-review", BILL, { ...COUNTS, caregivers: null, scheduling: { count: 0, critical: 0 }, approvals: { exceptions: null, readyForApproval: 0 } });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
    await waitFor(async () => expect(await badgeOn(/^Caregivers$/)).toBeNull());
    expect(await badgeOn(/^Schedule$/)).toBeNull();
    expect(await badgeOn(/^Billing$/)).toBeNull();
    expect(await badgeOn(/^Visits to review$/)).toBeNull();
  });

  it("an older server with no counts shows no badge at all (the web does not derive one from other fields)", async () => {
    renderAt("/schedule", BILL, null);
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
    expect(await badgeOn(/^Schedule$/)).toBeNull();
    expect(await badgeOn(/^Caregivers$/)).toBeNull();
  });
});

describe("Scheduling: the badge, the overview figure and the lists agree; past shifts are never counted as needing coverage", () => {
  // A running unfilled shift (the server counts it: Critical), an upcoming one tomorrow, one 10 days away, and TWO ended shifts nobody covered (display state Missed).
  const SHIFTS = [
    shift("run", -0.5, 1.5, "needs_coverage", "needs_coverage"),
    shift("tom", 24, 26, "needs_coverage", "needs_coverage"),
    shift("far", 240, 242, "needs_coverage", "needs_coverage"),
    shift("past1", -5, -3, "needs_coverage", "missed"),
    shift("past2", -30, -28, "needs_coverage", "missed"),
  ];

  it("the sidebar badge shows the server's count; 'Unfilled' lists the running and the later shifts (3), not the two ended ones", async () => {
    renderAt("/schedule", BILL, { ...COUNTS, scheduling: { count: 2, critical: 1 } }, SHIFTS);
    await waitFor(async () => expect((await badgeOn(/^Schedule$/))?.n).toBe(2));
    expect(await screen.findByRole("heading", { name: "Unfilled (3)" })).toBeInTheDocument();
    const section = screen.getByRole("heading", { name: "Unfilled (3)" }).closest("section")!;
    expect(within(section).getAllByTestId("shift-state").map((e) => e.textContent)).toEqual(["Unfilled", "Unfilled", "Unfilled"]);
    // the ended shifts are shown elsewhere on the page as Missed, never as needing coverage
    expect(screen.getAllByText("Missed: no visit record").length).toBeGreaterThanOrEqual(2);
  });

  it("'Unfilled only' hides the ended shifts (they are Missed, not uncovered)", async () => {
    renderAt("/schedule", BILL, COUNTS, SHIFTS);
    await screen.findByRole("heading", { name: "Unfilled (3)" });
    const box = screen.getByRole("checkbox", { name: /Unfilled only/ });
    box.click();
    await waitFor(() => expect(screen.getByText(/No other shift is unfilled this week\./)).toBeInTheDocument());
    expect(screen.queryAllByText("Missed: no visit record")).toHaveLength(0);
  });

  it("with no shift needing coverage the heading says 0 and the two ended shifts are not counted anywhere in it", async () => {
    renderAt("/schedule", BILL, { ...COUNTS, scheduling: null }, SHIFTS.slice(3));
    expect(await screen.findByRole("heading", { name: "Unfilled (0)" })).toBeInTheDocument();
    expect(screen.queryByTestId("scheduling-now")).toBeNull();
  });
});
