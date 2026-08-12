import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useFeatureFlag } from "./use-feature-flag";

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

function organizationContext(activeOrganizationId: string | null) {
  return {
    organizations: [],
    activeOrganization: null,
    activeOrganizationId,
    setActiveOrganizationId: vi.fn(),
    role: "organization_admin" as const,
    isPlatformOwner: false,
    userDisplayName: "Test User",
    hasPermission: vi.fn(() => true),
    loading: false
  };
}

function mockRows(rows: Array<{ organization_id: string | null; enabled: boolean; starts_at?: string | null; ends_at?: string | null }>) {
  const orMock = vi.fn().mockResolvedValue({
    data: rows.map((row) => ({ starts_at: null, ends_at: null, ...row })),
    error: null
  });
  const eqMock = vi.fn(() => ({ or: orMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  mockedFrom.mockReturnValue({ select: selectMock } as never);
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useFeatureFlag", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when no row matches the key", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext(ORG_ID));
    mockRows([]);

    const { result } = renderHook(() => useFeatureFlag("new_owner_dashboard"), { wrapper });

    await waitFor(() => expect(mockedFrom).toHaveBeenCalledWith("feature_flags"));
    expect(result.current).toBe(false);
  });

  it("returns true for an enabled global row when the org has no override", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext(ORG_ID));
    mockRows([{ organization_id: null, enabled: true }]);

    const { result } = renderHook(() => useFeatureFlag("new_owner_dashboard"), { wrapper });

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("returns false for a disabled global row", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext(ORG_ID));
    mockRows([{ organization_id: null, enabled: false }]);

    const { result } = renderHook(() => useFeatureFlag("new_owner_dashboard"), { wrapper });

    await waitFor(() => expect(mockedFrom).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("lets an org-specific row override a global row - org enabled overrides global disabled", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext(ORG_ID));
    mockRows([
      { organization_id: null, enabled: false },
      { organization_id: ORG_ID, enabled: true }
    ]);

    const { result } = renderHook(() => useFeatureFlag("new_owner_dashboard"), { wrapper });

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("lets an org-specific row override a global row - org disabled overrides global enabled", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext(ORG_ID));
    mockRows([
      { organization_id: null, enabled: true },
      { organization_id: ORG_ID, enabled: false }
    ]);

    const { result } = renderHook(() => useFeatureFlag("new_owner_dashboard"), { wrapper });

    await waitFor(() => expect(mockedFrom).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("ignores a row scoped to a different organization", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext(ORG_ID));
    mockRows([{ organization_id: OTHER_ORG_ID, enabled: true }]);

    const { result } = renderHook(() => useFeatureFlag("new_owner_dashboard"), { wrapper });

    await waitFor(() => expect(mockedFrom).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("returns false when starts_at is in the future", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext(ORG_ID));
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockRows([{ organization_id: null, enabled: true, starts_at: future }]);

    const { result } = renderHook(() => useFeatureFlag("new_owner_dashboard"), { wrapper });

    await waitFor(() => expect(mockedFrom).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("returns false when ends_at is in the past", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext(ORG_ID));
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockRows([{ organization_id: null, enabled: true, ends_at: past }]);

    const { result } = renderHook(() => useFeatureFlag("new_owner_dashboard"), { wrapper });

    await waitFor(() => expect(mockedFrom).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("returns true when now is within the starts_at/ends_at window", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext(ORG_ID));
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockRows([{ organization_id: null, enabled: true, starts_at: past, ends_at: future }]);

    const { result } = renderHook(() => useFeatureFlag("new_owner_dashboard"), { wrapper });

    await waitFor(() => expect(result.current).toBe(true));
  });
});
