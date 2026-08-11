import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { PricingPage } from "./pricing-page";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedRpc = vi.mocked(supabase.rpc);

const startPlan = {
  plan_key: "start",
  name: "Start",
  description: "For small agencies just getting started.",
  monthly_price_cents: 2900,
  annual_price_cents: 29000,
  max_active_clients: 20,
  max_active_caregivers: 15,
  max_administrators: 2,
  support_level: "standard" as const,
  features: ["scheduling", "signatures"],
  is_trial: false,
  trial_duration_days: null,
  is_introductory: false
};

const trialPlan = {
  ...startPlan,
  plan_key: "trial",
  name: "Free Trial",
  is_trial: true,
  trial_duration_days: 14
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <PricingPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("PricingPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders plans from list_public_plan_versions with price, limits, and feature labels", async () => {
    mockedRpc.mockResolvedValue({ data: [startPlan], error: null } as never);

    renderPage();

    expect(await screen.findByText("Start")).toBeInTheDocument();
    expect(mockedRpc).toHaveBeenCalledWith("list_public_plan_versions");
    expect(screen.getByText("$29.00")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("Scheduling")).toBeInTheDocument();
    expect(screen.getByText("Electronic signatures")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Sign in" }).length).toBeGreaterThan(0);
  });

  it("shows 'Start free trial' as the CTA for a trial plan", async () => {
    mockedRpc.mockResolvedValue({ data: [trialPlan], error: null } as never);

    renderPage();

    expect(await screen.findByText("Free Trial")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start free trial" })).toHaveAttribute("href", "/login");
  });

  it("shows unlimited for a null limit", async () => {
    mockedRpc.mockResolvedValue({
      data: [{ ...startPlan, max_active_clients: null }],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Start")).toBeInTheDocument());
    expect(screen.getByText("Unlimited")).toBeInTheDocument();
  });

  it("shows an error state when plans fail to load", async () => {
    mockedRpc.mockResolvedValue({ data: null, error: new Error("boom") } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Could not load plans right now.")).toBeInTheDocument());
  });

  it("shows an empty state when no plans are published", async () => {
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("No plans are published yet.")).toBeInTheDocument());
  });
});
