import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { SettingsPage } from "./settings-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn()
  }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";

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

function authUser() {
  return {
    user: { id: USER_ID } as never,
    session: {} as never,
    loading: false,
    signInWithGithub: vi.fn(),
    signOut: vi.fn()
  };
}

function mockReadableSettings(rows: unknown[]) {
  const orderMock = vi.fn().mockResolvedValue({ data: rows, error: null });
  const eqMock = vi.fn(() => ({ order: orderMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  return { selectMock, eqMock, orderMock };
}

// skills/languages queries chain .select().eq().is().order() - one more
// hop than the settings query above.
function mockReadableLookup(rows: unknown[]) {
  const orderMock = vi.fn().mockResolvedValue({ data: rows, error: null });
  const isMock = vi.fn(() => ({ order: orderMock }));
  const eqMock = vi.fn(() => ({ is: isMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  return { selectMock, eqMock, isMock, orderMock };
}

// Every test that grants every permission (hasPermission: () => true) now
// also renders the Skills/Languages cards, which call
// supabase.from("skills")/from("languages") - route those to an empty
// read-only stub so they don't crash the settings-table-focused tests
// that aren't exercising the lookup cards themselves.
function mockFromWithSettings(settingsHandlers: Record<string, unknown>) {
  mockedFrom.mockImplementation((table: string) => {
    if (table === "skills" || table === "languages") {
      return mockReadableLookup([]) as never;
    }
    return settingsHandlers as never;
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>
  );
}

describe("SettingsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without settings.read", () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => false) });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists settings but hides the add form without settings.update", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "settings.read")
    });
    const { selectMock } = mockReadableSettings([
      {
        organization_id: ORG_ID,
        key: "notifications.default_channel",
        value: "email",
        version: 1,
        updated_by: USER_ID,
        updated_at: "2026-07-19T00:00:00.000Z"
      }
    ]);
    mockedFrom.mockReturnValue({ select: selectMock } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("notifications.default_channel")).toBeInTheDocument());
    expect(screen.queryByText("Add a setting")).not.toBeInTheDocument();
  });

  it("rejects invalid JSON without calling upsert", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    const { selectMock } = mockReadableSettings([]);
    const upsertMock = vi.fn();
    mockFromWithSettings({ select: selectMock, upsert: upsertMock });

    renderPage();
    await waitFor(() => expect(screen.getByText("Add a setting")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "some.key" } });
    fireEvent.change(screen.getByLabelText("Value (JSON)"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Add setting" }));

    await waitFor(() => expect(screen.getByText(/must be valid JSON/)).toBeInTheDocument());
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("adds a new setting with valid JSON", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    const { selectMock } = mockReadableSettings([]);
    const upsertMock = vi.fn().mockResolvedValue({ error: null });
    mockFromWithSettings({ select: selectMock, upsert: upsertMock });

    renderPage();
    await waitFor(() => expect(screen.getByText("Add a setting")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "some.key" } });
    fireEvent.change(screen.getByLabelText("Value (JSON)"), { target: { value: '{"on":true}' } });
    fireEvent.click(screen.getByRole("button", { name: "Add setting" }));

    await waitFor(() =>
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          key: "some.key",
          value: { on: true },
          version: 1,
          updated_by: USER_ID
        }),
        { onConflict: "organization_id,key" }
      )
    );
  });

  it("deletes a setting when settings.update is held", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    const { selectMock } = mockReadableSettings([
      {
        organization_id: ORG_ID,
        key: "notifications.default_channel",
        value: "email",
        version: 1,
        updated_by: USER_ID,
        updated_at: "2026-07-19T00:00:00.000Z"
      }
    ]);
    const secondEqMock = vi.fn().mockResolvedValue({ error: null });
    const firstEqMock = vi.fn(() => ({ eq: secondEqMock }));
    const deleteMock = vi.fn(() => ({ eq: firstEqMock }));
    mockFromWithSettings({ select: selectMock, delete: deleteMock });

    renderPage();
    await waitFor(() => expect(screen.getByText("Delete")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(firstEqMock).toHaveBeenCalledWith("organization_id", ORG_ID));
    expect(secondEqMock).toHaveBeenCalledWith("key", "notifications.default_channel");
  });

  it("lists configured skills and adds a new one when skills.update is held", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });

    const { selectMock: settingsSelect } = mockReadableSettings([]);
    const { selectMock: skillsSelect } = mockReadableLookup([{ id: "skill-1", name: "Dementia care", is_active: true }]);
    const { selectMock: languagesSelect } = mockReadableLookup([]);
    const insertMock = vi.fn().mockResolvedValue({ error: null });

    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect, insert: insertMock } as never;
      if (table === "languages") return { select: languagesSelect } as never;
      return { select: settingsSelect } as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Dementia care")).toBeInTheDocument());

    const skillsCard = screen.getByText("Skills").closest("div")!;
    fireEvent.change(within(skillsCard).getByLabelText("Add skill"), { target: { value: "Wound care" } });
    fireEvent.click(within(skillsCard).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(insertMock).toHaveBeenCalledWith({ organization_id: ORG_ID, name: "Wound care" }));
  });

  it("deactivates a configured language", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });

    const { selectMock: settingsSelect } = mockReadableSettings([]);
    const { selectMock: skillsSelect } = mockReadableLookup([]);
    const { selectMock: languagesSelect } = mockReadableLookup([{ id: "lang-1", name: "Spanish", is_active: true }]);
    const updateEqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: updateEqMock }));

    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect } as never;
      if (table === "languages") return { select: languagesSelect, update: updateMock } as never;
      return { select: settingsSelect } as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Spanish")).toBeInTheDocument());

    const languagesCard = screen.getByText("Languages").closest("div")!;
    fireEvent.click(within(languagesCard).getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ is_active: false }));
    expect(updateEqMock).toHaveBeenCalledWith("id", "lang-1");
  });
});
