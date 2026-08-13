import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsPlatformOwner } from "@/lib/use-platform-owner";
import { supabase } from "@/lib/supabase";
import { FeatureFlagsPage } from "./feature-flags-page";

vi.mock("@/lib/use-platform-owner", () => ({ useIsPlatformOwner: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn()
  }
}));

const mockedUseIsPlatformOwner = vi.mocked(useIsPlatformOwner);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const FLAG_ID = "33333333-3333-4333-8333-333333333333";

const ORGANIZATION_OPTIONS = [
  { id: ORG_ID, display_name: "Acme" },
  { id: OTHER_ORG_ID, display_name: "Beta" }
];

function platformOwner() {
  mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });
}

// The org picker queries the "organizations" table directly (platform
// routes mount no OrganizationProvider - there's no single org to scope
// to), alongside feature_flags - so every mock here has to discriminate
// by table name rather than returning one fixed builder for every
// supabase.from() call. organizationRows defaults to a real two-org list
// so the "scope a flag to an organization" tests have an <option> to
// actually select.
function mockTables(options: {
  flagRows?: unknown[];
  flagError?: Error | null;
  organizationRows?: unknown[];
  insert?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}) {
  const {
    flagRows = [],
    flagError = null,
    organizationRows = ORGANIZATION_OPTIONS,
    insert,
    update,
    delete: del
  } = options;

  mockedFrom.mockImplementation((table: string) => {
    if (table === "organizations") {
      return {
        select: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: organizationRows, error: null }) }))
      } as never;
    }
    return {
      select: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: flagRows, error: flagError }) })),
      ...(insert ? { insert } : {}),
      ...(update ? { update } : {}),
      ...(del ? { delete: del } : {})
    } as never;
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FeatureFlagsPage />
    </QueryClientProvider>
  );
}

describe("FeatureFlagsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message for a non-platform-owner", () => {
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: false, loading: false });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("Feature flags")).not.toBeInTheDocument();
  });

  it("lists existing flags with their scope label", async () => {
    platformOwner();
    mockTables({
      flagRows: [
        {
          id: FLAG_ID,
          key: "new_owner_dashboard",
          organization_id: null,
          enabled: true,
          configuration: {},
          starts_at: null,
          ends_at: null,
          updated_at: "2026-07-01T00:00:00Z"
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          key: "beta_scheduling",
          organization_id: ORG_ID,
          enabled: false,
          configuration: {},
          starts_at: null,
          ends_at: null,
          updated_at: "2026-07-01T00:00:00Z"
        }
      ]
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("new_owner_dashboard")).toBeInTheDocument());
    expect(screen.getByText("Global")).toBeInTheDocument();
    const globalRow = screen.getByText("new_owner_dashboard").closest("li")!;
    const betaRow = screen.getByText("beta_scheduling").closest("li")!;
    expect(within(betaRow).getByText("Acme")).toBeInTheDocument();
    expect(within(globalRow).getByText("Enabled")).toBeInTheDocument();
    expect(within(betaRow).getByText("Disabled")).toBeInTheDocument();
  });

  it("shows an empty state when there are no flags yet", async () => {
    platformOwner();
    mockTables({ flagRows: [] });

    renderPage();

    await waitFor(() => expect(screen.getByText("No feature flags configured yet.")).toBeInTheDocument());
  });

  it("shows an error message when the flags fetch fails, instead of a false empty state", async () => {
    platformOwner();
    mockTables({ flagRows: null as never, flagError: new Error("network error") });

    renderPage();

    await waitFor(() => expect(screen.getByText("Could not load feature flags.")).toBeInTheDocument());
    expect(screen.queryByText("No feature flags configured yet.")).not.toBeInTheDocument();
  });

  it("creates a new global flag via the form", async () => {
    platformOwner();
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockTables({ flagRows: [], insert: insertMock });

    renderPage();
    await waitFor(() => expect(screen.getByText("No feature flags configured yet.")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "new_owner_dashboard" } });
    fireEvent.click(screen.getByLabelText("Enabled"));
    fireEvent.click(screen.getByText("Create flag"));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith({
        key: "new_owner_dashboard",
        organization_id: null,
        enabled: true,
        starts_at: null,
        ends_at: null,
        configuration: {}
      })
    );
  });

  it("scopes a new flag to the selected organization", async () => {
    platformOwner();
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockTables({ flagRows: [], insert: insertMock });

    renderPage();
    await waitFor(() => expect(screen.getByText("No feature flags configured yet.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "beta_scheduling" } });
    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: ORG_ID } });
    fireEvent.click(screen.getByText("Create flag"));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({ key: "beta_scheduling", organization_id: ORG_ID, enabled: false })
      )
    );
  });

  it("rejects invalid JSON in the configuration field without submitting", async () => {
    platformOwner();
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockTables({ flagRows: [], insert: insertMock });

    renderPage();
    await waitFor(() => expect(screen.getByText("No feature flags configured yet.")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "broken_flag" } });
    fireEvent.change(screen.getByLabelText("Configuration (JSON, optional)"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByText("Create flag"));

    await waitFor(() =>
      expect(screen.getByText('Configuration must be valid JSON (e.g. {} or {"rolloutPct":50}).')).toBeInTheDocument()
    );
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("edits an existing flag, pre-filling the form and updating by id", async () => {
    platformOwner();
    const updateEqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: updateEqMock }));
    mockTables({
      flagRows: [
        {
          id: FLAG_ID,
          key: "new_owner_dashboard",
          organization_id: null,
          enabled: true,
          configuration: {},
          starts_at: null,
          ends_at: null,
          updated_at: "2026-07-01T00:00:00Z"
        }
      ],
      update: updateMock
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("new_owner_dashboard")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByLabelText("Key")).toHaveValue("new_owner_dashboard");
    expect(screen.getByLabelText("Key")).toBeDisabled();

    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ key: "new_owner_dashboard", organization_id: null, enabled: true })
      )
    );
    expect(updateEqMock).toHaveBeenCalledWith("id", FLAG_ID);
  });

  it("toggles a flag's enabled state from the row button", async () => {
    platformOwner();
    const updateEqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: updateEqMock }));
    mockTables({
      flagRows: [
        {
          id: FLAG_ID,
          key: "new_owner_dashboard",
          organization_id: null,
          enabled: true,
          configuration: {},
          starts_at: null,
          ends_at: null,
          updated_at: "2026-07-01T00:00:00Z"
        }
      ],
      update: updateMock
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("new_owner_dashboard")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Disable"));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ enabled: false }));
    expect(updateEqMock).toHaveBeenCalledWith("id", FLAG_ID);
  });

  it("deletes a flag from the row button", async () => {
    platformOwner();
    const deleteEqMock = vi.fn().mockResolvedValue({ error: null });
    const deleteMock = vi.fn(() => ({ eq: deleteEqMock }));
    mockTables({
      flagRows: [
        {
          id: FLAG_ID,
          key: "new_owner_dashboard",
          organization_id: null,
          enabled: true,
          configuration: {},
          starts_at: null,
          ends_at: null,
          updated_at: "2026-07-01T00:00:00Z"
        }
      ],
      delete: deleteMock
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("new_owner_dashboard")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(deleteMock).toHaveBeenCalled());
    expect(deleteEqMock).toHaveBeenCalledWith("id", FLAG_ID);
  });
});
