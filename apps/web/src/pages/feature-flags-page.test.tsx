import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { FeatureFlagsPage } from "./feature-flags-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const FLAG_ID = "33333333-3333-4333-8333-333333333333";

function platformOwnerContext() {
  return {
    organizations: [
      { id: ORG_ID, slug: "acme", legalName: "Acme LLC", displayName: "Acme", status: "active" as const, timezone: "America/Los_Angeles" },
      { id: OTHER_ORG_ID, slug: "beta", legalName: "Beta LLC", displayName: "Beta", status: "active" as const, timezone: "America/Los_Angeles" }
    ],
    activeOrganization: null,
    activeOrganizationId: null,
    setActiveOrganizationId: vi.fn(),
    role: "platform_owner" as const,
    isPlatformOwner: true,
    hasRealOrganizationAccess: true,
    hasPermission: vi.fn(() => true),
    loading: false
  };
}

function mockFlagsList(rows: unknown[]) {
  const orderMock = vi.fn().mockResolvedValue({ data: rows, error: null });
  const selectMock = vi.fn(() => ({ order: orderMock }));
  mockedFrom.mockReturnValue({ select: selectMock } as never);
  return { selectMock, orderMock };
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
    mockedUseOrganization.mockReturnValue({ ...platformOwnerContext(), isPlatformOwner: false });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("Feature flags")).not.toBeInTheDocument();
  });

  it("lists existing flags with their scope label", async () => {
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    mockFlagsList([
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
    ]);

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
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    mockFlagsList([]);

    renderPage();

    await waitFor(() => expect(screen.getByText("No feature flags configured yet.")).toBeInTheDocument());
  });

  it("shows an error message when the flags fetch fails, instead of a false empty state", async () => {
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    const orderMock = vi.fn().mockResolvedValue({ data: null, error: new Error("network error") });
    mockedFrom.mockReturnValue({ select: vi.fn(() => ({ order: orderMock })) } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Could not load feature flags.")).toBeInTheDocument());
    expect(screen.queryByText("No feature flags configured yet.")).not.toBeInTheDocument();
  });

  it("creates a new global flag via the form", async () => {
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    mockFlagsList([]);
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) })),
          insert: insertMock
        }) as never
    );

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
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) })),
          insert: insertMock
        }) as never
    );

    renderPage();
    await waitFor(() => expect(screen.getByText("No feature flags configured yet.")).toBeInTheDocument());

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
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) })),
          insert: insertMock
        }) as never
    );

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
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    const updateEqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: updateEqMock }));
    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn(() => ({
            order: vi.fn().mockResolvedValue({
              data: [
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
              error: null
            })
          })),
          update: updateMock
        }) as never
    );

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
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    const updateEqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: updateEqMock }));
    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn(() => ({
            order: vi.fn().mockResolvedValue({
              data: [
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
              error: null
            })
          })),
          update: updateMock
        }) as never
    );

    renderPage();
    await waitFor(() => expect(screen.getByText("new_owner_dashboard")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Disable"));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ enabled: false }));
    expect(updateEqMock).toHaveBeenCalledWith("id", FLAG_ID);
  });

  it("deletes a flag from the row button", async () => {
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    const deleteEqMock = vi.fn().mockResolvedValue({ error: null });
    const deleteMock = vi.fn(() => ({ eq: deleteEqMock }));
    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn(() => ({
            order: vi.fn().mockResolvedValue({
              data: [
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
              error: null
            })
          })),
          delete: deleteMock
        }) as never
    );

    renderPage();
    await waitFor(() => expect(screen.getByText("new_owner_dashboard")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(deleteMock).toHaveBeenCalled());
    expect(deleteEqMock).toHaveBeenCalledWith("id", FLAG_ID);
  });
});
