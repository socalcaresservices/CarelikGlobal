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

  const fullProfileRow = {
    legal_name: "Acme LLC",
    display_name: "Acme",
    timezone: "America/Los_Angeles",
    dba: null,
    tax_id: null,
    business_license: null,
    org_type: null,
    website: null,
    currency: "USD",
    agency_code: null,
    address_street: null,
    address_suite: null,
    address_city: null,
    address_state: null,
    address_zip: null,
    address_country: null,
    primary_contact_name: null,
    contact_email: null,
    contact_phone: null,
    emergency_phone: null,
    logo_url: null,
    primary_color: null,
    secondary_color: null,
    accent_color: null,
    theme_mode: "light" as const,
    show_powered_by: true
  };

  function mockProfileAndUpdate(profileOverrides: Partial<typeof fullProfileRow> = {}) {
    const eqUpdateMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqUpdateMock }));
    const singleMock = vi.fn().mockResolvedValue({ data: { ...fullProfileRow, ...profileOverrides }, error: null });
    const eqSelectMock = vi.fn(() => ({ single: singleMock }));
    const selectMock = vi.fn(() => ({ eq: eqSelectMock }));
    mockedFrom.mockReturnValue({ select: selectMock, update: updateMock } as never);
    return { updateMock, eqUpdateMock };
  }

  it("shows the edit form only with organization.update, and saves changes across every profile section", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "organization.update")
    });
    const { updateMock, eqUpdateMock } = mockProfileAndUpdate();

    renderPage();
    await waitFor(() => expect(screen.getByText("Edit Acme")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText("Legal name")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "+ New Organization" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Legal name"), { target: { value: "Acme Holdings LLC" } });
    fireEvent.change(screen.getByLabelText("DBA"), { target: { value: "Acme Care" } });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Murrieta" } });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "hello@acme.test" }
    });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          legal_name: "Acme Holdings LLC",
          display_name: "Acme",
          timezone: "America/Los_Angeles",
          currency: "USD",
          theme_mode: "light",
          dba: "Acme Care",
          address_city: "Murrieta",
          contact_email: "hello@acme.test",
          // cleared/never-filled optional fields go out as null, not ""
          tax_id: null,
          website: null
        })
      )
    );
    expect(eqUpdateMock).toHaveBeenCalledWith("id", ORG_ID);
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
  });

  it("rejects an invalid contact email before saving", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "organization.update")
    });
    const { updateMock } = mockProfileAndUpdate();

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Legal name")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "not-an-email" }
    });
    fireEvent.click(screen.getByText("Save changes"));

    expect(await screen.findByText("Enter a valid contact email.")).toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("saves show_powered_by when the 'Powered by CareLik' toggle is unchecked", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "organization.update")
    });
    const { updateMock } = mockProfileAndUpdate();

    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Show "Powered by CareLik"')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Show "Powered by CareLik"'));
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ show_powered_by: false }))
    );
  });
});
