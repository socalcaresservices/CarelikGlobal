import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { CareTeamPage } from "./care-team-page";

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

function organizationContext(hasPermission = () => true) {
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
        <CareTeamPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("CareTeamPage", () => {
  afterEach(() => vi.clearAllMocks());

  it("does not expose the roster without membership.read", () => {
    mockedUseOrganization.mockReturnValue(organizationContext(() => false));
    renderPage();
    expect(screen.getByText("You do not have permission to view workforce records.")).toBeInTheDocument();
  });

  it("lists workforce records independently from login access", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext());
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          linked_user_id: null,
          caregiver_code: "CG-AAAAAA",
          display_name: "Ashley Rivera",
          position: "Caregiver I",
          email: "ashley@example.com",
          phone: "555-0100",
          status: "active",
          desired_weekly_hours: 30,
          available_start_date: "2026-08-20"
        }
      ],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Ashley Rivera")).toBeInTheDocument());
    expect(screen.getByText("CG-AAAAAA")).toBeInTheDocument();
    expect(screen.getByText("No login")).toBeInTheDocument();
    expect(screen.getByText("30/wk")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ashley Rivera" })).toHaveAttribute(
      "href",
      "/team/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );
    expect(mockedRpc).toHaveBeenCalledWith("list_care_team_records", { target_organization_id: ORG_ID });
    expect(screen.getAllByText("Caregiver I").length).toBeGreaterThan(0);
  });

  it("filters the roster by position", async () => {
    mockedUseOrganization.mockReturnValue(organizationContext());
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          linked_user_id: null,
          caregiver_code: "CG-AAAAAA",
          display_name: "Ashley Rivera",
          position: "Caregiver I",
          email: null,
          phone: null,
          status: "active",
          desired_weekly_hours: null,
          available_start_date: null
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          linked_user_id: null,
          caregiver_code: "CG-BBBBBB",
          display_name: "Jordan Coordinator",
          position: "Coordinator",
          email: null,
          phone: null,
          status: "active",
          desired_weekly_hours: null,
          available_start_date: null
        }
      ],
      error: null
    } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Ashley Rivera")).toBeInTheDocument());
    expect(screen.getByText("Jordan Coordinator")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by position"), { target: { value: "Coordinator" } });

    expect(screen.queryByText("Ashley Rivera")).not.toBeInTheDocument();
    expect(screen.getByText("Jordan Coordinator")).toBeInTheDocument();
  });
});
