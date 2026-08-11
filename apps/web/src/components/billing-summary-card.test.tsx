import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { createCheckoutSession } from "@/lib/billing-checkout";
import { BillingSummaryCard } from "./billing-summary-card";

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: vi.fn() }
}));
vi.mock("@/lib/billing-checkout", () => ({
  createCheckoutSession: vi.fn()
}));

const mockedRpc = vi.mocked(supabase.rpc);
const mockedCreateCheckoutSession = vi.mocked(createCheckoutSession);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG_ID,
    effective_status: "trialing",
    plan_id: "plan-1",
    plan_key: "trial",
    plan_name: "Trial",
    plan_version: 1,
    monthly_price_cents: 0,
    annual_price_cents: 0,
    custom_monthly_price_cents: null,
    custom_annual_price_cents: null,
    is_complimentary: false,
    billing_cycle: "monthly",
    billing_cycle_anchor: null,
    trial_started_at: null,
    trial_ends_at: "2026-09-01T00:00:00Z",
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
    stripe_current_period_start: null,
    stripe_current_period_end: null,
    ...overrides
  };
}

function mockSummary(overrides: Record<string, unknown> = {}) {
  mockedRpc.mockReturnValue({
    maybeSingle: vi.fn().mockResolvedValue({ data: baseRow(overrides), error: null })
  } as never);
}

function renderCard(canUpdate = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BillingSummaryCard organizationId={ORG_ID} canRead={true} canUpdate={canUpdate} />
    </QueryClientProvider>
  );
}

describe("BillingSummaryCard", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when the caller cannot read billing", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <BillingSummaryCard organizationId={ORG_ID} canRead={false} canUpdate={false} />
      </QueryClientProvider>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the plan name, status, and usage", async () => {
    mockSummary({ effective_status: "active", plan_key: "start", plan_name: "Start", monthly_price_cents: 2900 });

    renderCard();

    await waitFor(() => expect(screen.getByText("Start")).toBeInTheDocument());
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/\$29\.00 \/ month/)).toBeInTheDocument();
    expect(screen.getByText("17 of 20")).toBeInTheDocument();
  });

  it("shows the read-only trial-expired message and hides the trial-days field", async () => {
    mockSummary({ effective_status: "trial_expired", trial_ends_at: "2020-01-01T00:00:00Z" });

    renderCard();

    await waitFor(() => expect(screen.getByText("Trial expired")).toBeInTheDocument());
    expect(screen.getByText(/Your trial has ended/)).toBeInTheDocument();
  });

  it("lets an org admin start real Stripe checkout for Ogevia Starter", async () => {
    mockSummary();
    mockedCreateCheckoutSession.mockResolvedValue({ url: "https://checkout.stripe.com/session-123" });

    // jsdom doesn't implement navigation - stub window.location.href as a
    // plain writable property so the redirect assertion below doesn't
    // throw "Not implemented: navigation".
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: { href: string } }).location = { href: "" };

    renderCard(true);

    await waitFor(() => expect(screen.getByText("Trial")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Subscribe to Ogevia Starter" }));

    await waitFor(() => expect(mockedCreateCheckoutSession).toHaveBeenCalledWith(ORG_ID));
    await waitFor(() => expect(window.location.href).toBe("https://checkout.stripe.com/session-123"));
  });

  it("shows a confirmation instead of the Subscribe button once the subscription is active", async () => {
    mockSummary({ effective_status: "active" });

    renderCard(true);

    await waitFor(() => expect(screen.getByText("You’re subscribed to Ogevia Starter.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Subscribe to Ogevia Starter" })).not.toBeInTheDocument();
  });

  it("shows the real Stripe period end as the renewal date, not the manual billing_cycle_anchor", async () => {
    mockSummary({
      effective_status: "active",
      billing_cycle_anchor: "2020-01-01",
      stripe_current_period_end: "2026-10-15T00:00:00Z"
    });

    renderCard();

    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
    expect(screen.getByText(new Date("2026-10-15T00:00:00Z").toLocaleDateString())).toBeInTheDocument();
    expect(screen.queryByText(new Date("2020-01-01").toLocaleDateString())).not.toBeInTheDocument();
  });

  it("falls back to billing_cycle_anchor when there's no real Stripe period end", async () => {
    mockSummary({ effective_status: "active", billing_cycle_anchor: "2026-03-01" });

    renderCard();

    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
    expect(screen.getByText(new Date("2026-03-01").toLocaleDateString())).toBeInTheDocument();
  });

  it("shows a load error state", async () => {
    mockedRpc.mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: new Error("boom") })
    } as never);

    renderCard();

    await waitFor(() => expect(screen.getByText("Could not load billing information for this organization.")).toBeInTheDocument());
  });
});
