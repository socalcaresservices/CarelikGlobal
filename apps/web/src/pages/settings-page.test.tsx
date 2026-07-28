import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { SettingsPage } from "./settings-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn()
  }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);
const mockedFrom = vi.mocked(supabase.from);
const mockedRpc = vi.mocked(supabase.rpc);

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
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updatePassword: vi.fn(),
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

// Document types (Build 019) queries .select().or().is().order() -
// .or() instead of skills/languages' .eq(), since the card needs both
// organization-null (platform default) and organization-matching rows
// in one query.
function mockReadableDocumentTypes(rows: unknown[]) {
  const orderMock = vi.fn().mockResolvedValue({ data: rows, error: null });
  const isMock = vi.fn(() => ({ order: orderMock }));
  const orMock = vi.fn(() => ({ is: isMock }));
  const selectMock = vi.fn(() => ({ or: orMock }));
  return { selectMock, orMock, isMock, orderMock };
}

// Every test that grants every permission (hasPermission: () => true) now
// also renders the Skills/Languages/Document types cards, which call
// supabase.from("skills")/from("languages")/from("document_types") -
// route those to an empty read-only stub so they don't crash the
// settings-table-focused tests that aren't exercising the lookup cards
// themselves.
function mockFromWithSettings(settingsHandlers: Record<string, unknown>) {
  mockedFrom.mockImplementation((table: string) => {
    if (table === "skills" || table === "languages") {
      return mockReadableLookup([]) as never;
    }
    if (table === "document_types") {
      return mockReadableDocumentTypes([]) as never;
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
  beforeEach(() => {
    // Default reminder settings response so tests that grant every
    // permission (and therefore render ReminderSettingsCard, Build 022)
    // but aren't specifically exercising it don't have to mock this RPC
    // themselves. Reminder-focused tests below override this.
    mockedRpc.mockResolvedValue({
      data: [{ enabled: true, interval_days: 3, max_reminders: 3 }],
      error: null
    } as never);
  });

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

    const { selectMock: documentTypesSelect } = mockReadableDocumentTypes([]);

    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect, insert: insertMock } as never;
      if (table === "languages") return { select: languagesSelect } as never;
      if (table === "document_types") return { select: documentTypesSelect } as never;
      return { select: settingsSelect } as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Dementia care")).toBeInTheDocument());

    const skillsCard = screen.getByText("Skills").closest("div")!;
    fireEvent.change(within(skillsCard).getByLabelText("Add skill"), { target: { value: "Wound care" } });
    fireEvent.click(within(skillsCard).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(insertMock).toHaveBeenCalledWith({ organization_id: ORG_ID, name: "Wound care" }));
  });

  it("shows an error message when the skills fetch fails, instead of a false empty state", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });

    const { selectMock: settingsSelect } = mockReadableSettings([]);
    const failingOrderMock = vi.fn().mockResolvedValue({ data: null, error: new Error("network error") });
    const failingIsMock = vi.fn(() => ({ order: failingOrderMock }));
    const failingEqMock = vi.fn(() => ({ is: failingIsMock }));
    const skillsSelect = vi.fn(() => ({ eq: failingEqMock }));
    const { selectMock: languagesSelect } = mockReadableLookup([]);
    const { selectMock: documentTypesSelect } = mockReadableDocumentTypes([]);

    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect } as never;
      if (table === "languages") return { select: languagesSelect } as never;
      if (table === "document_types") return { select: documentTypesSelect } as never;
      return { select: settingsSelect } as never;
    });

    renderPage();

    const skillsCard = await screen.findByText("Skills");
    await waitFor(() =>
      expect(within(skillsCard.closest("div")!).getByText("Could not load skills.")).toBeInTheDocument()
    );
    expect(within(skillsCard.closest("div")!).queryByText("None configured yet.")).not.toBeInTheDocument();
  });

  it("deactivates a configured language", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });

    const { selectMock: settingsSelect } = mockReadableSettings([]);
    const { selectMock: skillsSelect } = mockReadableLookup([]);
    const { selectMock: languagesSelect } = mockReadableLookup([{ id: "lang-1", name: "Spanish", is_active: true }]);
    const updateEqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: updateEqMock }));

    const { selectMock: documentTypesSelect } = mockReadableDocumentTypes([]);

    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect } as never;
      if (table === "languages") return { select: languagesSelect, update: updateMock } as never;
      if (table === "document_types") return { select: documentTypesSelect } as never;
      return { select: settingsSelect } as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Spanish")).toBeInTheDocument());

    const languagesCard = screen.getByText("Languages").closest("div")!;
    fireEvent.click(within(languagesCard).getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ is_active: false }));
    expect(updateEqMock).toHaveBeenCalledWith("id", "lang-1");
  });

  it("lists platform-default and custom document types, hiding Deactivate for defaults", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });

    const { selectMock: settingsSelect } = mockReadableSettings([]);
    const { selectMock: skillsSelect } = mockReadableLookup([]);
    const { selectMock: languagesSelect } = mockReadableLookup([]);
    const { selectMock: documentTypesSelect } = mockReadableDocumentTypes([
      { id: "dt-1", organization_id: null, name: "CPR Certification", category: "certification", requires_expiration: true, is_active: true },
      { id: "dt-2", organization_id: ORG_ID, name: "Facility Badge", category: null, requires_expiration: false, is_active: true }
    ]);

    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect } as never;
      if (table === "languages") return { select: languagesSelect } as never;
      if (table === "document_types") return { select: documentTypesSelect } as never;
      return { select: settingsSelect } as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("CPR Certification")).toBeInTheDocument());
    expect(screen.getByText("Facility Badge")).toBeInTheDocument();
    expect(screen.getByText("Platform default")).toBeInTheDocument();

    const documentTypesCard = screen.getByText("Document types").closest("div")!;
    expect(within(documentTypesCard).getAllByRole("button", { name: "Deactivate" })).toHaveLength(1);
  });

  it("shows an error message when the document types fetch fails, instead of a false empty state", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });

    const { selectMock: settingsSelect } = mockReadableSettings([]);
    const { selectMock: skillsSelect } = mockReadableLookup([]);
    const { selectMock: languagesSelect } = mockReadableLookup([]);
    const failingOrderMock = vi.fn().mockResolvedValue({ data: null, error: new Error("network error") });
    const failingIsMock = vi.fn(() => ({ order: failingOrderMock }));
    const failingOrMock = vi.fn(() => ({ is: failingIsMock }));
    const documentTypesSelect = vi.fn(() => ({ or: failingOrMock }));

    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect } as never;
      if (table === "languages") return { select: languagesSelect } as never;
      if (table === "document_types") return { select: documentTypesSelect } as never;
      return { select: settingsSelect } as never;
    });

    renderPage();

    const documentTypesCard = (await screen.findByText("Document types")).closest("div")!;
    await waitFor(() =>
      expect(within(documentTypesCard).getByText("Could not load document types.")).toBeInTheDocument()
    );
    expect(within(documentTypesCard).queryByText("None configured yet.")).not.toBeInTheDocument();
  });

  it("adds a custom document type when documents.manage is held", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });

    const { selectMock: settingsSelect } = mockReadableSettings([]);
    const { selectMock: skillsSelect } = mockReadableLookup([]);
    const { selectMock: languagesSelect } = mockReadableLookup([]);
    const { selectMock: documentTypesSelect } = mockReadableDocumentTypes([]);
    const insertMock = vi.fn().mockResolvedValue({ error: null });

    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect } as never;
      if (table === "languages") return { select: languagesSelect } as never;
      if (table === "document_types") return { select: documentTypesSelect, insert: insertMock } as never;
      return { select: settingsSelect } as never;
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Document types")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Add document type"), { target: { value: "Facility Badge" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "identity" } });
    fireEvent.click(screen.getByLabelText("Expires"));
    const documentTypesCard = screen.getByText("Document types").closest("div")!;
    fireEvent.click(within(documentTypesCard).getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith({
        organization_id: ORG_ID,
        name: "Facility Badge",
        category: "identity",
        requires_expiration: true
      })
    );
  });

  it("shows the effective reminder settings and saves a change", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });

    const { selectMock: settingsSelect } = mockReadableSettings([]);
    const { selectMock: skillsSelect } = mockReadableLookup([]);
    const { selectMock: languagesSelect } = mockReadableLookup([]);
    const { selectMock: documentTypesSelect } = mockReadableDocumentTypes([]);
    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect } as never;
      if (table === "languages") return { select: languagesSelect } as never;
      if (table === "document_types") return { select: documentTypesSelect } as never;
      return { select: settingsSelect } as never;
    });
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "get_document_reminder_settings") {
        return Promise.resolve({
          data: [{ enabled: true, interval_days: 3, max_reminders: 3 }],
          error: null
        }) as never;
      }
      if (fn === "set_document_reminder_settings") {
        return Promise.resolve({ data: null, error: null }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Document request reminders")).toBeInTheDocument());
    const reminderCard = screen.getByText("Document request reminders").closest("div")!;
    await waitFor(() => expect(within(reminderCard).getByLabelText("Every (days)")).toHaveValue(3));
    expect(within(reminderCard).getByLabelText("Up to")).toHaveValue(3);

    fireEvent.change(within(reminderCard).getByLabelText("Every (days)"), { target: { value: "5" } });
    fireEvent.click(within(reminderCard).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("set_document_reminder_settings", {
        target_organization_id: ORG_ID,
        target_enabled: true,
        target_interval_days: 5,
        target_max_reminders: 3
      })
    );
  });

  it("shows an error message when the reminder settings fetch fails, instead of a stuck loading state", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });

    const { selectMock: settingsSelect } = mockReadableSettings([]);
    const { selectMock: skillsSelect } = mockReadableLookup([]);
    const { selectMock: languagesSelect } = mockReadableLookup([]);
    const { selectMock: documentTypesSelect } = mockReadableDocumentTypes([]);
    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect } as never;
      if (table === "languages") return { select: languagesSelect } as never;
      if (table === "document_types") return { select: documentTypesSelect } as never;
      return { select: settingsSelect } as never;
    });
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "get_document_reminder_settings") {
        return Promise.resolve({ data: null, error: new Error("network error") }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Document request reminders")).toBeInTheDocument());
    const reminderCard = screen.getByText("Document request reminders").closest("div")!;
    await waitFor(() =>
      expect(within(reminderCard).getByText("Could not load reminder settings.")).toBeInTheDocument()
    );
    expect(within(reminderCard).queryByLabelText("Every (days)")).not.toBeInTheDocument();
  });

  it("hides Save on reminder settings without documents.manage", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission !== "documents.manage")
    });

    const { selectMock: settingsSelect } = mockReadableSettings([]);
    const { selectMock: skillsSelect } = mockReadableLookup([]);
    const { selectMock: languagesSelect } = mockReadableLookup([]);
    const { selectMock: documentTypesSelect } = mockReadableDocumentTypes([]);
    mockedFrom.mockImplementation((table: string) => {
      if (table === "skills") return { select: skillsSelect } as never;
      if (table === "languages") return { select: languagesSelect } as never;
      if (table === "document_types") return { select: documentTypesSelect } as never;
      return { select: settingsSelect } as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Document request reminders")).toBeInTheDocument());
    const reminderCard = screen.getByText("Document request reminders").closest("div")!;
    await waitFor(() => expect(within(reminderCard).getByLabelText("Every (days)")).toBeInTheDocument());
    expect(within(reminderCard).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(within(reminderCard).getByLabelText("Every (days)")).toBeDisabled();
  });
});
