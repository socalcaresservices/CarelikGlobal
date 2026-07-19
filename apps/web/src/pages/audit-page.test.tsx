import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { AuditPage } from "./audit-page";

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
      displayName: "Acme",
      status: "active" as const,
      timezone: "America/Los_Angeles"
    },
    activeOrganizationId: ORG_ID,
    setActiveOrganizationId: vi.fn(),
    role: "organization_admin" as const,
    isPlatformOwner: false,
    hasPermission: vi.fn(),
    loading: false
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuditPage />
    </QueryClientProvider>
  );
}

describe("AuditPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without audit.read", () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => false) });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists audit entries when audit.read is held", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: 1,
          occurred_at: "2026-07-19T18:50:03.713Z",
          actor_user_id: "55a38d4c-375a-475a-9e90-a8b9f0c9acc3",
          actor_display_name: "Jamie",
          action: "organizations.update",
          entity_type: "organizations",
          entity_id: "119c0cdb-fb7c-49aa-9dd3-35c04db71b1b"
        }
      ],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Jamie")).toBeInTheDocument());
    expect(screen.getByText("organizations · update")).toBeInTheDocument();
    expect(mockedRpc).toHaveBeenCalledWith("list_audit_logs", { target_organization_id: ORG_ID });
  });

  it("shows a system actor for entries with no actor_user_id", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: 2,
          occurred_at: "2026-07-19T18:52:48.173Z",
          actor_user_id: null,
          actor_display_name: "System",
          action: "organization_memberships.insert",
          entity_type: "organization_memberships",
          entity_id: "683084ba-7d5f-4cbf-8888-5f8744fed79c"
        }
      ],
      error: null
    } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("System")).toBeInTheDocument());
  });

  it("shows an empty state when there is no activity", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("No activity recorded yet.")).toBeInTheDocument());
  });
});
