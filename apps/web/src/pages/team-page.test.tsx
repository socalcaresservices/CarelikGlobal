import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { inviteMember } from "@/lib/invitations";
import { TeamPage } from "./team-page";

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
const CAREGIVER_ID = "44444444-4444-4444-8444-444444444444";

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

function authUser(id: string) {
  return {
    user: { id } as never,
    session: {} as never,
    loading: false,
    signInWithGithub: vi.fn(),
    signOut: vi.fn()
  };
}

function mockRpc({ members = [], hours = [] }: { members?: unknown[]; hours?: unknown[] }) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "list_organization_members") return Promise.resolve({ data: members, error: null }) as never;
    if (fn === "get_caregiver_hours") return Promise.resolve({ data: hours, error: null }) as never;
    return Promise.resolve({ data: [], error: null }) as never;
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <TeamPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("TeamPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without membership.read", () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => false) });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists caregivers with their role, hours, and status, and hides the invite form without membership.invite", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "membership.read")
    });
    mockRpc({
      members: [
        {
          membership_id: "m1",
          user_id: CAREGIVER_ID,
          display_name: "Sam Caregiver",
          role: "caregiver",
          status: "active"
        }
      ],
      hours: [{ caregiver_user_id: CAREGIVER_ID, target_hours_per_week: 20, scheduled_hours: 15 }]
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());
    expect(screen.getByText("caregiver")).toBeInTheDocument();
    expect(screen.getByText("15h / 20h")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.queryByText("Add a caregiver")).not.toBeInTheDocument();

    const link = screen.getByText("Sam Caregiver").closest("a");
    expect(link).toHaveAttribute("href", `/team/${CAREGIVER_ID}`);
  });

  it("shows a dash for hours when there's no matching hours row", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      members: [
        {
          membership_id: "m1",
          user_id: CAREGIVER_ID,
          display_name: "Sam Caregiver",
          role: "caregiver",
          status: "active"
        }
      ],
      hours: []
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("filters by search", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      members: [
        { membership_id: "m1", user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" },
        { membership_id: "m2", user_id: "55555555-5555-4555-8555-555555555555", display_name: "Alex Aide", role: "staff", status: "active" }
      ],
      hours: []
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Search team"), { target: { value: "alex" } });

    expect(screen.queryByText("Sam Caregiver")).not.toBeInTheDocument();
    expect(screen.getByText("Alex Aide")).toBeInTheDocument();
  });

  it("shows an empty state when there are no caregivers", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({ members: [], hours: [] });

    renderPage();
    await waitFor(() => expect(screen.getByText("No team members yet.")).toBeInTheDocument());
  });

  it("adds a caregiver as a roster record and shows a success message", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({ members: [], hours: [] });
    mockedInviteMember.mockResolvedValue({
      userId: "user-9",
      email: "new@example.com",
      organizationId: ORG_ID,
      role: "caregiver",
      status: "active"
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Add a caregiver")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Newhire" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByText("Add caregiver"));

    await waitFor(() =>
      expect(mockedInviteMember).toHaveBeenCalledWith({
        email: "new@example.com",
        organizationId: ORG_ID,
        role: "caregiver",
        firstName: "Sam",
        lastName: "Newhire",
        phone: undefined
      })
    );
    await waitFor(() => expect(screen.getByText("Added Sam Newhire.")).toBeInTheDocument());
  });

  it("changes a caregiver's role when membership.update is held", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      members: [
        { membership_id: "m1", user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" }
      ],
      hours: []
    });
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    mockedFrom.mockReturnValue({ update: updateMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());
    const row = screen.getByText("Sam Caregiver").closest("tr")!;

    fireEvent.change(within(row).getByDisplayValue("staff"), { target: { value: "coordinator" } });

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ role: "coordinator" }));
    expect(eqMock).toHaveBeenCalledWith("id", "m1");
  });

  it("revokes a caregiver when membership.update is held", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      members: [
        { membership_id: "m1", user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" }
      ],
      hours: []
    });
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    mockedFrom.mockReturnValue({ update: updateMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Revoke")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Revoke"));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ status: "revoked" }));
    expect(eqMock).toHaveBeenCalledWith("id", "m1");
  });

  it("does not show manage controls for your own row", async () => {
    mockedUseAuth.mockReturnValue(authUser(CAREGIVER_ID));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      members: [
        { membership_id: "m1", user_id: CAREGIVER_ID, display_name: "Me", role: "staff", status: "active" }
      ],
      hours: []
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Me")).toBeInTheDocument());
    const row = screen.getByText("Me").closest("tr")!;
    expect(within(row).queryByText("Revoke")).not.toBeInTheDocument();
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
  });
});
