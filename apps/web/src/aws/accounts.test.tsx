// Accounts screen (0048): plain-language status and Admin disable/enable, against an in-memory fake of the AWS API. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { ACCOUNT_STATUS_LABEL, isAccountStatus } from "./account-status";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ME = "bbbbbbbb-0000-4000-8000-000000000001";
const CG = "bbbbbbbb-0000-4000-8000-000000000002";
const INV = "bbbbbbbb-0000-4000-8000-000000000003";
const OFF = "bbbbbbbb-0000-4000-8000-000000000004";
const REC = "abababab-0000-4000-8000-000000000009";
type Call = { method: string; path: string; body: Record<string, unknown> | null };

function fakeApi(role: "organization_owner" | "manager") {
  const calls: Call[] = [];
  const permissions = role === "organization_owner" ? ["accounts.manage", "caregivers.manage", "visits.read", "visits.manage", "organization.update"] : ["caregivers.manage", "visits.read", "visits.manage"];
  const status: Record<string, string> = { [CG]: "active", [INV]: "invitation_pending", [OFF]: "disabled" };
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body });
    const m = /^\/v1\/accounts\/([^/]+)\/(disable|enable)$/.exec(url.pathname);
    if (method === "POST" && m) {
      if (body?.reason === "FAIL") return json(502, { error: { code: "identity_unavailable", message: "Access is blocked in Ogevia, but the sign-in service did not confirm the change. Choose Disable again to finish it." } });
      status[m[1]!] = m[2] === "disable" ? "disabled" : "active";
      return json(200, { account: { userId: m[1], accountStatus: status[m[1]!] } });
    }
    switch (`${method} ${url.pathname}`) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName: "Synthetic Admin" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case "GET /v1/accounts":
        return json(200, { accounts: [
          { userId: ME, displayName: "Synthetic Admin", role: "organization_owner", accountStatus: "active", caregiverRecordId: null, caregiverCode: null, isSelf: true },
          { userId: CG, displayName: "Synthetic Caregiver", role: "caregiver", accountStatus: status[CG], caregiverRecordId: "r1", caregiverCode: "CG-1", isSelf: false, workStatus: "active", readinessMet: 5, readinessTotal: 5, hasContact: true },
          { userId: INV, displayName: "Synthetic Invitee", role: "caregiver", accountStatus: status[INV], caregiverRecordId: "r2", caregiverCode: "CG-2", isSelf: false, workStatus: "not_ready", readinessMet: 2, readinessTotal: 5, hasContact: true },
          { userId: OFF, displayName: "Synthetic Former", role: "caregiver", accountStatus: status[OFF], caregiverRecordId: "r3", caregiverCode: "CG-3", isSelf: false },
          { userId: null, displayName: "Synthetic Newcomer", role: "caregiver", accountStatus: "setup_required", caregiverRecordId: REC, caregiverCode: "CG-4", isSelf: false, workStatus: "not_ready", readinessMet: 0, readinessTotal: 5, hasContact: false },
        ] });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

