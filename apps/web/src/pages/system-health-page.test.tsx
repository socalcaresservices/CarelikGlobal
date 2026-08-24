import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { SystemHealthPage } from "./system-health-page";

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
    hasPermission: vi.fn(() => true),
    hasRealOrganizationAccess: true,
    loading: false
  };
}

function mockHealth(overrides: Record<string, unknown> = {}) {
  mockedRpc.mockResolvedValue({
    data: [
      {
        domain_events_pending: 0,
        domain_events_failed: 0,
        domain_events_dead_letter: 0,
        domain_events_oldest_due_minutes: null,
        stripe_webhook_failures_last_24h: 0,
        stripe_webhook_last_failure_event_type: null,
        stripe_webhook_last_failure_error: null,
        stripe_webhook_last_failure_at: null,
        ...overrides
      }
    ],
    error: null
  } as never);
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SystemHealthPage />
    </QueryClientProvider>
  );
}

describe("SystemHealthPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message for a non-platform-owner", () => {
    mockedUseOrganization.mockReturnValue({ ...platformOwnerContext(), isPlatformOwner: false });

    renderPage();

    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("shows a healthy queue with no dead letters or webhook failures", async () => {
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    mockHealth();

    renderPage();

    await waitFor(() => expect(screen.getByText("Domain event outbox")).toBeInTheDocument());
    expect(screen.getByText("Events dead-lettered")).toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Most recent failure")).not.toBeInTheDocument();
  });

  it("flags a stale queue and shows the most recent Stripe webhook failure", async () => {
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    mockHealth({
      domain_events_pending: 3,
      domain_events_failed: 1,
      domain_events_dead_letter: 2,
      domain_events_oldest_due_minutes: 45,
      stripe_webhook_failures_last_24h: 1,
      stripe_webhook_last_failure_event_type: "invoice.payment_failed",
      stripe_webhook_last_failure_error: "Stripe API error: rate limited",
      stripe_webhook_last_failure_at: "2026-08-21T03:39:01.543Z"
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("45m")).toBeInTheDocument());
    expect(screen.getByText("Queue may be stuck - check process-events")).toBeInTheDocument();
    expect(screen.getByText("Most recent failure")).toBeInTheDocument();
    expect(screen.getByText("invoice.payment_failed")).toBeInTheDocument();
    expect(screen.getByText("Stripe API error: rate limited")).toBeInTheDocument();
  });

  it("shows an error message when the health check fails to load", async () => {
    mockedUseOrganization.mockReturnValue(platformOwnerContext());
    mockedRpc.mockResolvedValue({ data: null, error: new Error("network error") } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Could not load system health.")).toBeInTheDocument());
  });
});
