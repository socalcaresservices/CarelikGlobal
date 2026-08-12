import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { OrganizationBrandingCard } from "./organization-branding-card";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn() }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function baseOrganization(overrides: Record<string, unknown> = {}) {
  return {
    organizations: [],
    activeOrganization: {
      id: ORG_ID,
      slug: "acme",
      legalName: "Acme",
      displayName: "Acme",
      status: "active" as const,
      timezone: "America/Los_Angeles",
      logoUrl: null,
      primaryColor: "#123456",
      secondaryColor: null,
      accentColor: null,
      themeMode: "light" as const,
      showPoweredBy: true
    },
    activeOrganizationId: ORG_ID,
    setActiveOrganizationId: vi.fn(),
    role: "organization_admin" as const,
    isPlatformOwner: false,
    userDisplayName: "Test User",
    hasPermission: vi.fn(),
    loading: false,
    ...overrides
  };
}

function renderCard(props: { organizationId: string; canRead: boolean; canManage: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationBrandingCard {...props} />
    </QueryClientProvider>
  );
}

function mockUpdate(result: { error: unknown } = { error: null }) {
  const eqMock = vi.fn().mockResolvedValue(result);
  const updateMock = vi.fn(() => ({ eq: eqMock }));
  mockedFrom.mockReturnValue({ update: updateMock } as never);
  return { updateMock, eqMock };
}

describe("OrganizationBrandingCard", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing without organization.read", () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-1" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());

    const { container } = renderCard({ organizationId: ORG_ID, canRead: false, canManage: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a read-only message without organization.update", () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-1" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());

    renderCard({ organizationId: ORG_ID, canRead: true, canManage: false });
    expect(screen.getByText("You don't have permission to edit branding for this organization.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Primary color")).not.toBeInTheDocument();
  });

  it("prefills the form from the active organization's current branding", () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-1" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());

    renderCard({ organizationId: ORG_ID, canRead: true, canManage: true });
    expect(screen.getByLabelText("Primary color")).toHaveValue("#123456");
    expect(screen.getByLabelText('Show "Powered by Ogevia" on public pages')).toBeChecked();
  });

  it("saves updated colors and the powered-by toggle", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-1" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const { updateMock, eqMock } = mockUpdate();

    renderCard({ organizationId: ORG_ID, canRead: true, canManage: true });

    fireEvent.change(screen.getByLabelText("Primary color"), { target: { value: "#0f8b8d" } });
    fireEvent.click(screen.getByLabelText('Show "Powered by Ogevia" on public pages'));
    fireEvent.click(screen.getByRole("button", { name: "Save branding" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ primary_color: "#0f8b8d", show_powered_by: false })
      )
    );
    expect(eqMock).toHaveBeenCalledWith("id", ORG_ID);
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });

  it("shows an error message when the save fails", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-1" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockUpdate({ error: new Error("nope") });

    renderCard({ organizationId: ORG_ID, canRead: true, canManage: true });
    fireEvent.click(screen.getByRole("button", { name: "Save branding" }));

    await waitFor(() => expect(screen.getByText("nope")).toBeInTheDocument());
  });
});