function renderAt(path: string, role: "organization_owner" | "manager") {
  const api = fakeApi(role);
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

describe("Accounts", () => {
  it("shows the four statuses in plain words, never Cognito terms, and no password or email", async () => {
    renderAt("/accounts", "organization_owner");
    expect(await screen.findByText("Synthetic Caregiver (CG-1)")).toBeInTheDocument();
    for (const label of ["Active", "Invitation Pending", "Disabled", "Account Setup Required"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText(/Must set a password at the first sign-in/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Sign-in accounts" }).textContent).not.toMatch(/FORCE_CHANGE_PASSWORD|CONFIRMED|RESET_REQUIRED|@|password:/i);
    expect(screen.getByText(/Passwords are never shown here/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in Care Team" })).toHaveAttribute("href", `/care-team/${REC}`);
    expect(ACCOUNT_STATUS_LABEL.active).toBe("Active");
    expect(isAccountStatus("RESET_REQUIRED")).toBe(false);
  });

  it("you cannot disable yourself: your own row has no button; the others do", async () => {
    renderAt("/accounts", "organization_owner");
    await screen.findByText("Synthetic Caregiver (CG-1)");
    expect(screen.getAllByRole("button", { name: "Disable account…" })).toHaveLength(2); // the caregiver and the invitee, not yourself
    expect(screen.getAllByRole("button", { name: "Enable account…" })).toHaveLength(1);
  });

  it("disable needs a reason, posts it for that person only, then shows the result", async () => {
    const api = renderAt("/accounts", "organization_owner");
    await screen.findByText("Synthetic Caregiver (CG-1)");
    fireEvent.click(screen.getAllByRole("button", { name: "Disable account…" })[0]!);
    const group = await screen.findByRole("group", { name: "Disable account" });
    const go = within(group).getByRole("button", { name: "Disable account" });
    expect(go).toBeDisabled();
    fireEvent.change(within(group).getByLabelText("Reason"), { target: { value: "Left the agency" } });
    fireEvent.click(go);
    expect(await screen.findByText(/Account disabled\. The person can no longer sign in\./)).toBeInTheDocument();
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: `/v1/accounts/${CG}/disable`, body: { organizationId: ORG, reason: "Left the agency" } });
  });

  it("enable posts to the enable route; a server failure is shown in words and nothing is claimed done", async () => {
    const api = renderAt("/accounts", "organization_owner");
    await screen.findByText("Synthetic Former (CG-3)");
    fireEvent.click(screen.getByRole("button", { name: "Enable account…" }));
    const group = await screen.findByRole("group", { name: "Enable account" });
    fireEvent.change(within(group).getByLabelText("Reason"), { target: { value: "FAIL" } });
    fireEvent.click(within(group).getByRole("button", { name: "Enable account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/did not confirm the change/);
    expect(screen.queryByText(/Account enabled/)).toBeNull();
    fireEvent.change(within(group).getByLabelText("Reason"), { target: { value: "Returned to work" } });
    fireEvent.click(within(group).getByRole("button", { name: "Enable account" }));
    await waitFor(() => expect(screen.getByText(/Account enabled\. The person can sign in again\./)).toBeInTheDocument());
    expect(api.calls.filter((c) => c.method === "POST").at(-1)).toMatchObject({ path: `/v1/accounts/${OFF}/enable` });
  });

  it("a manager has no Accounts link, and the page says only an administrator can manage accounts", async () => {
    const api = renderAt("/accounts", "manager");
    expect(await screen.findByText(/Only an administrator can manage sign-in accounts/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Accounts" })).toBeNull();
    expect(api.calls.some((c) => c.path === "/v1/accounts")).toBe(false); // the page does not even ask
  });

  it("0086: a caregiver's status is the calculated one (same words as the Caregivers list); the sign-in account state is secondary, and Send sign-in link / Add email appear only for people who have not signed in", async () => {
    renderAt("/accounts", "organization_owner");
    const invitee = (await screen.findByText(/Synthetic Invitee/)).closest("li")!;
    expect(within(invitee).getByText("Not ready")).toBeInTheDocument();
    expect(within(invitee).getByText(/2 of 5 done/)).toBeInTheDocument();
    expect(within(invitee).getByText("Invitation Pending")).toBeInTheDocument();
    expect(within(invitee).getByRole("button", { name: "Send sign-in link" })).toBeInTheDocument();
    const newcomer = screen.getByText(/Synthetic Newcomer/).closest("li")!;
    expect(within(newcomer).getByRole("link", { name: "Add email" })).toHaveAttribute("href", expect.stringMatching(/^\/care-team\//));
    const active = screen.getByText(/Synthetic Caregiver \(CG-1\)/).closest("li")!;
    expect(within(active).getAllByText("Active")).toHaveLength(2); // the calculated status, then the sign-in account state
    expect(within(active).queryByText(/sign-in link|Add email/i)).not.toBeInTheDocument();
    // a staff member who is not a caregiver keeps the account status
    expect(within(screen.getByText(/Synthetic Admin — you/).closest("li")!).getByText("Active")).toBeInTheDocument();
  });
});
