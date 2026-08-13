import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsPlatformOwner } from "@/lib/use-platform-owner";
import { supabase } from "@/lib/supabase";
import { SubscriptionsPage } from "./subscriptions-page";

vi.mock("@/lib/use-platform-owner", () => ({ useIsPlatformOwner: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: vi.fn() }
}));

const mockedUseIsPlatformOwner = vi.mocked(useIsPlatformOwner);
const mockedRpc = vi.mocked(supabase.rpc);

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SubscriptionsPage />
    </QueryClientProvider>
  );
}

describe("SubscriptionsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message for a non-platform-owner", () => {
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: false, loading: false });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("renders the plan catalog for a platform owner", async () => {
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "plan-start-v1",
          plan_key: "start",
          version: 1,
          name: "Start",
          description: "For small agencies.",
          monthly_price_cents: 2900,
          annual_price_cents: 29000,
          max_active_clients: 20,
          max_active_caregivers: 15,
          max_administrators: 2,
          max_completed_visits: null,
          report_retention_days: 180,
          bulk_export_limit: 500,
          support_level: "standard",
          sms_allowance: 0,
          features: [],
          is_trial: false,
          trial_duration_days: null,
          is_public: true,
          is_active: true,
          is_current: true,
          is_introductory: false,
          effective_at: "2026-08-09T00:00:00Z",
          stripe_monthly_price_id: null,
          stripe_annual_price_id: null
        }
      ],
      error: null
    } as never);

    renderPage();

    expect(screen.getByText("Subscriptions & plans")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Start")).toBeInTheDocument());
    expect(mockedRpc).toHaveBeenCalledWith("list_all_plan_versions");
  });
});
