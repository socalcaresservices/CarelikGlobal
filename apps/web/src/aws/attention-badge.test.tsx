// Header badge "Needs attention now" and the four Home tiles (migration 0056): one count of unique shifts and visits needing attention
// now; red only for blocked or at-risk care; a word and a symbol on every state; no false zero. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
type Role = "caregiver" | "manager";
const PERMS: Record<Role, string[]> = {
  manager: ["visits.read", "visits.manage", "billing.visits.read", "shifts.manage", "care_requests.read", "clients.names.read", "caregivers.manage",
    "authorizations.read", "documents.read", "continuity.export", "readiness.read"],
  caregiver: ["availability.manage_own", "documents.manage_own"],
};

function renderAt(path: string, role: Role, attention: () => Promise<Response> | Response) {
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me") {
      return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions: PERMS[role] }], profile: { displayName: "Synthetic Person" } });
    }
    if (url.pathname === "/v1/branding") return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
    if (url.pathname === "/v1/action-issues") return json(200, { asOf: new Date().toISOString(), matching: 0, limit: 50, offset: 0, counts: { total: 0, critical: 0, urgent: 0, routine: 0, actionNeeded: 0 }, issues: [] }); // healthy list: these tests are about the tiles
    if (url.pathname === "/v1/attention/overview") return attention();
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
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });


const item = (over: Partial<Record<string, unknown>> = {}) => ({ kind: "shift", id: "s1", startsAt: "2026-10-18T20:00:00Z", endsAt: "2026-10-18T23:00:00Z", reasons: ["uncovered_open"], severity: "red", inProgress: false,
  caregiverRecordId: null, caregiverCode: null, clientCode: "C-AAA111", serviceCode: "RSP", ...over });
const overview = (o: Record<string, unknown> = {}) => ({ overview: {
  asOf: "2026-10-18T12:00:00Z", urgentWindowHours: 48,
  urgent: { items: [], itemCount: 0, issueCount: 0, shifts: 0, visits: 0 },
  upcoming: { count: 0, nextStartsAt: null, shifts: [] },
  documents: { overdue: 0, dueSoon: 0, awaitingReview: 0, rejected: 0, caregiversOnHold: 0, caregiversWithPendingRequirements: 0 },
  visitReview: { visitsNeedingAttention: 0, awaitingConfirmation: 0, needsReview: 0, lateResponses: 0, readyForApproval: 0, reviewIssues: 0, awaitingResponse: 0 },
  ...o } });

describe("one headline number (R19)", () => {
  it("there is no separate \"Needs attention now\" chip in the header and no tile for it on Home; the headline is the issues list count", async () => {
    renderAt("/", "manager", () => json(200, overview({ urgent: { items: [item()], itemCount: 1, issueCount: 1, shifts: 1, visits: 0 } })));
    expect(await screen.findByTestId("kpi-row")).toBeInTheDocument();
    expect(screen.queryByTestId("attention-badge")).toBeNull();
    expect(screen.queryByTestId("stream-now")).toBeNull();
    expect(await screen.findByTestId("headline-count")).toBeInTheDocument();
  });

  it("the header chip is gone on every other page too (the bell is the one global number)", async () => {
    renderAt("/schedule", "manager", () => json(200, overview({ urgent: { items: [item()], itemCount: 1, issueCount: 1, shifts: 1, visits: 0 } })));
    await screen.findByRole("heading", { name: /Schedule/ });
    expect(screen.queryByTestId("attention-badge")).toBeNull();
  });
});

describe("navigation highlight", () => {
  it("marks only the current section with aria-current=page, including nested routes", async () => {
    renderAt("/", "manager", () => json(200, overview()));
    expect(await currentItems()).toEqual(["Dashboard"]);
  });

  it("a nested route highlights its own section only, not its parent", async () => {
    renderAt("/service-verification/reports", "manager", () => json(200, overview()));
    await waitFor(async () => expect(await currentItems()).toEqual(["Visits"])); // the visit list is its own sidebar item now
  });
});

