// The Visit review, Upcoming staffing and Needs attention now pages after 0058: routine queues apart, Critical / Urgent / Overdue words.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PERMS = ["visits.read", "visits.manage", "shifts.manage", "clients.names.read", "documents.read", "readiness.read", "billing.visits.read"];
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const base = {
  asOf: "2026-10-18T12:00:00Z", urgentWindowHours: 48,
  urgent: { items: [], itemCount: 0, issueCount: 0, shifts: 0, visits: 0, critical: 0, urgent: 0 },
  upcoming: { count: 0, nextStartsAt: null, shifts: [] },
  documents: { overdue: 0, dueSoon: 0, awaitingReview: 0, reviewRoutine: 0, reviewOverdue: 0, rejected: 0, caregiversOnHold: 0, caregiversWithPendingRequirements: 0 },
  visitReview: { visitsNeedingAttention: 0, pendingConfirmation: 0, confirmationOverdue: 0, awaitingConfirmation: 0, needsReview: 0, reviewOverdue: 0, lateResponses: 0, readyForApproval: 0, reviewIssues: 0, awaitingResponse: 0 },
};
function renderAt(path: string, overview: object) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me") return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions: PERMS }], profile: { displayName: "Morgan Manager" } });
    if (url.pathname === "/v1/branding") return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
    if (url.pathname === "/v1/attention/overview") return json(200, { overview });
    return json(200, {});
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

describe("Visit review keeps routine follow-up apart", () => {
  const visits = { ...base.visitReview, visitsNeedingAttention: 4, needsReview: 2, reviewOverdue: 1, lateResponses: 1, confirmationOverdue: 1, pendingConfirmation: 5, awaitingConfirmation: 6, readyForApproval: 7, reviewIssues: 3 };
  it("Needs a decision lists review, review waiting 24 h (Urgent), late answers and confirmations overdue (Overdue); the routine rows are separate and not counted", async () => {
    renderAt("/visit-review", { ...base, visitReview: visits });
    expect(await screen.findByTestId("visit-summary")).toHaveTextContent("Visits needing attention: 4");
    const decide = screen.getByRole("region", { name: "Needs a decision" });
    expect(within(decide).getByText("In review").closest("a")).toHaveTextContent("2");
    expect(within(decide).getByText("Review waiting 24 hours or more").closest("a")).toHaveTextContent("Urgent");
    expect(within(decide).getByText(/Client confirmation overdue/).closest("a")).toHaveTextContent("Overdue");
    expect(within(decide).queryByText(/Pending client confirmation/)).toBeNull();
    expect(within(decide).queryByText(/Ready for billing approval/)).toBeNull();
    const routine = screen.getByRole("region", { name: "Routine follow-up" });
    expect(within(routine).getByText(/Pending client confirmation/).closest("a")).toHaveTextContent("5");
    expect(within(routine).getByText("Ready for billing approval").closest("a")).toHaveTextContent("7");
    expect(routine).toHaveTextContent("not counted above");
  });
  it("every Needs a decision row opens the list that holds the counted visits, and none opens billing review (a visits-only reviewer would be refused there)", async () => {
    renderAt("/visit-review", { ...base, visitReview: { ...visits, readyForApproval: null } });
    const decide = await screen.findByRole("region", { name: "Needs a decision" });
    const links = within(decide).getAllByRole("link");
    expect(links.length).toBe(4);
    for (const a of links) expect(a.getAttribute("href")).toBe("/service-verification/reports?view=exceptions");
    expect(within(decide).getByText("Late answers to accept or reject").closest("a")).toHaveAttribute("href", "/service-verification/reports?view=exceptions");
  });
  it("a role without billing sees no Ready for approval row", async () => {
    renderAt("/visit-review", { ...base, visitReview: { ...visits, readyForApproval: null } });
    const routine = await screen.findByRole("region", { name: "Routine follow-up" });
    expect(within(routine).queryByText("Ready for billing approval")).toBeNull();
  });
});

describe("Upcoming staffing lists blocked shifts with the reason", () => {
  it("uncovered, called out, hold and document reasons each in words", async () => {
    const shift = (id: string, reason: string, h: number) => ({ shiftId: id, startsAt: `2026-10-2${h}T20:00:00Z`, endsAt: `2026-10-2${h}T23:00:00Z`, reason, clientCode: "C-AAA111", serviceCode: "RSP", serviceName: "Respite" });
    renderAt("/staffing", { ...base, upcoming: { count: 4, nextStartsAt: "2026-10-21T20:00:00Z", shifts: [shift("a", "open", 1), shift("b", "called_out", 2), shift("c", "compliance_hold", 3), shift("d", "documents_not_current", 4)] } });
    expect(await screen.findByTestId("staffing-summary")).toHaveTextContent("4 shifts");
    for (const t of ["No caregiver", "Called out", "Caregiver on a compliance hold", "A required document is not current"]) expect(screen.getByText(t)).toBeInTheDocument();
  });
});

describe("Needs attention now: Critical first, with the server's words", () => {
  const item = (id: string, tier: "critical" | "urgent", startsAt: string, reasons: string[]) => ({ kind: "shift", id, startsAt, endsAt: null, reasons, tier, severity: tier === "critical" ? "red" : "amber", inProgress: tier === "critical", caregiverRecordId: null, caregiverCode: null, clientCode: `C-${id}`, serviceCode: "RSP" });
  it("orders Critical before Urgent whatever the arrival order, and names each tier", async () => {
    const items = [item("U1", "urgent", "2026-10-18T14:00:00Z", ["uncovered_open"]), item("C1", "critical", "2026-10-18T11:00:00Z", ["compliance_hold"])];
    renderAt("/attention", { ...base, urgent: { items, itemCount: 2, issueCount: 2, shifts: 2, visits: 0, critical: 1, urgent: 1 } });
    await screen.findByTestId("urgent-summary");
    const list = screen.getAllByRole("listitem");
    const rows = list.filter((l) => /Shift ·/.test(l.textContent ?? ""));
    expect(rows[0]).toHaveTextContent("C-C1");
    expect(rows[0]).toHaveTextContent("Critical");
    expect(rows[1]).toHaveTextContent("C-U1");
    expect(rows[1]).toHaveTextContent("Urgent");
  });
});

describe("Home tiles after the split", () => {
  it("Visit review counts what needs a person and lists the routine queues in its detail; Documents says Overdue, not Urgent", async () => {
    renderAt("/", { ...base, visitReview: { ...base.visitReview, visitsNeedingAttention: 2, needsReview: 2, pendingConfirmation: 3, readyForApproval: 4 }, documents: { ...base.documents, overdue: 1, awaitingReview: 2, reviewRoutine: 2 } });
    const visitsTile = await screen.findByTestId("stream-visits");
    expect(visitsTile).toHaveTextContent("2");
    expect(visitsTile).toHaveTextContent("3 pending confirmation");
    expect(visitsTile).toHaveTextContent("4 ready for approval");
    const docs = screen.getByTestId("stream-documents");
    expect(docs).toHaveTextContent("Overdue");
    expect(docs).not.toHaveTextContent("Urgent");
    expect(docs).toHaveTextContent("2 awaiting routine review");
  });
});
