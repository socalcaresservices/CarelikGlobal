import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { PlatformSubscriberBillingPanel } from "./platform-subscriber-billing-panel";

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: vi.fn() }
}));

const mockedRpc = vi.mocked(supabase.rpc);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function summaryRow(overrides: Record<string, unknown> = {}) {
  return {
    effective_status: "active",
    plan_id: "plan-1",
    plan_key: "start",
    plan_name: "Start",
    plan_version: 1,
    monthly_price_cents: 2900,
    custom_monthly_price_cents: null,
    custom_annual_price_cents: null,
    is_complimentary: false,
    billing_cycle: "monthly",
    billing_cycle_anchor: null,
    trial_started_at: null,
    trial_ends_at: null,
    override_max_active_clients: null,
    override_max_active_caregivers: null,
    override_max_administrators: null,
    override_reason: null,
    override_expires_at: null,
    active_clients: 17,
    active_caregivers: 5,
    administrators: 1,
    ...overrides
  };
}

function mockRpcByName(overrides: Record<string, unknown> = {}) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "get_organization_billing_summary") {
      return { maybeSingle: vi.fn().mockResolvedValue({ data: summaryRow(overrides), error: null }) } as never;
    }
    if (fn === "list_all_plan_versions") {
      return Promise.resolve({
        data: [{ id: "plan-grow-v1", plan_key: "grow", name: "Grow", version: 1, is_current: true }],
        error: null
      }) as never;
    }
    return Promise.resolve({ data: null, error: null }) as never;
  });
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlatformSubscriberBillingPanel organizationId={ORG_ID} />
    </QueryClientProvider>
  );
}

describe("PlatformSubscriberBillingPanel", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the current plan, price, and usage counts", async () => {
    mockRpcByName();
    renderPanel();

    await waitFor(() => expect(screen.getByText(/Start \(v1\)/)).toBeInTheDocument());
    expect(screen.getByText(/17 clients/)).toBeInTheDocument();
  });

  it("requires a reason before migrating a plan", async () => {
    mockRpcByName();
    renderPanel();

    await waitFor(() => expect(screen.getByText(/Start \(v1\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Migrate" }));

    await waitFor(() => expect(screen.getByText("Pick a plan and enter a reason.")).toBeInTheDocument());
    expect(mockedRpc).not.toHaveBeenCalledWith("migrate_organization_plan", expect.anything());
  });

  it("migrates to a selected plan with a reason", async () => {
    mockRpcByName();
    renderPanel();

    await waitFor(() => expect(screen.getByText(/Start \(v1\)/)).toBeInTheDocument());
    const orgId = ORG_ID;
    fireEvent.change(screen.getByLabelText("Migrate to plan"), { target: { value: "plan-grow-v1" } });
    fireEvent.change(document.getElementById(`migrate-reason-${orgId}`)!, { target: { value: "Customer upgraded" } });
    fireEvent.click(screen.getByRole("button", { name: "Migrate" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "migrate_organization_plan",
        expect.objectContaining({
          target_organization_id: ORG_ID,
          new_plan_definition_id: "plan-grow-v1",
          change_reason: "Customer upgraded"
        })
      )
    );
  });

  it("requires a reason before saving a subscriber override", async () => {
    mockRpcByName();
    renderPanel();

    await waitFor(() => expect(screen.getByText(/Start \(v1\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save override" }));

    await waitFor(() =>
      expect(screen.getByText("A reason is required to change a subscriber override.")).toBeInTheDocument()
    );
    expect(mockedRpc).not.toHaveBeenCalledWith("set_organization_billing_override", expect.anything());
  });

  it("offers 'Restart trial' once a trial has already been started", async () => {
    mockRpcByName({ trial_started_at: "2026-01-01T00:00:00Z" });
    renderPanel();

    await waitFor(() => expect(screen.getByRole("button", { name: "Restart trial" })).toBeInTheDocument());
  });
});
