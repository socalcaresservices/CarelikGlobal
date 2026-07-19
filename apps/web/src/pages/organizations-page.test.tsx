import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const mockedRpc = vi.mocked(supabase.rpc);
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
    <QueryClientProvider client={queryClient}>
      <OrganizationsPage />
    </QueryClientProvider>
  );
}

describe("OrganizationsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the create-organization form only for a platform owner", () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), isPlatformOwner: true });

    renderPage();
    expect(screen.getByText("Create organization", { selector: "h3" })).toBeInTheDocument();
  });

  it("hides the create-organization form for a non-platform-owner", () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());

    renderPage();
    expect(screen.queryByText("Create organization", { selector: "h3" })).not.toBeInTheDocument();
  });

  it("rejects an invalid slug without calling create_organization", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), isPlatformOwner: true });

    renderPage();
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Legal name"), { target: { value: "Beta Care LLC" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Beta Care" } });
    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(screen.getByText(/Slug must be/)).toBeInTheDocument());
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("creates an organization with valid input", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), isPlatformOwner: true });
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    renderPage();
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "beta-care" } });
    fireEvent.change(screen.getByLabelText("Legal name"), { target: { value: "Beta Care LLC" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Beta Care" } });
    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("create_organization", {
        slug: "beta-care",
        legal_name: "Beta Care LLC",
        display_name: "Beta Care"
      })
    );
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
    expect(screen.queryByText("Create organization", { selector: "h3" })).not.toBeInTheDocument();

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
