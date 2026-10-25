// Visit review (0031): the review page shows why a visit needs review and the
// no-signer reason, offers only the decisions the server allows, records one
// with a reason and an idempotency key, and Billing review links to it.
// In-memory fake of the AWS API. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
type Call = { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> };

const VISIT_ID = "77777777-0000-4000-8000-0000000000aa";
function review(kind: "no_signer" | "over") {
  return {
    visitId: VISIT_ID, organizationId: ORG, visitNumber: "CL1-RSP-041026-2323-AB", visitStatus: "administrator_review", clientId: "c1",
    clientCode: "SYN-BRAVO", clientName: "Synthetic Client Bravo", caregiverName: "Pilot Caregiver B", serviceCode: "RSP", serviceName: "Respite (synthetic)",
    serviceDate: "2026-10-04", timeIn: "2026-10-05T06:23:40Z", timeOut: "2026-10-05T06:27:10Z", workedMinutes: kind === "over" ? 50 : 3,
    verifiedMinutes: kind === "over" ? 50 : 0, billableMinutes: kind === "over" ? 30 : 0, authorizationStatus: kind === "over" ? "exceeds_authorization" : "within_authorization",
    scheduledStartsAt: null, scheduledEndsAt: null, caregiverSchedulingMode: "fixed",
    confirmationMethod: kind === "over" ? "draw" : "unable_to_confirm", signerRole: "client", signerName: null, signerRelationship: null,
    confirmationReason: kind === "over" ? null : "Client asleep; parent not home", confirmedAt: "2026-10-05T06:28:00Z",
    hasSignatureEvidence: kind === "over", isCorrection: false, reviewReasons: kind === "over" ? ["over_authorization"] : ["no_client_signature"],
    decisionId: null, decision: null, decisionReason: null, decidedByName: null, decidedAt: null, activeBillingApprovalId: null, approvedMinutes: null,
    canDecide: true, allowedDecisions: kind === "over" ? ["accept_capped_billable", "close_not_billable"] : ["close_not_billable"],
    recoveryState: null, canRequestConfirmation: kind === "no_signer", decisionAcceptedMinutes: null,
  };
}

