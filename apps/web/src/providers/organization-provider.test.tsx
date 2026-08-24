import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { supabase } from "@/lib/supabase";
import { OrganizationProvider, useOrganization } from "./organization-provider";

vi.mock("@carelik/auth", () => ({
  useAuth: vi.fn()
}));

interface QueryCall {
  method: string;
  args: unknown[];
}

type Resolver = (table: string, calls: QueryCall[]) => { data: unknown; error: unknown };

function makeBuilder(table: string, calls: QueryCall[], resolve: Resolver): unknown {
  const chainMethods = ["select", "eq", "order"] as const;
  const builder: Record<string, unknown> = {};

  for (const method of chainMethods) {
    builder[method] = (...args: unknown[]) => makeBuilder(table, [...calls, { method, args }], resolve);
  }

  builder.maybeSingle = () =>
    Promise.resolve(resolve(table, [...calls, { method: "maybeSingle", args: [] }]));

  builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(resolve(table, calls)).then(onFulfilled, onRejected);

  return builder;
}

function hasEqCall(calls: QueryCall[], column: string, value: unknown) {
  return calls.some((call) => call.method === "eq" && call.args[0] === column && call.args[1] === value);
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn()
  }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedFrom = vi.mocked(supabase.from);
const mockedRpc = vi.mocked(supabase.rpc);

function setResolver(resolve: Resolver) {
  mockedFrom.mockImplementation((table: string) => makeBuilder(table, [], resolve) as never);
}

function Probe() {
  const { organizations, activeOrganization, activeOrganizationId, role, isPlatformOwner, hasPermission, loading } =
    useOrganization();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="org-count">{organizations.length}</span>
      <span data-testid="active-org-id">{activeOrganizationId ?? "none"}</span>
      <span data-testid="role">{role ?? "none"}</span>
      <span data-testid="is-platform-owner">{String(isPlatformOwner)}</span>
      <span data-testid="can-update-org">{String(hasPermission("organization.update"))}</span>
      <span data-testid="can-delete-files">{String(hasPermission("files.delete"))}</span>
      <span data-testid="active-org-logo">{activeOrganization?.logoUrl ?? "none"}</span>
      <span data-testid="active-org-powered-by">{String(activeOrganization?.showPoweredBy)}</span>
    </div>
  );
}

function renderProvider(tenantSlug?: string | undefined) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationProvider tenantSlug={tenantSlug}>
        <Probe />
      </OrganizationProvider>
    </QueryClientProvider>
  );
}

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";

const orgRow = {
  id: ORG_ID,
  slug: "acme-care",
  legal_name: "Acme Care LLC",
  display_name: "Acme Care",
  status: "active",
  timezone: "America/Los_Angeles",
  logo_url: "https://example.com/acme-logo.png",
  primary_color: "#0f172a",
  secondary_color: null,
  accent_color: null,
  theme_mode: "light",
  show_powered_by: false
};

const otherOrgRow = {
  ...orgRow,
  id: OTHER_ORG_ID,
  slug: "other-org",
  legal_name: "Other Org LLC",
  display_name: "Other Org"
};

