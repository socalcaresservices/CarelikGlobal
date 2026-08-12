import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ContextBar } from "./context-bar";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function baseOrganization() {
  return {
    organizations: [],
    activeOrganization: {
      id: ORG_ID,
      slug: "acme",
      legalName: "Acme LLC",
      displayName: "Acme Care",
      status: "active" as const,
      timezone: "America/Los_Angeles"
    },
    activeOrganizationId: ORG_ID,
    setActiveOrganizationId: vi.fn(),
    role: "organization_admin" as const,
    isPlatformOwner: false,
    userDisplayName: "Test User",
    hasPermission: vi.fn(() => true),
    loading: false
  };
}

function renderBar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ContextBar />
    </QueryClientProvider>
  );
}

function singleMock(data: unknown) {
  const single = vi.fn().mockResolvedValue({ data, error: null });
  return { single };
}

describe("ContextBar", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing without an active organization", () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), activeOrganization: null, activeOrganizationId: null });

    const { container } = renderBar();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows coverage, compliance, and headcount from get_agency_dashboard", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const { single } = singleMock({
      active_clients: 62,
      active_caregivers: 18,
      fill_rate_pct: 82,
      compliance_score_pct: 95,
      available_capacity_hours: 34.4
    });
    mockedRpc.mockReturnValue({ single } as never);

    renderBar();

    // Deliberately does NOT assert the organization name renders here -
    // it no longer does (see context-bar.tsx's comment: shown once in
    // AppShell's own chrome, not repeated a third time in this bar).
    await waitFor(() => expect(screen.getByText("82%")).toBeInTheDocument());
    expect(screen.getByText("95%")).toBeInTheDocument();
    expect(screen.getByText("62 clients · 18 caregivers")).toBeInTheDocument();
    expect(screen.getByText("34h available capacity this week")).toBeInTheDocument();
    expect(mockedRpc).toHaveBeenCalledWith("get_agency_dashboard", { target_organization_id: ORG_ID });
  });

  it("shows a distinct error message when the dashboard fetch fails, instead of just disappearing", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const single = vi.fn().mockResolvedValue({ data: null, error: new Error("network error") });
    mockedRpc.mockReturnValue({ single } as never);

    renderBar();

    await waitFor(() => expect(screen.getByText("Could not load live metrics.")).toBeInTheDocument());
  });

  it("shows a dash for null metrics instead of 0%", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const { single } = singleMock({
      active_clients: 0,
      active_caregivers: 0,
      fill_rate_pct: null,
      compliance_score_pct: null,
      available_capacity_hours: null
    });
    mockedRpc.mockReturnValue({ single } as never);

    renderBar();

    await waitFor(() => expect(screen.getByText("0 clients · 0 caregivers")).toBeInTheDocument());
    // Coverage and Compliance each render "-" in their own span; the
    // capacity line renders "-" inline with trailing text, so it's
    // asserted separately below rather than as a third exact "-" match.
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("— available capacity this week")).toBeInTheDocument();
  });
});
