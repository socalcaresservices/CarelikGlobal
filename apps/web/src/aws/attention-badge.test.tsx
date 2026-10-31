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

describe("Needs attention now badge", () => {
  it("on Home the header badge is not repeated: the first row of Home shows the same count once", async () => {
    renderAt("/", "manager", () => json(200, overview({ urgent: { items: [item()], itemCount: 1, issueCount: 1, shifts: 1, visits: 0 } })));
    expect(await screen.findByTestId("stream-now")).toHaveTextContent("1");
    expect(screen.queryByTestId("attention-badge")).toBeNull();
  });

  it("an uncovered shift that has started: Critical (red), with a symbol and the word, counting items", async () => {
    renderAt("/profile", "manager", () => json(200, overview({ urgent: { items: [item({ startsAt: "2026-10-18T11:00:00Z", inProgress: true })], itemCount: 1, issueCount: 1, shifts: 1, visits: 0 } })));
    const badge = await screen.findByRole("link", { name: "Needs attention now: 1 item" });
    expect(badge).toHaveTextContent("●");
    expect(badge).toHaveTextContent("Needs attention now");
    expect(badge.className).toMatch(/red/);
    expect(badge).toHaveAttribute("href", "/attention");
  });

  it("an uncovered shift that has not started yet (inside the 48 h window): Urgent (amber), not red", async () => {
    renderAt("/profile", "manager", () => json(200, overview({ urgent: { items: [item()], itemCount: 1, issueCount: 1, shifts: 1, visits: 0 } })));
    const badge = await screen.findByTestId("attention-badge");
    await waitFor(() => expect(badge).toHaveTextContent("▲"));
    expect(badge.className).toMatch(/amber/);
    expect(badge.className).not.toMatch(/red/);
  });

  it("only amber items: amber, not red", async () => {
    renderAt("/profile", "manager", () => json(200, overview({ urgent: { items: [item({ severity: "amber", reasons: ["missing_clock_out"] })], itemCount: 1, issueCount: 1, shifts: 0, visits: 1 } })));
    const badge = await screen.findByTestId("attention-badge");
    await waitFor(() => expect(badge).toHaveTextContent("▲"));
    expect(badge.className).toMatch(/amber/);
    expect(badge.className).not.toMatch(/red/);
  });

  it("confirmed zero: calm text with a check, no alarm colour", async () => {
    renderAt("/profile", "manager", () => json(200, overview()));
    const badge = await screen.findByRole("link", { name: "No urgent items" });
    expect(badge).toHaveTextContent("✓");
    expect(badge.className).not.toMatch(/red|amber|emerald/);
  });

  it("while loading: neutral Checking…", async () => {
    renderAt("/profile", "manager", () => new Promise<Response>(() => {}));
    const badge = await screen.findByRole("link", { name: "Checking what needs attention now" });
    expect(badge).toHaveTextContent("Checking…");
  });

  it("failed check: Unable to check, never a zero", async () => {
    renderAt("/profile", "manager", () => json(500, { error: { code: "internal", message: "Synthetic failure" } }));
    const badge = await screen.findByRole("link", { name: "Unable to check what needs attention now" });
    expect(badge).toHaveTextContent("Unable to check");
    await waitFor(() => expect(screen.queryByText("No urgent items")).toBeNull());
  });
});

describe("navigation highlight", () => {
  it("marks only the current section with aria-current=page, including nested routes", async () => {
    renderAt("/", "manager", () => json(200, overview()));
    expect(await currentItems()).toEqual(["Dashboard"]);
  });

  it("a nested route highlights its own section only, not its parent", async () => {
    renderAt("/service-verification/reports", "manager", () => json(200, overview()));
    await waitFor(async () => expect(await currentItems()).toEqual(["Reports"]));
  });
});

describe("Home tiles: four purposes, each its own destination", () => {
  const busy = overview({
    urgent: { items: [item(), item({ id: "v1", kind: "visit", severity: "amber", reasons: ["missing_clock_out"] })], itemCount: 2, issueCount: 3, shifts: 1, visits: 1 },
    upcoming: { count: 5, nextStartsAt: "2026-10-20T20:00:00Z", shifts: [] },
    documents: { overdue: 2, dueSoon: 4, awaitingReview: 1, rejected: 0, caregiversOnHold: 1, caregiversWithPendingRequirements: 2 },
    visitReview: { visitsNeedingAttention: 6, awaitingConfirmation: 2, needsReview: 3, lateResponses: 0, readyForApproval: 1, reviewIssues: 7, awaitingResponse: 0 },
  });

  it("shows four tiles with their own counts and destinations", async () => {
    renderAt("/", "manager", () => json(200, busy));
    const now = await screen.findByTestId("stream-now");
    expect(now).toHaveTextContent("Needs attention now");
    expect(now).toHaveTextContent("2");
    expect(now).toHaveTextContent("3 issues in all");
    expect(now).toHaveAttribute("href", "/attention");
    expect(screen.getByTestId("stream-staffing")).toHaveAttribute("href", "/staffing");
    expect(screen.getByTestId("stream-staffing")).toHaveTextContent("5");
    expect(screen.getByTestId("stream-documents")).toHaveAttribute("href", "/documents");
    expect(screen.getByTestId("stream-documents")).toHaveTextContent("2 overdue");
    expect(screen.getByTestId("stream-visits")).toHaveAttribute("href", "/visit-review");
    expect(screen.getByTestId("stream-visits")).toHaveTextContent("6");
  });

  it("the tile carries a word, not colour alone: Urgent when nothing has started, Critical once an uncovered shift has", async () => {
    renderAt("/", "manager", () => json(200, busy));
    const urgent = await screen.findByTestId("stream-now");
    expect(urgent).toHaveTextContent("Urgent");
    expect(urgent).not.toHaveTextContent("Critical");
  });

  it("an uncovered shift that has started makes the tile Critical", async () => {
    const started = overview({ urgent: { items: [item({ startsAt: "2026-10-18T11:00:00Z", inProgress: true })], itemCount: 1, issueCount: 1, shifts: 1, visits: 0 } });
    renderAt("/", "manager", () => json(200, started));
    expect(await screen.findByTestId("stream-now")).toHaveTextContent("Critical");
  });

  it("a section the viewer may not see has no tile (never a false zero)", async () => {
    renderAt("/", "manager", () => json(200, overview({ upcoming: null, documents: null })));
    await screen.findByTestId("stream-now");
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
