import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { OrganizationsPage } from "./organizations-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";

const org = {
  id: ORG_ID,
  slug: "acme",
  legalName: "Acme LLC",
  displayName: "Acme",
  status: "active" as const,
  timezone: "America/Los_Angeles"
};

const otherOrg = {
  id: OTHER_ORG_ID,
  slug: "beta",
  legalName: "Beta LLC",
  displayName: "Beta",
  status: "active" as const,
  timezone: "America/Los_Angeles"
};

function baseOrganization() {
  return {
    organizations: [org, otherOrg],
    activeOrganization: org,
    activeOrganizationId: ORG_ID,
    setActiveOrganizationId: vi.fn(),
    role: "organization_admin" as const,
    isPlatformOwner: false,
    hasPermission: vi.fn(() => false),
    loading: false
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <OrganizationsPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("OrganizationsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Org creation itself moved to the Add Organization wizard
  // (add-organization-page.test.tsx) - this page now only links there.
  it("shows a + New Organization link only for a platform owner", () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), isPlatformOwner: true });

    renderPage();
    expect(screen.getByRole("link", { name: "+ New Organization" })).toHaveAttribute(
      "href",
      "/organizations/new"
    );
  });

  it("hides the + New Organization link for a non-platform-owner", () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());

    renderPage();
    expect(screen.queryByRole("link", { name: "+ New Organization" })).not.toBeInTheDocument();
  });

  it("lists organizations and switches the active one", () => {
    const setActiveOrganizationId = vi.fn();
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), setActiveOrganizationId });

    renderPage();
    expect(screen.getByText("Active")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Switch"));
    expect(setActiveOrganizationId).toHaveBeenCalledWith(OTHER_ORG_ID);
  });

  it("shows the edit form only with organization.update, and saves changes", async () => {
    const setActiveOrganizationId = vi.fn();
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      setActiveOrganizationId,
      hasPermission: vi.fn((permission: string) => permission === "organization.update")
    });

    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    mockedFrom.mockReturnValue({ update: updateMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Edit Acme")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "+ New Organization" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Legal name"), { target: { value: "Acme Holdings LLC" } });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        legal_name: "Acme Holdings LLC",
        display_name: "Acme",
        timezone: "America/Los_Angeles"
      })
    );
    expect(eqMock).toHaveBeenCalledWith("id", ORG_ID);
  });
});
