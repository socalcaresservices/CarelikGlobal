import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ApplicantsPage } from "./applicants-page";

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
    userDisplayName: "Test User",
    hasPermission: vi.fn(hasPermission),
    loading: false
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ApplicantsPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("ApplicantsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without applicants.read", () => {
    mockedUseOrganization.mockReturnValue(baseOrganization(() => false));

    renderPage();

    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists applicants returned by list_applicants", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "applicant-1",
          first_name: "Ashley",
          last_name: "Rivera",
          email: "ashley@example.com",
          phone: null,
          status: "new",
          desired_weekly_hours: 30,
          created_at: new Date().toISOString(),
          reviewed_by_name: null,
          hired_caregiver_user_id: null
        }
      ],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Ashley Rivera")).toBeInTheDocument());
    expect(screen.getByText("30h/week")).toBeInTheDocument();
  });

  it("shows an empty state with no applicants", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("No applicants yet.")).toBeInTheDocument());
  });
});
