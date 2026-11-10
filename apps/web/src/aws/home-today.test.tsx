// Home additions (Board 1): Today's visits, three quick actions, "Updated ... / Refresh", and the deep links they open.
// Severity words follow Board 4 (Critical / Urgent / Routine). SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const FULL = ["visits.read", "visits.manage", "billing.visits.read", "shifts.manage", "care_requests.read", "clients.names.read", "clients.read", "caregivers.manage",
  "authorizations.read", "documents.read", "continuity.export", "readiness.read"];
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const MIN = 60_000;
const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * MIN).toISOString();
const shift = (id: string, startMin: number, endMin: number, over: Record<string, unknown> = {}) => ({
  shiftId: id, startsAt: iso(startMin), endsAt: iso(endMin), localDate: "2026-10-18", coverageState: "covered", clientId: `c-${id}`, clientCode: `C-${id.toUpperCase()}`,
  clientName: `Client ${id}`, serviceName: "Respite Care", serviceCode: "862", caregiverRecordId: "cg", caregiverCode: "CG-1", caregiverName: "Sam Caregiver",
  hasSignIn: true, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null, ...over,
});
const emptyOverview = (asOf = new Date().toISOString()) => ({ overview: {
  asOf, urgentWindowHours: 48, urgent: { items: [], itemCount: 0, issueCount: 0, shifts: 0, visits: 0 }, upcoming: { count: 0, nextStartsAt: null, shifts: [] },
  documents: { overdue: 0, dueSoon: 0, awaitingReview: 0, rejected: 0, caregiversOnHold: 0, caregiversWithPendingRequirements: 0 },
  visitReview: { visitsNeedingAttention: 0, awaitingConfirmation: 0, needsReview: 0, lateResponses: 0, readyForApproval: 0, reviewIssues: 0, awaitingResponse: 0 } } });

interface Handlers { overview?: () => Response | Promise<Response>; shifts?: () => Response | Promise<Response> }
function renderAt(path: string, perms: string[], h: Handlers = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname === "/v1/me") return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions: perms }], profile: { displayName: "Morgan Manager" } });
    if (url.pathname === "/v1/branding") return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
    if (url.pathname === "/v1/attention/overview") return (h.overview ?? (() => json(200, emptyOverview())))();
    if (url.pathname === "/v1/action-issues") return json(200, { asOf: new Date().toISOString(), matching: 0, limit: 50, offset: 0, counts: { total: 0, critical: 0, urgent: 0, routine: 0, actionNeeded: 0 }, issues: [] }); // healthy list: these tests are about the tiles
    if (url.pathname === "/v1/shifts") return (h.shifts ?? (() => json(200, { shifts: [] })))();
    if (url.pathname === "/v1/reports/utilisation") return json(200, { services: [] });
    if (url.pathname === "/v1/clients") return json(200, { clients: [] });
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
  return { calls };
}
afterEach(() => vi.clearAllMocks());
const overviewCalls = (calls: string[]) => calls.filter((c) => c.startsWith("/v1/attention/overview")).length;

describe("Today's visits", () => {
  it("lists visits still to come or running, soonest first, with client, caregiver and a status word; finished and cancelled ones are left out", async () => {
    renderAt("/", FULL, { shifts: () => json(200, { shifts: [
      shift("later", 120, 180), shift("now", -30, 60, { hasVisit: true, clientName: "Client Now" }),
      shift("done", -240, -180, { coverageState: "completed" }), shift("gone", 30, 90, { coverageState: "cancelled" }),
    ] }) });
    const list = await screen.findByTestId("todays-visits");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Client Now");
    expect(rows[0]).toHaveTextContent("Sam Caregiver");
    expect(rows[0]).toHaveTextContent("In progress");
    expect(rows[1]).toHaveTextContent("Client later");
    expect(rows[1]).toHaveTextContent("Scheduled");
    expect(screen.getAllByRole("link", { name: "View all" }).map((l) => l.getAttribute("href"))).toContain("/schedule"); // the issue list has its own View all
  });

  it("an uncovered visit is Critical once it has started and Urgent before, each with its word", async () => {
    renderAt("/", FULL, { shifts: () => json(200, { shifts: [
      shift("run", -20, 60, { coverageState: "needs_coverage", caregiverRecordId: null, caregiverCode: null, caregiverName: null }),
      shift("soon", 90, 150, { coverageState: "needs_coverage", caregiverRecordId: null, caregiverCode: null, caregiverName: null }),
    ] }) });
    const rows = within(await screen.findByTestId("todays-visits")).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Critical");
    expect(rows[0]).toHaveTextContent("No caregiver");
    expect(rows[1]).toHaveTextContent("Urgent");
    expect(rows[1]).not.toHaveTextContent("Critical");
  });

  it("stays short: at most six rows, and says how many there are", async () => {
    const many = Array.from({ length: 9 }, (_, i) => shift(`s${i}`, 10 + i * 10, 60 + i * 10));
    renderAt("/", FULL, { shifts: () => json(200, { shifts: many }) });
    const rows = within(await screen.findByTestId("todays-visits")).getAllByRole("listitem");
    expect(rows).toHaveLength(6);
    expect(await screen.findByText(/Showing 6 of 9/)).toBeInTheDocument();
  });

  it("says plainly when nothing is scheduled, or when everything is done; a failed load is not shown as zero", async () => {
    renderAt("/", FULL, { shifts: () => json(200, { shifts: [] }) });
    expect(await screen.findByText("No visits scheduled today.")).toBeInTheDocument();
  });
  it("everything finished: 'No more visits today.'", async () => {
    renderAt("/", FULL, { shifts: () => json(200, { shifts: [shift("done", -240, -180, { coverageState: "completed" })] }) });
    expect(await screen.findByText("No more visits today.")).toBeInTheDocument();
  });
  it("a failed load says so and does not claim there are none", async () => {
    renderAt("/", FULL, { shifts: () => json(500, { error: { code: "internal", message: "Synthetic failure" } }) });
    expect(await screen.findByText(/could not be loaded\. They are not shown as zero/)).toBeInTheDocument();
    expect(screen.queryByText("No visits scheduled today.")).toBeNull();
  });
  it("is absent for someone who cannot see the schedule", async () => {
    renderAt("/", ["visits.read", "documents.read", "readiness.read"]);
    await screen.findByTestId("stream-now");
    expect(screen.queryByRole("heading", { name: "Today's visits" })).toBeNull();
  });
});

