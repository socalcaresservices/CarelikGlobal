import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useIsPlatformOwner } from "@/lib/use-platform-owner";
import { supabase } from "@/lib/supabase";
import { OrganizationsPage } from "./organizations-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/use-platform-owner", () => ({ useIsPlatformOwner: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseIsPlatformOwner = vi.mocked(useIsPlatformOwner);
const mockedRpc = vi.mocked(supabase.rpc);

const PLATFORM_USER_ID = "33333333-3333-4333-8333-333333333333";

function authUser() {
  return {
    user: { id: PLATFORM_USER_ID } as never,
    session: {} as never,
    loading: false,
    signInWithGithub: vi.fn(),
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updatePassword: vi.fn(),
    signOut: vi.fn()
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <OrganizationsPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const registryRow = {
  organization_id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  display_name: "Acme",
  status: "active" as const,
  subscription_plan: "professional" as const,
  subscription_status: "active" as const,
  storage_used_bytes: 2 * 1024 * 1024 * 1024,
  storage_limit_gb: 10,
  user_count: 4,
  last_login_at: "2026-08-01T12:00:00.000Z",
  primary_owner_name: "Jordan Rivera",
  primary_owner_email: "jordan@acme.test",
  created_at: "2026-01-01T00:00:00.000Z"
};

describe("OrganizationsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message for a non-platform-owner", () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: false, loading: false });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("lists organizations from list_platform_organizations for a platform owner", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });
    mockedRpc.mockResolvedValue({ data: [registryRow], error: null } as never);

    renderPage();

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(mockedRpc).toHaveBeenCalledWith("list_platform_organizations");
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.getByText("Professional")).toBeInTheDocument();
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Jordan Rivera")).toBeInTheDocument();
    expect(screen.getByText("jordan@acme.test")).toBeInTheDocument();
    expect(screen.getByText("2.00 GB / 10 GB")).toBeInTheDocument();
  });

  it("links Enter organization to the org's own workspace, same host", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });
    mockedRpc.mockResolvedValue({ data: [registryRow], error: null } as never);

    renderPage();

    const link = await screen.findByRole("link", { name: "Enter organization" });
    expect(link).toHaveAttribute("href", "/org/acme");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("links New organization to the platform onboarding wizard", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });
    mockedRpc.mockResolvedValue({ data: [registryRow], error: null } as never);

    renderPage();

    const link = await screen.findByRole("link", { name: "New organization" });
    expect(link).toHaveAttribute("href", "/platform/organizations/new");
  });

  it("shows an empty state when there are no organizations", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("No organizations yet.")).toBeInTheDocument());
  });

  it("shows an error message when the registry fails to load", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });
    mockedRpc.mockResolvedValue({ data: null, error: new Error("boom") } as never);

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Could not load the organization registry.")).toBeInTheDocument()
    );
  });

  it("requests support access for an organization and hides the form once an open request exists", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });

    const openGrant = {
      id: "grant-1",
      organization_id: registryRow.organization_id,
      grantee_user_id: PLATFORM_USER_ID,
      requested_by: PLATFORM_USER_ID,
      reason: "Investigating a billing ticket",
      status: "requested" as const,
      requested_minutes: 60,
      approved_by: null,
      approved_at: null,
      expires_at: null,
      revoked_by: null,
      revoked_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z"
    };

    let grantsCall = 0;
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_platform_organizations") {
        return Promise.resolve({ data: [registryRow], error: null }) as never;
      }
      if (fn === "list_support_access_grants") {
        grantsCall += 1;
        return Promise.resolve({ data: grantsCall === 1 ? [] : [openGrant], error: null }) as never;
      }
      if (fn === "request_support_access") {
        return Promise.resolve({ data: openGrant, error: null }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Billing & support" }));
    await waitFor(() => expect(screen.getByLabelText(/Reason/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "Investigating a billing ticket" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("request_support_access", {
        target_organization_id: registryRow.organization_id,
        access_reason: "Investigating a billing ticket",
        minutes: 60
      })
    );
    await waitFor(() => expect(screen.getByText("Investigating a billing ticket")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Request access" })).not.toBeInTheDocument();
  });

  it("revokes the current user's own open support access grant", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });

    const ownGrant = {
      id: "grant-1",
      organization_id: registryRow.organization_id,
      grantee_user_id: PLATFORM_USER_ID,
      requested_by: PLATFORM_USER_ID,
      reason: "Investigating a billing ticket",
      status: "active" as const,
      requested_minutes: 60,
      approved_by: "someone-else",
      approved_at: "2026-08-01T00:05:00.000Z",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      revoked_by: null,
      revoked_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:05:00.000Z"
    };

    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_platform_organizations") {
        return Promise.resolve({ data: [registryRow], error: null }) as never;
      }
      if (fn === "list_support_access_grants") {
        return Promise.resolve({ data: [ownGrant], error: null }) as never;
      }
      if (fn === "revoke_support_access") {
        return Promise.resolve({ data: { ...ownGrant, status: "revoked" }, error: null }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Billing & support" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("revoke_support_access", { grant_id: "grant-1" })
    );
  });
});
