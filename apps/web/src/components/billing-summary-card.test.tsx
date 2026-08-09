import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { BillingSummaryCard } from "./billing-summary-card";

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: vi.fn() }
}));

const mockedRpc = vi.mocked(supabase.rpc);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG_ID,
    effective_status: "active",
    plan_id: "plan-1",
    plan_key: "start",
    plan_name: "Start",
    plan_version: 1,
    monthly_price_cents: 2900,
    annual_price_cents: 29000,
    custom_monthly_price_cents: null,
    custom_annual_price_cents: null,
    is_complimentary: false,
    billing_cycle: "monthly",
    billing_cycle_anchor: null,
    trial_started_at: null,
    trial_ends_at: null,
    max_active_clients: 20,
    max_active_caregivers: 15,
    max_administrators: 2,
    max_completed_visits: null,
    override_max_active_clients: null,
    override_max_active_caregivers: null,
    override_max_administrators: null,
    override_reason: null,
    override_expires_at: null,
    report_retention_days: 180,
    bulk_export_limit: 500,
    support_level: "standard",
    sms_allowance: 0,
    features: ["client_caregiver_management", "scheduling"],
    active_clients: 17,
    active_caregivers: 5,
    administrators: 1,
    completed_visits: 0,
    stripe_configured: false,
    ...overrides
  };
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BillingSummaryCard organizationId={ORG_ID} canRead={true} />
    </QueryClientProvider>
  );
}

describe("BillingSummaryCard", () => {
  it("renders nothing when the caller cannot read billing", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <BillingSummaryCard organizationId={ORG_ID} canRead={false} />
      </QueryClientProvider>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the plan name, price, status, and usage", async () => {
    mockedRpc.mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: baseRow(), error: null }) } as never);

    renderCard();

    await waitFor(() => expect(screen.getByText("Start")).toBeInTheDocument());
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/\$29\.00 \/ month/)).toBeInTheDocument();
    expect(screen.getByText("17 of 20")).toBeInTheDocument();
  });

  it("shows the read-only trial-expired message and hides the trial-days field", async () => {
    mockedRpc.mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({
        data: baseRow({ effective_status: "trial_expired", trial_ends_at: "2020-01-01T00:00:00Z" }),
        error: null
      })
    } as never);

    renderCard();

    await waitFor(() => expect(screen.getByText("Trial expired")).toBeInTheDocument());
    expect(screen.getByText(/Your trial has ended/)).toBeInTheDocument();
  });

  it("shows a load error state", async () => {
    mockedRpc.mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: new Error("boom") })
    } as never);

    renderCard();

    await waitFor(() => expect(screen.getByText("Could not load billing information for this organization.")).toBeInTheDocument());
  });
});