describe("Quick actions", () => {
  it("one primary action and two plain links, each to its workflow", async () => {
    renderAt("/", FULL);
    const nav = await screen.findByRole("navigation", { name: "Quick actions" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Schedule visit", "/schedule?add=1"], ["Find client", "/clients?find=1"], ["Resolve coverage", "/schedule?coverage=1"],
    ]);
    expect(links[0]!.className).toMatch(/bg-og-accent/); // the one primary button
    expect(links[1]!.className).not.toMatch(/bg-og-accent/);
    expect(links[2]!.className).not.toMatch(/bg-og-accent/);
  });
  it("shows only what the person may use", async () => {
    renderAt("/", ["visits.read", "clients.names.read", "readiness.read"]);
    const nav = await screen.findByRole("navigation", { name: "Quick actions" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Find client"]);
  });
  it("none at all for a role with none of the permissions", async () => {
    renderAt("/", ["visits.read", "documents.read", "readiness.read"]);
    await screen.findByTestId("stream-now");
    expect(screen.queryByRole("navigation", { name: "Quick actions" })).toBeNull();
  });
});

describe("Refresh and data status", () => {
  it("shows when the figures are from (the server's time) and a Refresh button that re-reads them", async () => {
    const { calls } = renderAt("/", FULL);
    await waitFor(() => expect(screen.getByTestId("updated-at")).toHaveTextContent(/^Updated \d{1,2}:\d{2}\s?(AM|PM)$/));
    await waitFor(() => expect(overviewCalls(calls)).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(overviewCalls(calls)).toBe(2));
  });
  it("figures older than ten minutes carry a plain warning with the time", async () => {
    renderAt("/", FULL, { overview: () => json(200, emptyOverview(new Date(Date.now() - 30 * MIN).toISOString())) });
    expect(await screen.findByRole("status")).toHaveTextContent(/may be out of date/);
  });
  it("a refresh that fails keeps the last figures, warns, and offers Retry; it never shows zero", async () => {
    let n = 0;
    renderAt("/", FULL, { overview: () => (++n === 1 ? json(200, { overview: { ...emptyOverview().overview, visitReview: { visitsNeedingAttention: 4, awaitingConfirmation: 4, needsReview: 0, lateResponses: 0, readyForApproval: 0, reviewIssues: 0, awaitingResponse: 0 } } }) : json(500, { error: { code: "internal", message: "Synthetic failure" } })) });
    expect(await screen.findByTestId("stream-visits")).toHaveTextContent("4");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Could not refresh\. These figures are from/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByTestId("stream-visits")).toHaveTextContent("4");
  });
  it("when the first load fails: unavailable, Retry, and no tiles with a false zero", async () => {
    renderAt("/", FULL, { overview: () => json(500, { error: { code: "internal", message: "Synthetic failure" } }) });
    expect(await screen.findByText(/could not be loaded\. They are not zero/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByTestId("stream-now")).toBeNull();
  });
});

describe("where the actions land", () => {
  it("?add=1 opens the Add shift form for someone who manages shifts", async () => {
    renderAt("/schedule?add=1", FULL);
    expect(await screen.findByRole("dialog", { name: "Add shift" })).toBeInTheDocument();
  });
  it("?coverage=1 shows only shifts that need coverage", async () => {
    renderAt("/schedule?coverage=1", FULL, { shifts: () => json(200, { shifts: [shift("ok", 60, 120), shift("open", 90, 150, { coverageState: "needs_coverage", caregiverRecordId: null, caregiverName: null, caregiverCode: null })] }) });
    await screen.findByText(/unfilled this week/);
    expect(screen.getByLabelText("Unfilled only")).toBeChecked();
    expect(screen.queryByText("Client ok")).toBeNull();
  });
  it("without the parameters the schedule opens as before", async () => {
    renderAt("/schedule", FULL);
    expect(await screen.findByRole("button", { name: "Add shift" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Unfilled only")).not.toBeChecked();
  });
  it("?find=1 puts the cursor in the client search", async () => {
    renderAt("/clients?find=1", FULL);
    const box = await screen.findByLabelText("Search");
    await waitFor(() => expect(box).toHaveFocus());
  });
});
