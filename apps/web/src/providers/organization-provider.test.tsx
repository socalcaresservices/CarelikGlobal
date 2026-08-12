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

  // Regression guard for a real production bug: an account was reachable
  // and authenticated on admin.ogevia.com and *looked* like a platform
  // owner (the shell said so) purely because of how it was signed in, not
  // because anything in the database granted it that privilege. This
  // proves the two accounts below are told apart only by their
  // user_profiles.platform_role row - never by their email address, which
  // this hook never even reads for authorization (only for the display-name
  // fallback) - so renaming/spoofing an email address cannot forge platform
  // access.
  it("derives isPlatformOwner from user_profiles.platform_role, never from the user's email", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "user-7", email: "admin.ogevia@gmail.com" } as never,
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
      // Same-looking "admin"-branded email, but no platform_role grant -
      // must not be treated as a platform owner just because of the name.
      if (table === "user_profiles") return { data: { platform_role: null }, error: null };
      if (table === "organizations") return { data: [], error: null };
      if (table === "organization_memberships" && hasEqCall(calls, "status", "invited")) {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    });

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("is-platform-owner")).toHaveTextContent("false"));
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
    window.localStorage.setItem("carelik.activeOrganizationId", ORG_ID);
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
});
