import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { PlatformDashboardPage } from "./platform-dashboard-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);

function platformOwnerContext() {
  return {
    organizations: [],
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

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlatformDashboardPage />
    </QueryClientProvider>
  );
}

describe("PlatformDashboardPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message for a non-platform-owner", () => {
    mockedUseOrganization.mockReturnValue({ ...platformOwnerContext(), isPlatformOwner: false });

    renderPage();

    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("shows the summary metrics and plan distribution for a platform owner", async () => {
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "get_platform_dashboard_summary") {
        return Promise.resolve({
          data: [
            {
              total_organizations: 4,
              trialing_count: 1,
              active_count: 3,
              past_due_count: 0,
              canceled_count: 0,
              suspended_count: 0,
              trial_expired_count: 0,
              new_organizations_last_30_days: 4,
              trials_ending_next_7_days: 0,
              mrr_cents: 7817
            }
          ],
          error: null
        }) as never;
      }
      if (fn === "get_platform_plan_distribution") {
        return Promise.resolve({
          data: [
            { plan_key: "start", plan_name: "Start", subscriber_count: 1 },
            { plan_key: "grow", plan_name: "Grow", subscriber_count: 1 }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("$78")).toBeInTheDocument());
    expect(screen.getByText("Organizations")).toBeInTheDocument();
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    expect(screen.getByText("Start")).toBeInTheDocument();
    expect(screen.getByText("Grow")).toBeInTheDocument();
  });

  it("shows an error message when the summary fails to load", async () => {
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "get_platform_dashboard_summary") {
        return Promise.resolve({ data: null, error: new Error("network error") }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Could not load the platform dashboard.")).toBeInTheDocument());
  });
});
