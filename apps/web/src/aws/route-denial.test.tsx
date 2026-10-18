// The real screens refuse a role that lacks the permission (existing behaviour, unchanged by Batch 4), at the NEW and the OLD address.
// SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

function renderAt(path: string, permissions: string[]) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me") return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "scheduler", permissions }], profile: { displayName: "Synthetic Person" } });
    if (url.pathname === "/v1/branding") return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
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
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// A person with only visits.read: may open Home but none of these screens.
const READ_ONLY = ["visits.read"];
describe("unauthorised role: the real screen refuses", () => {
  it.each([
    ["/schedule", /do not have access to the schedule/i],
    ["/clients", /do not have access to client records/i],
    ["/care-team", /do not have access to the care team/i],
    ["/care-team/recruiting", /do not have access to recruiting/i],
    ["/settings/services", /do not have access to services/i],
    ["/services", /do not have access to services/i], // OLD address, redirected, same refusal
    ["/billing-review", /do not have access to billing review/i],
    ["/continuity", /Only an Administrator or a manager can download the continuity pack/i],
  ])("%s", async (path, text) => {
    renderAt(path, READ_ONLY);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("Shift requests at the new and the old address do not show the page to a role without care_requests.read", async () => {
    renderAt("/schedule/shift-requests", READ_ONLY);
    await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByRole("link", { name: "Shift requests" })).toBeNull();
    cleanup();
    renderAt("/care-requests", READ_ONLY);
    await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByRole("link", { name: "Shift requests" })).toBeNull();
  });
});
