import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { inviteMember } from "@/lib/invitations";
import { AccessPage } from "./access-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/invitations", () => ({ inviteMember: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);
const mockedInviteMember = vi.mocked(inviteMember);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function baseOrganization() {
  return {
    organizations: [],
    activeOrganization: {
      id: ORG_ID,
      slug: "acme",
      legalName: "Acme LLC",
      displayName: "Acme",
      status: "active" as const,
      timezone: "America/Los_Angeles"
    },
    activeOrganizationId: ORG_ID,
    setActiveOrganizationId: vi.fn(),
    role: "organization_admin" as const,
    isPlatformOwner: false,
    hasPermission: vi.fn(),
    loading: false
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AccessPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function authUser(id: string) {
  return {
    user: { id } as never,
    session: {} as never,
    loading: false,
    signInWithGithub: vi.fn(),
    signOut: vi.fn()
  };
}

describe("AccessPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without membership.read", () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => false) });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists members but hides the invite form without membership.invite", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "membership.read")
    });
    mockedRpc.mockResolvedValue({
      data: [
        {
          membership_id: "m-1",
          user_id: "user-2",
          display_name: "Jamie",
          role: "staff",
          status: "active",
          invited_by: null,
          joined_at: null,
          created_at: "2026-01-01"
        }
      ],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Jamie")).toBeInTheDocument());
    expect(screen.queryByText("Invite a member")).not.toBeInTheDocument();
  });

  it("submits an invite and shows a success message", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);
    mockedInviteMember.mockResolvedValue({
      userId: "user-9",
      email: "new@example.com",
      organizationId: ORG_ID,
      role: "staff",
      status: "invited"
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Invite a member")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByText("Send invite"));

    await waitFor(() =>
      expect(mockedInviteMember).toHaveBeenCalledWith({
        email: "new@example.com",
        organizationId: ORG_ID,
        role: "staff"
      })
    );
    await waitFor(() => expect(screen.getByText("Invited new@example.com.")).toBeInTheDocument());
  });

  it("revokes a member when membership.update is held", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn(
        (permission: string) => permission === "membership.read" || permission === "membership.update"
      )
    });
    mockedRpc.mockResolvedValue({
      data: [
        {
          membership_id: "m-1",
          user_id: "user-2",
          display_name: "Jamie",
          role: "staff",
          status: "active",
          invited_by: null,
          joined_at: null,
          created_at: "2026-01-01"
        }
      ],
      error: null
    } as never);

    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    mockedFrom.mockReturnValue({ update: updateMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Revoke")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Revoke"));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ status: "revoked" }));
    expect(eqMock).toHaveBeenCalledWith("id", "m-1");
  });

  it("does not show manage controls for your own row", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-2"));
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn(
        (permission: string) => permission === "membership.read" || permission === "membership.update"
      )
    });
    mockedRpc.mockResolvedValue({
      data: [
        {
          membership_id: "m-1",
          user_id: "user-2",
          display_name: "Me",
          role: "staff",
          status: "active",
          invited_by: null,
          joined_at: null,
          created_at: "2026-01-01"
        }
      ],
      error: null
    } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Me")).toBeInTheDocument());
    expect(screen.queryByText("Revoke")).not.toBeInTheDocument();
  });
});