describe("Home tiles: three purposes, each its own destination", () => {
  const busy = overview({
    urgent: { items: [item(), item({ id: "v1", kind: "visit", severity: "amber", reasons: ["missing_clock_out"] })], itemCount: 2, issueCount: 3, shifts: 1, visits: 1 },
    upcoming: { count: 5, nextStartsAt: "2026-10-20T20:00:00Z", shifts: [] },
    documents: { overdue: 2, dueSoon: 4, awaitingReview: 1, rejected: 0, caregiversOnHold: 1, caregiversWithPendingRequirements: 2 },
    visitReview: { visitsNeedingAttention: 6, awaitingConfirmation: 2, needsReview: 3, lateResponses: 0, readyForApproval: 1, reviewIssues: 7, awaitingResponse: 0 },
  });

  it("shows three tiles with their own counts and destinations", async () => {
    renderAt("/", "manager", () => json(200, busy));
    await screen.findByTestId("kpi-row");
    expect(screen.queryByTestId("stream-now")).toBeNull();   // R19: the duplicate "Needs attention now" tile was removed
    expect(screen.getByTestId("stream-staffing")).toHaveAttribute("href", "/staffing");
    expect(screen.getByTestId("stream-staffing")).toHaveTextContent("5");
    expect(screen.getByTestId("stream-documents")).toHaveAttribute("href", "/documents");
    expect(screen.getByTestId("stream-documents")).toHaveTextContent("2 overdue");
    expect(screen.getByTestId("stream-visits")).toHaveAttribute("href", "/visit-review");
    expect(screen.getByTestId("stream-visits")).toHaveTextContent("6");
  });

  it("a section the viewer may not see has no tile (never a false zero)", async () => {
    renderAt("/", "manager", () => json(200, overview({ upcoming: null, documents: null })));
    await screen.findByTestId("kpi-row");
    expect(screen.queryByTestId("stream-staffing")).toBeNull();
    expect(screen.queryByTestId("stream-documents")).toBeNull();
  });
});

describe("destination pages", () => {
  const data = overview({
    urgent: { items: [item({ reasons: ["compliance_hold", "documents_not_current"], caregiverRecordId: "cg-1" })], itemCount: 1, issueCount: 2, shifts: 1, visits: 0 },
    upcoming: { count: 2, nextStartsAt: "2026-10-20T20:00:00Z", shifts: [
      { shiftId: "a", startsAt: "2026-10-20T20:00:00Z", endsAt: "2026-10-20T23:00:00Z", reason: "open", clientCode: "C-AAA111", serviceCode: "RSP", serviceName: "Respite" },
      { shiftId: "b", startsAt: "2026-10-20T23:30:00Z", endsAt: "2026-10-21T01:00:00Z", reason: "called_out", clientCode: "C-BBB222", serviceCode: "RSP", serviceName: "Respite" }] },
    visitReview: { visitsNeedingAttention: 3, awaitingConfirmation: 1, needsReview: 2, lateResponses: 0, readyForApproval: 0, reviewIssues: 5, awaitingResponse: 0 },
  });

  it("Needs attention now: one row per item, issues counted apart, compliance linked to the caregiver's record", async () => {
    renderAt("/attention", "manager", () => json(200, data));
    expect(await screen.findByTestId("urgent-summary")).toHaveTextContent("1 item · 2 issues in total");
    expect(screen.getByText("Caregiver is on a compliance hold")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review compliance record" })).toHaveAttribute("href", "/care-team/cg-1");
  });

  it("Upcoming staffing: grouped by date, called-out and open shown with words", async () => {
    renderAt("/staffing", "manager", () => json(200, data));
    expect(await screen.findByTestId("staffing-summary")).toHaveTextContent("2 shifts");
    expect(screen.getByText("No caregiver")).toBeInTheDocument();
    expect(screen.getByText("Called out")).toBeInTheDocument();
  });

  it("Visit review: unique visits labelled apart from issues", async () => {
    renderAt("/visit-review", "manager", () => json(200, data));
    const summary = await screen.findByTestId("visit-summary");
    expect(summary).toHaveTextContent("Visits needing attention: 3");
    expect(summary).toHaveTextContent("Issues: 5");
  });
});
