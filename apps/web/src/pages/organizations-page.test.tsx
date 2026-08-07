import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { OrganizationsPage } from "./organizations-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationsPage />
    </QueryClientProvider>
  );
}

const registryRow = {
  organization_id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  display_name: "Acme",
  status: "active" as const,
  subscription_plan: "professional" as const,
  subscription_status: "active" as const,
  storage_used_bytes: 2 * 1024 * 1024 * 1024,
  storage_limit_gb: 10,
  user_count: 4,
  last_login_at: "2026-08-01T12:00:00.000Z",
  primary_owner_name: "Jordan Rivera",
  primary_owner_email: "jordan@acme.test",
  created_at: "2026-01-01T00:00:00.000Z"
};

describe("OrganizationsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message for a non-platform-owner", () => {
    mockedUseOrganization.mockReturnValue({ isPlatformOwner: false } as never);

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("lists organizations from list_platform_organizations for a platform owner", async () => {
    mockedUseOrganization.mockReturnValue({ isPlatformOwner: true } as never);
    mockedRpc.mockResolvedValue({ data: [registryRow], error: null } as never);

    renderPage();

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(mockedRpc).toHaveBeenCalledWith("list_platform_organizations");
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.getByText("Professional")).toBeInTheDocument();
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Jordan Rivera")).toBeInTheDocument();
    expect(screen.getByText("jordan@acme.test")).toBeInTheDocument();
    expect(screen.getByText("2.00 GB / 10 GB")).toBeInTheDocument();
  });

  it("shows an empty state when there are no organizations", async () => {
    mockedUseOrganization.mockReturnValue({ isPlatformOwner: true } as never);
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("No organizations yet.")).toBeInTheDocument());
  });

  it("shows an error message when the registry fails to load", async () => {
    mockedUseOrganization.mockReturnValue({ isPlatformOwner: true } as never);
    mockedRpc.mockResolvedValue({ data: null, error: new Error("boom") } as never);

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Could not load the organization registry.")).toBeInTheDocument()
    );
  });
});
