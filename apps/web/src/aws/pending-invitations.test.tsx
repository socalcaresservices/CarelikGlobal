// A staff invitation (0087) grants nothing until the invited person accepts it. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "aaaaaaaa-0000-4000-8000-000000000002";
const membership = (organizationId: string, organizationName: string, role: string) =>
  ({ organizationId, organizationSlug: organizationName.toLowerCase().replace(/\W+/g, "-"), organizationName, organizationTimezone: "America/Los_Angeles", role, permissions: ["visits.read"] });

function setup(initial: { memberships: unknown[]; pendingInvitations: unknown[] }, accepted: unknown[]) {
  const calls: Array<{ method: string; path: string }> = [];
  let acceptedYet = false;
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    if (method === "GET" && url.pathname === "/v1/me") {
      return json(200, acceptedYet
        ? { memberships: accepted, pendingInvitations: [], profile: { displayName: "Synthetic Person" } }
        : { ...initial, profile: { displayName: "Synthetic Person" } });
    }
    if (method === "POST" && url.pathname === `/v1/me/staff-invitations/${ORG_A}/accept`) { acceptedYet = true; return json(200, { accepted: { organizationId: ORG_A, role: "manager" } }); }
    if (method === "GET" && url.pathname === "/v1/branding") return json(200, { branding: { organizationId: ORG_B, displayName: "Synthetic Home Co", accentColor: null, logoSha256: null } });
    if (method === "GET" && url.pathname === "/v1/attention") return json(200, { summary: null });
    return json(404, { error: { code: "not_found", message: "No such endpoint." } });
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={["/"]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { calls };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("pending staff invitations", () => {
  it("a person with no active organization sees the invitation, with the role it gives, and nothing else is offered until they accept", async () => {
    const { calls } = setup({ memberships: [], pendingInvitations: [{ organizationId: ORG_A, organizationName: "Synthetic Care Co", role: "manager" }] }, [membership(ORG_A, "Synthetic Care Co", "manager")]);
    expect(await screen.findByText("Synthetic Care Co")).toBeInTheDocument();
    expect(screen.getByText(/as Manager/)).toBeInTheDocument();
    expect(screen.getByText(/not part of the organization until you accept/i)).toBeInTheDocument();
    expect(screen.getByText("Your account is not active in any organization.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);   // nothing is accepted by showing it
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/v1/me/staff-invitations/${ORG_A}/accept`]));
    await waitFor(() => expect(screen.queryByText("Your account is not active in any organization.")).toBeNull());   // /v1/me is read again and the person is now a member
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
  });

  it("a person who already belongs to an organization sees the invitation to another one without losing their own", async () => {
    setup({ memberships: [membership(ORG_B, "Synthetic Home Co", "scheduler")], pendingInvitations: [{ organizationId: ORG_A, organizationName: "Synthetic Care Co", role: "manager" }] }, [membership(ORG_B, "Synthetic Home Co", "scheduler"), membership(ORG_A, "Synthetic Care Co", "manager")]);
    expect(await screen.findByRole("region", { name: "Invitations waiting for you" })).toHaveTextContent("Synthetic Care Co");
    expect(screen.queryByText("Your account is not active in any organization.")).toBeNull();
  });

  it("nothing is shown when there is no invitation (an older server sends none)", async () => {
    setup({ memberships: [membership(ORG_B, "Synthetic Home Co", "scheduler")], pendingInvitations: undefined as never }, []);
    await screen.findAllByText(/Synthetic Home Co/);
    expect(screen.queryByRole("region", { name: "Invitations waiting for you" })).toBeNull();
  });
});
