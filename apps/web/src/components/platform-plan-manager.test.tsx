import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { PlatformPlanManager } from "./platform-plan-manager";

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: vi.fn() }
}));

const mockedRpc = vi.mocked(supabase.rpc);

function planRow(overrides: Record<string, unknown> = {}) {
  return {
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
    features: ["client_caregiver_management"],
    is_trial: false,
    trial_duration_days: null,
    is_public: true,
    is_active: true,
    is_current: true,
    is_introductory: false,
    effective_at: "2026-08-09T00:00:00Z",
    stripe_monthly_price_id: null,
    stripe_annual_price_id: null,
    ...overrides
  };
}

function renderManager() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlatformPlanManager />
    </QueryClientProvider>
  );
}

describe("PlatformPlanManager", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists current plan versions with price and limits", async () => {
    mockedRpc.mockResolvedValue({ data: [planRow()], error: null } as never);

    renderManager();

    await waitFor(() => expect(screen.getByText("Start")).toBeInTheDocument());
    expect(screen.getByText(/\$29\.00\/mo/)).toBeInTheDocument();
    expect(screen.getByText("20 / 15 / 2")).toBeInTheDocument();
  });

  it("shows the Stripe-configuration-required notice when no publishable key is set", async () => {
    mockedRpc.mockResolvedValue({ data: [planRow()], error: null } as never);

    renderManager();

    await waitFor(() => expect(screen.getByText("Stripe configuration required.")).toBeInTheDocument());
  });

  it("requires a reason before saving an edited plan", async () => {
    mockedRpc.mockResolvedValue({ data: [planRow()], error: null } as never);

    renderManager();

    await waitFor(() => expect(screen.getByText("Start")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Edit (new version)"));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save as new version" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));

    await waitFor(() => expect(screen.getByText("A reason is required to save plan changes.")).toBeInTheDocument());
    expect(mockedRpc).not.toHaveBeenCalledWith("upsert_plan_definition", expect.anything());
  });

  it("saves Stripe Price IDs entered on the plan edit form", async () => {
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_all_plan_versions") return Promise.resolve({ data: [planRow()], error: null }) as never;
      if (fn === "upsert_plan_definition") return Promise.resolve({ data: planRow({ version: 2 }), error: null }) as never;
      return Promise.resolve({ data: null, error: null }) as never;
    });

    renderManager();

    await waitFor(() => expect(screen.getByText("Start")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Edit (new version)"));

    await waitFor(() => expect(screen.getByLabelText("Monthly Stripe Price ID")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Monthly Stripe Price ID"), { target: { value: "price_monthly_123" } });
    fireEvent.change(screen.getByLabelText("Annual Stripe Price ID"), { target: { value: "price_annual_456" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Attach Stripe prices" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "upsert_plan_definition",
        expect.objectContaining({
          new_stripe_monthly_price_id: "price_monthly_123",
          new_stripe_annual_price_id: "price_annual_456"
        })
      )
    );
  });

  it("submits a plan edit with the entered reason", async () => {
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_all_plan_versions") return Promise.resolve({ data: [planRow()], error: null }) as never;
      if (fn === "upsert_plan_definition") return Promise.resolve({ data: planRow({ version: 2 }), error: null }) as never;
      return Promise.resolve({ data: null, error: null }) as never;
    });

    renderManager();

    await waitFor(() => expect(screen.getByText("Start")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Edit (new version)"));

    await waitFor(() => expect(screen.getByLabelText("Reason")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Q3 price adjustment" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "upsert_plan_definition",
        expect.objectContaining({ target_plan_key: "start", change_reason: "Q3 price adjustment" })
      )
    );
  });
});