describe("OrganizationProvider", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("grants every permission to a platform owner without querying role_permissions", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "user-1" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updatePassword: vi.fn(),
      signOut: vi.fn()
    });
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    setResolver((table, calls) => {
      if (table === "user_profiles") return { data: { platform_role: "platform_owner" }, error: null };
      if (table === "organizations") return { data: [orgRow], error: null };
      if (table === "organization_memberships" && hasEqCall(calls, "status", "invited")) {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    });

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("is-platform-owner")).toHaveTextContent("true"));
    await waitFor(() => expect(screen.getByTestId("org-count")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByTestId("active-org-id")).toHaveTextContent(ORG_ID));
    expect(screen.getByTestId("role")).toHaveTextContent("platform_owner");
    expect(screen.getByTestId("can-update-org")).toHaveTextContent("true");
    expect(screen.getByTestId("can-delete-files")).toHaveTextContent("true");
    // Branding columns (Build 018) flow through from the organizations
    // query into activeOrganization, not just the core five fields.
    expect(screen.getByTestId("active-org-logo")).toHaveTextContent("https://example.com/acme-logo.png");
    expect(screen.getByTestId("active-org-powered-by")).toHaveTextContent("false");

    // role_permissions is only queried for non-platform-owners.
    expect(mockedFrom).not.toHaveBeenCalledWith("role_permissions");
  });

  it("resolves a regular member's role and permissions from role_permissions", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "user-2" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updatePassword: vi.fn(),
      signOut: vi.fn()
    });
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    setResolver((table, calls) => {
      if (table === "user_profiles") return { data: { platform_role: null }, error: null };
      if (table === "organizations") return { data: [orgRow], error: null };
      if (table === "organization_memberships" && hasEqCall(calls, "status", "invited")) {
        return { data: [], error: null };
      }
      if (table === "organization_memberships" && hasEqCall(calls, "status", "active")) {
        return { data: { role: "organization_admin" }, error: null };
      }
      if (table === "role_permissions") {
        return {
          data: [{ permission_key: "organization.update" }, { permission_key: "membership.read" }],
          error: null
        };
      }
      return { data: null, error: null };
    });

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("organization_admin"));
    expect(screen.getByTestId("is-platform-owner")).toHaveTextContent("false");
    await waitFor(() => expect(screen.getByTestId("can-update-org")).toHaveTextContent("true"));
    expect(screen.getByTestId("can-delete-files")).toHaveTextContent("false");
  });

  it("accepts a pending invitation on login", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "user-3" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updatePassword: vi.fn(),
      signOut: vi.fn()
    });
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    setResolver((table, calls) => {
      if (table === "user_profiles") return { data: { platform_role: null }, error: null };
      if (table === "organizations") return { data: [orgRow], error: null };
      if (table === "organization_memberships" && hasEqCall(calls, "status", "invited")) {
        return { data: [{ organization_id: OTHER_ORG_ID }], error: null };
      }
      if (table === "organization_memberships" && hasEqCall(calls, "status", "active")) {
        return { data: null, error: null };
      }
      return { data: [], error: null };
    });

    renderProvider();

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("accept_organization_invitation", {
        target_organization_id: OTHER_ORG_ID
      })
    );
  });

  // Regression test for a real bug found live 2026-08-09: a user who
  // belongs to more than one organization visited a tenant whose hostname
  // resolved (via subdomain or custom domain) to Org B, but the app kept
  // showing Org A because that was this browser's cached
  // "carelik.activeOrganizationId" from an earlier, unrelated visit to
  // Org A. The hostname must always win over a stale local cache.
  it("scopes to the tenantSlug organization even when a different org is cached from a previous visit", async () => {
    window.localStorage.setItem("carelik.activeOrganizationId.user-4", ORG_ID);
    mockedUseAuth.mockReturnValue({
      user: { id: "user-4" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updatePassword: vi.fn(),
      signOut: vi.fn()
    });
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    setResolver((table, calls) => {
      if (table === "user_profiles") return { data: { platform_role: "platform_owner" }, error: null };
      // A platform owner (or anyone who is a member of both) sees both
      // organizations here - order matches the real query's
      // "order by display_name", putting Acme Care before Other Org.
      if (table === "organizations") return { data: [orgRow, otherOrgRow], error: null };
      if (table === "organization_memberships" && hasEqCall(calls, "status", "invited")) {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    });

    renderProvider("other-org");

    await waitFor(() => expect(screen.getByTestId("active-org-id")).toHaveTextContent(OTHER_ORG_ID));
  });

  // The platform Organizations registry's "Enter organization" link opens
  // app.ogevia.com/?org=<slug> - on the app host (tenantSlug undefined),
  // that query param should pick the matching org instead of falling back
  // to "first organization", and should only apply once.
  it("prefers an ?org= deep link over the first-organization fallback on the app host", async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, search: "?org=other-org" }
    });

    mockedUseAuth.mockReturnValue({
      user: { id: "user-6" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updatePassword: vi.fn(),
      signOut: vi.fn()
    });
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    setResolver((table, calls) => {
      if (table === "user_profiles") return { data: { platform_role: "platform_owner" }, error: null };
      if (table === "organizations") return { data: [orgRow, otherOrgRow], error: null };
      if (table === "organization_memberships" && hasEqCall(calls, "status", "invited")) {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    });

    try {
      renderProvider(undefined);
      await waitFor(() => expect(screen.getByTestId("active-org-id")).toHaveTextContent(OTHER_ORG_ID));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("falls back to the first organization on a platform host, where there's no single tenant to pin to", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "user-5" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updatePassword: vi.fn(),
      signOut: vi.fn()
    });
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    setResolver((table, calls) => {
      if (table === "user_profiles") return { data: { platform_role: "platform_owner" }, error: null };
      if (table === "organizations") return { data: [orgRow, otherOrgRow], error: null };
      if (table === "organization_memberships" && hasEqCall(calls, "status", "invited")) {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    });

    renderProvider(undefined);

    await waitFor(() => expect(screen.getByTestId("active-org-id")).toHaveTextContent(ORG_ID));
  });

  // Regression test for the bug reported live: signing out of one account
  // and into a different one in the same browser (no full page reload)
  // left the previous account's last-active organization id pointed at
  // by this provider, because "carelik.activeOrganizationId" used to be
  // one flat key shared by every account that ever used this browser.
  // A user with no membership in that cached organization at all would
  // have every request scoped to an org they can't access, failing RLS
  // with a generic error that gave no hint the active organization
  // itself was wrong. The key is now scoped per user id, so a different
  // account can never inherit it in the first place.
  it("never inherits a different account's cached organization id in the same browser", async () => {
    // Org A's owner was active here earlier in this browser session.
    window.localStorage.setItem("carelik.activeOrganizationId.owner-a", ORG_ID);

    // A different user, B, signs in - a member of Other Org only, not Org A.
    mockedUseAuth.mockReturnValue({
      user: { id: "owner-b" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updatePassword: vi.fn(),
      signOut: vi.fn()
    });
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    setResolver((table, calls) => {
      if (table === "user_profiles") return { data: { platform_role: null }, error: null };
      // RLS on organizations already scopes this to B's own memberships -
      // Org A never appears here for B.
      if (table === "organizations") return { data: [otherOrgRow], error: null };
      if (table === "organization_memberships" && hasEqCall(calls, "status", "invited")) {
        return { data: [], error: null };
      }
      if (table === "organization_memberships" && hasEqCall(calls, "status", "active")) {
        return { data: { role: "organization_admin" }, error: null };
      }
      if (table === "role_permissions") return { data: [], error: null };
      return { data: null, error: null };
    });

    renderProvider(undefined);

    // Must land on B's own organization, never A's cached id - and never
    // transiently persist A's id back into B's own storage key either.
    await waitFor(() => expect(screen.getByTestId("active-org-id")).toHaveTextContent(OTHER_ORG_ID));
    expect(window.localStorage.getItem("carelik.activeOrganizationId.owner-b")).toBe(OTHER_ORG_ID);
    expect(window.localStorage.getItem("carelik.activeOrganizationId.owner-a")).toBe(ORG_ID);
  });

  // Regression test for a real but narrower race than the one above: this
  // provider component itself never unmounts on an in-place account
  // switch (no page reload), so the switch has to happen through React
  // re-rendering with a new `user` from useAuth(), not a fresh mount. A
  // standalone "persist activeOrganizationId to localStorage" effect
  // keyed on [activeOrganizationId, user?.id] fires on that same
  // transitional render using that render's still-stale
  // activeOrganizationId (owner A's org) together with the *new* user id
  // (B) - writing A's org into B's own storage key before B's own
  // resync/correction effects have had a chance to settle. Exercised
  // with a real rerender (not two separate mounts) so it actually goes
  // through the transitional commit the bug lived in.
  it("never persists the previous account's organization into the new account's key across an in-place switch", async () => {
    window.localStorage.setItem("carelik.activeOrganizationId.owner-a", ORG_ID);

    mockedUseAuth.mockReturnValue({
      user: { id: "owner-a" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updatePassword: vi.fn(),
      signOut: vi.fn()
    });
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);
    setResolver((table, calls) => {
      if (table === "user_profiles") return { data: { platform_role: null }, error: null };
      if (table === "organizations") return { data: [orgRow], error: null };
      if (table === "organization_memberships" && hasEqCall(calls, "status", "invited")) {
        return { data: [], error: null };
      }
      if (table === "organization_memberships" && hasEqCall(calls, "status", "active")) {
        return { data: { role: "organization_admin" }, error: null };
      }
      if (table === "role_permissions") return { data: [], error: null };
      return { data: null, error: null };
    });

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <OrganizationProvider>
          <Probe />
        </OrganizationProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(screen.getByTestId("active-org-id")).toHaveTextContent(ORG_ID));

    // User B signs in, in place - same tab, same provider instance, no
    // remount. B is a member of Other Org only.
    mockedUseAuth.mockReturnValue({
      user: { id: "owner-b" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updatePassword: vi.fn(),
      signOut: vi.fn()
    });
    setResolver((table, calls) => {
      if (table === "user_profiles") return { data: { platform_role: null }, error: null };
      if (table === "organizations") return { data: [otherOrgRow], error: null };
      if (table === "organization_memberships" && hasEqCall(calls, "status", "invited")) {
        return { data: [], error: null };
      }
      if (table === "organization_memberships" && hasEqCall(calls, "status", "active")) {
        return { data: { role: "organization_admin" }, error: null };
      }
      if (table === "role_permissions") return { data: [], error: null };
      return { data: null, error: null };
    });

    rerender(
      <QueryClientProvider client={queryClient}>
        <OrganizationProvider>
          <Probe />
        </OrganizationProvider>
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByTestId("active-org-id")).toHaveTextContent(OTHER_ORG_ID));
    expect(window.localStorage.getItem("carelik.activeOrganizationId.owner-b")).toBe(OTHER_ORG_ID);
    expect(window.localStorage.getItem("carelik.activeOrganizationId.owner-a")).toBe(ORG_ID);
    // Not just the final value - B's key must never have been written
    // with A's org id at any point, even transiently, during the switch.
    expect(setItemSpy).not.toHaveBeenCalledWith("carelik.activeOrganizationId.owner-b", ORG_ID);

    setItemSpy.mockRestore();
  });
});
