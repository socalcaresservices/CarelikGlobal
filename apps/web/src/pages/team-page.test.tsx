import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
    loading: false,
    userDisplayName: "Acme Admin"
  };
}

function authUser(id: string) {
  return {
    user: { id } as never,
    session: {} as never,
    loading: false,
    signInWithGithub: vi.fn(),
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updatePassword: vi.fn(),
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

// A chainable, awaitable stand-in for supabase-js's query builder - every
// chain method returns the same object, and awaiting it at any point
// (however deep the chain) resolves to the configured result. Good enough
// for this page, which never inspects the builder itself, only the final
// { data, error } shape.
function createBuilder(result: { data?: unknown; error?: unknown } = { data: null, error: null }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = vi.fn(chain);
  builder.insert = vi.fn(chain);
  builder.update = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.is = vi.fn(chain);
  builder.order = vi.fn(chain);
  builder.then = (resolve: (value: typeof result) => unknown, reject?: (reason?: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

// Table-discriminating default: any table not explicitly overridden reads
// as empty rather than throwing, since most tests don't care about the
// unlinked-caregivers roster query that fires on every mount once
// membership.update is held.
function mockFrom(overrides: Record<string, ReturnType<typeof createBuilder>> = {}) {
  mockedFrom.mockImplementation(
    (table: string) =>
      (Object.prototype.hasOwnProperty.call(overrides, table)
        ? overrides[table]
        : createBuilder({ data: [], error: null })) as never
  );
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/org/acme/team"]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/org/:orgSlug/team" element={<TeamPage />} />
        </Routes>
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

  it("lists caregivers with their role, hours, and status, and hides the roster/invite forms without membership.update or membership.invite", async () => {
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
    expect(screen.getByRole("cell", { name: "caregiver" })).toBeInTheDocument();
    expect(screen.getByText("15h / 20h")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "active" })).toBeInTheDocument();
    expect(screen.queryByText("Add a caregiver")).not.toBeInTheDocument();
    expect(screen.queryByText("Invite a team member")).not.toBeInTheDocument();

    const link = screen.getByText("Sam Caregiver").closest("a");
    expect(link).toHaveAttribute("href", `/org/acme/team/${CAREGIVER_ID}`);
  });

  it("shows a dash for hours when there's no matching hours row", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockFrom();
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
    mockFrom();
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

  it("ANDs the role and status filters together", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockFrom();
    mockRpc({
      members: [
        { membership_id: "m1", user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "caregiver", status: "active" },
        { membership_id: "m2", user_id: "other-active-staff", display_name: "Alex Staff", role: "staff", status: "active" },
        { membership_id: "m3", user_id: "other-invited-caregiver", display_name: "Jamie New", role: "caregiver", status: "invited" }
      ],
      hours: []
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Filter by role"), { target: { value: "caregiver" } });
    expect(screen.getByText("Sam Caregiver")).toBeInTheDocument();
    expect(screen.getByText("Jamie New")).toBeInTheDocument();
    expect(screen.queryByText("Alex Staff")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "active" } });
    expect(screen.getByText("Sam Caregiver")).toBeInTheDocument();
    expect(screen.queryByText("Jamie New")).not.toBeInTheDocument();
    expect(screen.queryByText("Alex Staff")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Clear all"));
    expect(screen.getByText("Sam Caregiver")).toBeInTheDocument();
    expect(screen.getByText("Jamie New")).toBeInTheDocument();
    expect(screen.getByText("Alex Staff")).toBeInTheDocument();
  });

  it("shows the share-staff-portal action with a generic, client-free message", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockFrom();
    mockRpc({ members: [], hours: [] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderPage();
    await waitFor(() => expect(screen.getByText("Share staff portal")).toBeInTheDocument());

    const emailLink = screen.getByText("Email link").closest("a")!;
    expect(emailLink.getAttribute("href")).toContain("mailto:");
    expect(emailLink.getAttribute("href")).not.toMatch(/client|Rivera|SCS-C/i);

    const textLink = screen.getByText("Text link").closest("a")!;
    expect(textLink.getAttribute("href")).toContain("sms:");

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("You have access to the Ogevia staff portal")
      )
    );
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("hides the share-staff-portal action without membership.invite", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "membership.read")
    });
    mockRpc({ members: [], hours: [] });

    renderPage();
    await waitFor(() => expect(screen.getByText(/You're ready to build your workforce/)).toBeInTheDocument());
    expect(screen.queryByText("Share staff portal")).not.toBeInTheDocument();
  });

  it("shows a guided empty state when there are no caregivers", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockFrom();
    mockRpc({ members: [], hours: [] });

    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/You're ready to build your workforce/)).toBeInTheDocument()
    );
  });

  it("focuses the roster form's first name field when the empty state's call to action is clicked", async () => {
    // The "Add your first caregiver" button in the empty state doesn't
    // open a modal or navigate anywhere - the roster form already sits on
    // this page, so the button just needs to send focus there.
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockFrom();
    mockRpc({ members: [], hours: [] });

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add your first caregiver" })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "Add your first caregiver" }));
    expect(screen.getByLabelText("First name")).toHaveFocus();
  });

  it("adds a caregiver as a roster record without inviting them", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({ members: [], hours: [] });
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    const caregiverRecordsBuilder = createBuilder({ data: [], error: null });
    caregiverRecordsBuilder.insert = insertMock;
    mockFrom({ caregiver_records: caregiverRecordsBuilder });

    renderPage();
    await waitFor(() => expect(screen.getByText("Add a caregiver")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Newhire" } });
    fireEvent.change(screen.getByLabelText(/^Email \(/), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add caregiver" }));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith({
        organization_id: ORG_ID,
        first_name: "Sam",
        last_name: "Newhire",
        phone: null,
        email: "new@example.com"
      })
    );
    await waitFor(() => expect(screen.getByText("Added Sam Newhire to the roster.")).toBeInTheDocument());
    expect(mockedInviteMember).not.toHaveBeenCalled();
  });

  it("shows caregivers without login yet and invites one to Ogevia", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({ members: [], hours: [] });
    mockFrom({
      caregiver_records: createBuilder({
        data: [{ id: "cr-1", first_name: "Robin", last_name: "Roster", phone: null, email: "robin@example.com" }],
        error: null
      })
    });
    mockedInviteMember.mockResolvedValue({
      userId: "user-9",
      email: "robin@example.com",
      organizationId: ORG_ID,
      role: "caregiver",
      status: "invited"
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Caregivers without login yet")).toBeInTheDocument());
    expect(screen.getByText("Robin Roster")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Invite to Ogevia"));

    await waitFor(() =>
      expect(mockedInviteMember).toHaveBeenCalledWith({
        email: "robin@example.com",
        organizationId: ORG_ID,
        role: "caregiver",
        caregiverRecordId: "cr-1"
      })
    );
  });

  it("removes an unlinked caregiver from the roster", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({ members: [], hours: [] });
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    const caregiverRecordsBuilder = createBuilder({
      data: [{ id: "cr-1", first_name: "Robin", last_name: "Roster", phone: null, email: "robin@example.com" }],
      error: null
    });
    caregiverRecordsBuilder.update = updateMock;
    mockFrom({ caregiver_records: caregiverRecordsBuilder });

    renderPage();
    await waitFor(() => expect(screen.getByText("Robin Roster")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }))
    );
    expect(eqMock).toHaveBeenCalledWith("id", "cr-1");
  });

  it("excludes caregiver from the invite-a-team-member role options", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockFrom();
    mockRpc({ members: [], hours: [] });

    renderPage();
    await waitFor(() => expect(screen.getByText("Invite a team member")).toBeInTheDocument());

    const roleSelect = screen.getByLabelText("Role") as HTMLSelectElement;
    const optionValues = Array.from(roleSelect.options).map((option) => option.value);
    expect(optionValues).not.toContain("caregiver");
  });

  it("sends a real invite (no caregiverRecordId) from the invite-a-team-member form", async () => {
    mockedUseAuth.mockReturnValue(authUser("user-1"));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockFrom();
    mockRpc({ members: [], hours: [] });
    mockedInviteMember.mockResolvedValue({
      userId: "user-9",
      email: "new@example.com",
      organizationId: ORG_ID,
      role: "staff",
      status: "invited"
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Invite a team member")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "staff" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() =>
      expect(mockedInviteMember).toHaveBeenCalledWith({
        email: "new@example.com",
        organizationId: ORG_ID,
        role: "staff"
      })
    );
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
    mockFrom({ organization_memberships: { update: updateMock } as never });

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
    mockFrom({ organization_memberships: { update: updateMock } as never });

    renderPage();
    await waitFor(() => expect(screen.getByText("Revoke")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Revoke"));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ status: "revoked" }));
    expect(eqMock).toHaveBeenCalledWith("id", "m1");
  });

  it("does not show manage controls for your own row", async () => {
    mockedUseAuth.mockReturnValue(authUser(CAREGIVER_ID));
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockFrom();
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
