import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { CandidatesPage } from "./candidates-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const ORG_ID = "11111111-1111-4111-8111-111111111111";

function baseOrganization(hasPermission = () => true) {
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
    hasPermission: vi.fn(hasPermission),
    loading: false
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("Candidates pipeline", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows a not-available message without applicants.read", () => {
    mockedUseOrganization.mockReturnValue(baseOrganization(() => false));
    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists candidates returned by list_candidates_v1", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "candidate-1",
          first_name: "Ashley",
          last_name: "Rivera",
          email: "ashley@example.com",
          phone: null,
          pipeline_stage: "application_received",
          source: "indeed",
          position_applied_for: "Caregiver",
          applied_at: "2026-08-13T12:00:00.000Z",
          desired_weekly_hours: 30,
          available_start_date: null,
          imported_at: null,
          created_at: "2026-08-13T12:00:00.000Z"
        }
      ],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Ashley Rivera")).toBeInTheDocument());
    expect(screen.getAllByText("Indeed")).not.toHaveLength(0);
    expect(screen.getByText("Caregiver")).toBeInTheDocument();
    expect(screen.getByText("30h/week")).toBeInTheDocument();
    expect(mockedRpc).toHaveBeenCalledWith("list_candidates_v1", { target_organization_id: ORG_ID });
  });

  it("shows the empty Candidates state", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);
    renderPage();
    await waitFor(() => expect(screen.getByText("No candidates yet.")).toBeInTheDocument());
  });
});
