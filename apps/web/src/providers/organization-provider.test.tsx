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
  const { organizations, activeOrganizationId, role, isPlatformOwner, hasPermission, loading } =
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
    </div>
  );
}

function renderProvider() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationProvider>
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
  timezone: "America/Los_Angeles"
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

    // role_permissions is only queried for non-platform-owners.
    expect(mockedFrom).not.toHaveBeenCalledWith("role_permissions");
  });

  it("resolves a regular member's role and permissions from role_permissions", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "user-2" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
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
});
