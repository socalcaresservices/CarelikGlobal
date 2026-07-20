import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { OverviewPage } from "./overview-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/components/action-center", () => ({ ActionCenter: () => null }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function baseOrganization() {
  return {
    organizations: [],
    activeOrganization: {
      id: ORG_ID,
      slug: "acme",
      legalName: "Acme LLC",
      displayName: "Acme",
      status: "active" as const,
      timezone: "America/Los_Angeles"
    },
    activeOrganizationId: ORG_ID,
    setActiveOrganizationId: vi.fn(),
    role: "organization_admin" as const,
    isPlatformOwner: false,
    hasPermission: vi.fn(() => true),
    loading: false
  };
}

function mockClientsCount() {
  const eqStatusMock = vi.fn().mockResolvedValue({ count: 3, error: null });
  const eqOrgMock = vi.fn(() => ({ eq: eqStatusMock }));
  const selectMock = vi.fn(() => ({ eq: eqOrgMock }));
  return selectMock;
}

function mockRpc(dashboard: unknown) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "list_organization_members") return Promise.resolve({ data: [], error: null }) as never;
    if (fn === "list_shifts") return Promise.resolve({ data: [], error: null }) as never;
    if (fn === "get_agency_dashboard") return Promise.resolve({ data: dashboard, error: null }) as never;
    return Promise.resolve({ data: [], error: null }) as never;
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OverviewPage />
    </QueryClientProvider>
  );
}

describe("OverviewPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows agency health numbers when they can be computed", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedFrom.mockReturnValue({ select: mockClientsCount() } as never);
    mockRpc([
      {
        active_clients: 3,
        active_caregivers: 2,
        fill_rate_pct: 94,
        compliance_score_pct: 85,
        available_capacity_hours: 12.5
      }
    ]);

    renderPage();

    await waitFor(() => expect(screen.getByText("94%")).toBeInTheDocument());
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByText("12.5h")).toBeInTheDocument();
    expect(screen.getByText("Fill rate this week")).toBeInTheDocument();
  });

  it("shows a dash with an explanation when a metric has nothing to measure against", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedFrom.mockReturnValue({ select: mockClientsCount() } as never);
    mockRpc([
      {
        active_clients: 1,
        active_caregivers: 1,
        fill_rate_pct: null,
        compliance_score_pct: null,
        available_capacity_hours: null
      }
    ]);

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Fill rate this week (no authorizations on file)")).toBeInTheDocument()
    );
    expect(screen.getByText("Compliance score (no credentials on file)")).toBeInTheDocument();
    expect(screen.getByText("Available capacity (no weekly targets set)")).toBeInTheDocument();
  });

  it("hides the agency health section without membership.read", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission !== "membership.read")
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount() } as never);
    mockRpc([]);

    renderPage();

    await waitFor(() => expect(screen.getByText("Active clients")).toBeInTheDocument());
    expect(screen.queryByText("Agency health")).not.toBeInTheDocument();
  });
});