function fakeApi(kind: "no_signer" | "over") {
  const calls: Call[] = [];
  let decided = false;
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body, headers: (init?.headers ?? {}) as Record<string, string> });
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions: ["billing.approve", "billing.visits.read", "visits.read", "visits.manage", "clients.names.read"] }], profile: { displayName: "Synthetic Manager" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case `GET /v1/visits/${VISIT_ID}/review`:
        return json(200, { visit: decided ? { ...review(kind), decisionId: "d1", decision: "close_not_billable", decisionReason: "Parent unreachable (synthetic)", decidedByName: "Synthetic Manager", decidedAt: "2026-10-05T15:00:00Z", allowedDecisions: [] } : review(kind) });
      case `GET /v1/visits/${VISIT_ID}/confirmation-requests`:
        return json(200, { requests: [] });
      case `POST /v1/visits/${VISIT_ID}/confirmation-requests`:
        return json(201, { requestId: "r1", expiresAt: "2026-10-12T15:00:00Z", token: "ab".repeat(32), code: "042917" });
      case `POST /v1/visits/${VISIT_ID}/review-decision`:
        decided = true;
        return json(201, { decisionId: "d1" });
      case "GET /v1/billing-review":
        return json(200, { visits: [{ visitId: VISIT_ID, visitNumber: "CL1-RSP-041026-2323-AB", serviceCode: "RSP", serviceDate: "2026-10-04", workedMinutes: 3, verifiedMinutes: 0, billableMinutes: 0, visitStatus: "administrator_review", authorizationStatus: "within_authorization", authorizationVersion: 1, confirmationMethod: "unable_to_confirm", hasSignatureEvidence: false, isCorrection: false, reviewState: "needs_review", clientCode: "SYN-BRAVO", clientName: "Synthetic Client Bravo", caregiverName: "Pilot Caregiver B", serviceName: "Respite (synthetic)", timeIn: "2026-10-05T06:23:40Z", timeOut: "2026-10-05T06:27:10Z" }] });
      case "GET /v1/billing-approvals":
        return json(200, { approvals: [] });
      case "GET /v1/billing-rounding/preview":
        return json(200, { units: [] });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

function renderAt(path: string, kind: "no_signer" | "over") {
  const api = fakeApi(kind);
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: api.fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return api;
}

afterEach(() => vi.clearAllMocks());

describe("Visit review page", () => {
  it("no-signer visit: shows client, caregiver, times, the no-signer reason; only 'not billable' is offered; decision recorded with reason and key", async () => {
    const api = renderAt(`/visits/${VISIT_ID}`, "no_signer");
    expect(await screen.findByRole("heading", { name: "Synthetic Client Bravo" })).toBeInTheDocument();
    expect(screen.getByText("SYN-BRAVO")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent)).toEqual(["Visits"]);
    expect(screen.getByText("Pilot Caregiver B")).toBeInTheDocument();
    expect(screen.getByText("11:23 PM – 11:27 PM")).toBeInTheDocument();
    expect(screen.getByText("Client asleep; parent not home")).toBeInTheDocument();
    expect(screen.getByText(/did not confirm the visit, so it has 0 billable minutes/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Accept the billable minutes/)).toBeNull();
    // Opening the page posted nothing.
    expect(api.calls.filter((c) => c.method === "POST")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    expect(await screen.findByText("Choose what to record.")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Close the review: not billable/));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    expect(await screen.findByText("Give the reason for this decision.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Reason \(required/), { target: { value: "Parent unreachable (synthetic)" } });
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    expect(await screen.findByText("Review decision recorded. The visit record is unchanged.")).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ organizationId: ORG, decision: "close_not_billable", reason: "Parent unreachable (synthetic)" });
    expect(Object.keys(post.headers).map((h) => h.toLowerCase())).toContain("idempotency-key");
    expect(await screen.findByText("Reviewed — not billable")).toBeInTheDocument();
    // Correct is a separate action.
    expect(screen.getByRole("link", { name: "Correct" })).toHaveAttribute("href", `/service-verification/reports?view=visits&correct=${VISIT_ID}`);
  });

  it("over-authorization visit with a signature: both decisions offered, with the over minutes explained", async () => {
    renderAt(`/visits/${VISIT_ID}`, "over");
    expect(await screen.findByText(/Worked 50 min, but only 30 min fit within this month's authorization; 20 min is over it/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Accept the billable minutes within the authorization/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Close the review: not billable/)).toBeInTheDocument();
  });

  it("no-signer visit can wait for a signature instead: a secure link and phone code are created once and shown with instructions", async () => {
    const api = renderAt(`/visits/${VISIT_ID}`, "no_signer");
    expect(await screen.findByRole("heading", { name: "Get the missing signature" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create secure link" }));
    expect(await screen.findByText("Enter the name of the person who will confirm the visit.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Person who will confirm"), { target: { value: "Synthetic Parent Rivera" } });
    fireEvent.click(screen.getByRole("button", { name: "Create secure link" }));
    expect(await screen.findByText("Record how you will verify the person by phone before you give the code.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("How you will verify them by phone"), { target: { value: "Call the number on file" } });
    fireEvent.click(screen.getByRole("button", { name: "Create secure link" }));
    expect(await screen.findByText("Shown only once. Copy them now.")).toBeInTheDocument();
    // The token goes in the URL fragment (never sent to the web server); the code is shown separately.
    expect(screen.getByText(`${window.location.origin}/confirm-visit#${"ab".repeat(32)}`)).toBeInTheDocument();
    expect(screen.getByLabelText("One-time code")).toHaveTextContent("042917");
    expect(screen.getByText(/Give this code only by phone/)).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/confirmation-requests"))!;
    expect(post.body).toEqual({ organizationId: ORG, channel: "link", recipientName: "Synthetic Parent Rivera", recipientRole: "parent", identityCheck: "Call the number on file", expiresInDays: 7 });
    expect(Object.keys(post.headers).map((h) => h.toLowerCase())).toContain("idempotency-key");
  });

  it("Billing review offers 'Correct or resolve' linking to the exact visit (no 'Review first' text)", async () => {
    renderAt("/billing-review", "no_signer");
    const links = await screen.findAllByRole("link", { name: "Correct or resolve" });
    expect(links[0]).toHaveAttribute("href", `/visits/${VISIT_ID}`);
    expect(screen.queryByText("Review first")).toBeNull();
  });
});
