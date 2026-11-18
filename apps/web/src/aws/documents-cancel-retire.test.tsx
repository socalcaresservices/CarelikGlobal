// Owner request 2026-11-17: cancel a document request; retire a duplicate document type. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import type { StaffDocument } from "./document-status";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PERMS = ["visits.read", "documents.read", "documents.manage", "caregivers.manage"];
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const requested = (id: string, type: string): StaffDocument => ({
  documentId: id, caregiverRecordId: "r1", personName: "Synthetic Caregiver", documentTypeId: "t-" + id, documentTypeName: type, requiresExpiry: false, dueOn: null,
  latestVersionId: null, latestVersionNumber: null, latestContentType: null, latestUploadedAt: null, latestReviewStatus: null, latestRejectionReason: null,
  issuedOn: null, expiresOn: null, verifiedExpiresOn: null, displayStatus: "requested", daysUntil: null, reviewState: "requested", currencyStatus: "not_verified",
});
const uploaded = { ...requested("d9", "CPR"), latestVersionId: "v9", latestVersionNumber: 1, latestUploadedAt: "2026-11-01T17:00:00Z", latestReviewStatus: "verified" as const, displayStatus: "verified" as const };
const TYPES = [
  { documentTypeId: "t1", name: "TB", requiresExpiry: false, isActive: true },
  { documentTypeId: "t2", name: "TB TEST", requiresExpiry: false, isActive: true },
  { documentTypeId: "t3", name: "Old badge", requiresExpiry: false, isActive: false },
];

function renderDocs(post: (path: string, body: unknown) => Response) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") { const body = JSON.parse(String(init.body)); posts.push({ path: url.pathname, body }); return post(url.pathname, body); }
    switch (url.pathname) {
      case "/v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions: PERMS }], profile: { displayName: "Synthetic Person" } });
      case "/v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "/v1/documents": return json(200, { documents: [requested("d1", "TB TEST"), uploaded] });
      case "/v1/document-types": return json(200, { types: TYPES });
      case "/v1/documents/people": return json(200, { people: [] });
      case "/v1/document-requirements": return json(200, { setup: { requirements: [] } });
      case "/v1/action-issues": return json(200, { asOf: new Date().toISOString(), matching: 0, limit: 50, offset: 0, counts: { total: 0, critical: 0, urgent: 0, routine: 0, actionNeeded: 0 }, issues: [] });
      default: return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "p@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={["/documents"]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}><AwsRoutes api={client} publicApi={client} /></CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { posts };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("cancel a document request", () => {
  it("is offered only for a request with no upload, needs a reason, and posts it", async () => {
    const { posts } = renderDocs(() => json(200, { status: "cancelled" }));
    const buttons = await screen.findAllByRole("button", { name: "Cancel request" }, { timeout: 15000 });
    expect(buttons).toHaveLength(1);   // the verified CPR has an upload: no cancel
    fireEvent.click(buttons[0]!);
    const form = screen.getByRole("form", { name: "Cancel this request" });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel request" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Give a reason");
    fireEvent.change(within(form).getByLabelText(/Reason for cancelling/), { target: { value: "Duplicate of TB" } });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/v1/documents/d1/cancel", body: { organizationId: ORG, reason: "Duplicate of TB" } }));
    expect(await screen.findByTestId("document-saved")).toHaveTextContent("Request cancelled");
  });
  it("before the release switch is on, says it is not available yet", async () => {
    renderDocs(() => json(404, { message: "Not Found" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Cancel request" }, { timeout: 15000 }))[0]!);
    const form = screen.getByRole("form", { name: "Cancel this request" });
    fireEvent.change(within(form).getByLabelText(/Reason for cancelling/), { target: { value: "Duplicate of TB" } });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel request" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("not available in this environment yet");
  });
});

describe("retire a document type", () => {
  it("active types have Retire; retired types are listed separately; the server's refusal is shown", async () => {
    const { posts } = renderDocs(() => json(409, { error: { code: "conflict", message: "This type still has 1 open request(s). Cancel or complete them first." } }));
    fireEvent.click(await screen.findByText("Document types and reminder days", undefined, { timeout: 15000 }));
    expect(await screen.findByText(/Retired \(cannot be requested\): Old badge/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retire Old badge" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retire TB TEST" }));
    const form = screen.getByRole("form", { name: "Retire TB TEST" });
    fireEvent.change(within(form).getByLabelText(/Reason/), { target: { value: "Duplicate of TB" } });
    fireEvent.click(within(form).getByRole("button", { name: "Retire type" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/v1/document-types/t2/retire", body: { organizationId: ORG, reason: "Duplicate of TB" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cancel or complete them first");
  });
});
