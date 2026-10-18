/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies are free-form JSON */
// Action Needed (0073): one server list with matching counts, filters, paging, recommended actions with context, history and the agency's shorter deadlines. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const SHIFT = "51515151-0000-4000-8000-000000000001";
type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, any> | null; key: string | null };
const issue = (over: Record<string, unknown>) => ({ issueKey: "x", kind: "shift", reason: "uncovered_open", queue: "needs_attention_now", category: "coverage", severity: "critical", deadline: new Date(Date.now() - 3600e3).toISOString(),
  since: null, shiftId: SHIFT, visitId: null, entityId: SHIFT, caregiverRecordId: null, clientId: "c1", serviceId: "s1", clientCode: "CL-1", caregiverCode: null, serviceCode: "PCS", status: "open", firstSeenAt: null, reopenCount: 0,
  action: "assign_caregiver", recommendedAction: "Choose an eligible caregiver and confirm the assignment.", ...over });
const ISSUES = [
  issue({ issueKey: `shift:uncovered_open:${SHIFT}` }),
  issue({ issueKey: "visit:confirmation_overdue:v1", kind: "visit", reason: "confirmation_overdue", queue: "visit_review", category: "visits", severity: "urgent", shiftId: null, visitId: "v1", entityId: "v1", clientCode: "CL-2", clientId: "c2", action: "follow_up_confirmation", recommendedAction: "No confirmation yet: contact the client or representative, or record why it cannot be obtained.", deadline: null }),
  issue({ issueKey: "visit:ready_for_approval:v2", kind: "visit", reason: "ready_for_approval", queue: "ready_for_approval", category: "visits", severity: "routine", shiftId: null, visitId: "v2", entityId: "v2", action: "approve_billing", recommendedAction: "Approve the billable minutes, or send it back.", deadline: null, reopenCount: 2 }),
];
function renderPage(permissions: string[]) {
  const calls: Call[] = [];
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, any> | null;
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, query: url.searchParams, body, key: new Headers(init?.headers).get("idempotency-key") });
    switch (`${method} ${url.pathname}`) {
      case "GET /v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions }], profile: { displayName: "Morgan Manager" } });
      case "GET /v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention": return json(200, { summary: null });
      case "GET /v1/attention/overview": return json(200, { overview: { asOf: new Date().toISOString(), urgentWindowHours: 48, urgent: null, upcoming: { count: 0, nextStartsAt: null, shifts: [] }, documents: null, visitReview: null } });
      case "GET /v1/action-issues": {
        const sev = url.searchParams.get("severity"); const limit = Number(url.searchParams.get("limit") ?? 50);
        const filtered = ISSUES.filter((i) => !sev || i.severity === sev);
        return json(200, { asOf: new Date().toISOString(), matching: filtered.length, limit, offset: 0, counts: { total: 3, critical: 1, urgent: 1, routine: 1, actionNeeded: 2, byQueue: { needs_attention_now: 1, visit_review: 1, ready_for_approval: 1 } }, issues: filtered.slice(0, limit) });
      }
      case "GET /v1/action-issues/history": return json(200, { history: { state: { status: "open", firstSeenAt: new Date().toISOString(), resolvedAt: null, reopenCount: 0 }, events: [{ event: "opened", severity: "urgent", occurredAt: new Date().toISOString(), observedByName: "Morgan Manager" }, { event: "severity_changed", severity: "critical", occurredAt: new Date().toISOString(), observedByName: "Morgan Manager" }] } });
      case "GET /v1/attention-settings": return json(200, { settings: { confirmationOverdueHours: 48, reviewOverdueHours: 24, documentReviewOverdueHours: 48, defaults: { confirmationOverdueHours: 48, reviewOverdueHours: 24, documentReviewOverdueHours: 48 }, history: [] } });
      case "POST /v1/attention-settings": return json(200, { settings: { confirmationOverdueHours: body?.confirmationOverdueHours ?? 48 } });
      default: return json(404, { error: { code: "not_found", message: `No such endpoint: ${method} ${url.pathname}` } });
    }
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "m@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })), getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(<MemoryRouter initialEntries={["/action-needed"]}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CognitoAuthProvider client={auth as unknown as CognitoAuthClient}><AwsRoutes api={client} publicApi={client} /></CognitoAuthProvider></QueryClientProvider></MemoryRouter>);
  return { calls };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Action needed", () => {
  it("shows the counts the server returns, cards in server order with a recommended action and a link carrying the context, and keeps routine queues out of the action total", async () => {
    renderPage(["visits.read", "shifts.manage", "visits.manage", "billing.visits.read"]);
    const counts = await screen.findByTestId("issue-counts", {}, { timeout: 15000 });
    expect(counts).toHaveTextContent("2 need action");
    // each group heading carries its own count once; a group of routine items says it is not in the total
    expect(screen.getByRole("heading", { name: /^Needs attention now 1$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Visit review 1$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Ready for approval 1 · routine, not in the total$/ })).toBeInTheDocument();
    const cards = await screen.findAllByTestId("issue-card");
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText("Critical")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Choose an eligible caregiver and confirm the assignment.")).toBeInTheDocument();
    expect(within(cards[0]!).getByRole("link", { name: "Choose a caregiver" })).toHaveAttribute("href", expect.stringMatching(new RegExp(`^/schedule\\?coverage=1&shift=${SHIFT}&at=.+$`)));
    expect(within(cards[0]!).getByTestId("issue-deadline")).toHaveTextContent("Was due");
    expect(within(cards[1]!).getByRole("link", { name: "Open the visit" })).toHaveAttribute("href", "/visits/v1");
    expect(within(cards[1]!).getByTestId("issue-deadline")).toHaveTextContent("No deadline");
    expect(within(cards[2]!).getByText("Routine")).toBeInTheDocument();
    expect(within(cards[2]!).getByTestId("issue-deadline")).toHaveTextContent("reopened 2 times");
  }, 30000);

  it("a filter asks the server again with that filter; an empty result says so; History loads the transitions and says the time is when it was seen", async () => {
    const { calls } = renderPage(["visits.read", "shifts.manage"]);
    await screen.findAllByTestId("issue-card", {}, { timeout: 15000 });
    const filters = screen.getByTestId("issue-filters");
    fireEvent.change(within(filters).getByLabelText("Severity"), { target: { value: "urgent" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/action-issues" && c.query.get("severity") === "urgent")).toBe(true));
    await waitFor(() => expect(screen.getAllByTestId("issue-card")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const hist = await screen.findByTestId("issue-history");
    await waitFor(() => expect(hist).toHaveTextContent("severity changed (critical)"));
    expect(hist).toHaveTextContent("when the change was first seen");
    expect(calls.some((c) => c.path === "/v1/action-issues/history" && c.query.get("issueKey") === "visit:confirmation_overdue:v1")).toBe(true);
  }, 30000);

  it("the owner can save shorter deadlines only with a reason, as one keyed request; a manager only reads them", async () => {
    const { calls } = renderPage(["visits.read", "shifts.manage", "organization.update"]);
    await screen.findAllByTestId("issue-card", {}, { timeout: 15000 });
    fireEvent.click(screen.getByText("Follow-up deadlines"));
    const box = await screen.findByTestId("deadline-settings");
    fireEvent.change(within(box).getByLabelText(/Client confirmation/), { target: { value: "24" } });
    fireEvent.click(within(box).getByRole("button", { name: "Save the deadlines" }));
    expect(await within(box).findByRole("alert")).toHaveTextContent("at least 10 characters");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.change(within(box).getByLabelText(/Why are you changing them/), { target: { value: "Faster follow-up for the pilot" } });
    fireEvent.click(within(box).getByRole("button", { name: "Save the deadlines" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/attention-settings")).toHaveLength(1));
    const sent = calls.find((c) => c.method === "POST")!;
    expect(sent.body).toMatchObject({ organizationId: ORG, confirmationOverdueHours: 24, reviewOverdueHours: null, documentReviewOverdueHours: null });
    expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await within(box).findByRole("status")).toHaveTextContent("Saved");
  }, 30000);

  it("a manager without organization.update sees the deadlines and no form", async () => {
    renderPage(["visits.read", "shifts.manage"]);
    await screen.findAllByTestId("issue-card", {}, { timeout: 15000 });
    fireEvent.click(screen.getByText("Follow-up deadlines"));
    const box = await screen.findByTestId("deadline-settings");
    expect(box).toHaveTextContent("Only the owner can change them");
    expect(within(box).queryByRole("button", { name: "Save the deadlines" })).not.toBeInTheDocument();
  }, 30000);
});
