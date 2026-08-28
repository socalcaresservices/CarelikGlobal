import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { CommandCenterPage } from "./command-center-page";

vi.mock("@/providers/organization-provider", () => ({
  useOrganization: vi.fn(),
}));
vi.mock("@/components/action-center", () => ({ ActionCenter: () => null }));
vi.mock("@/components/operational-snapshot", () => ({
  OperationalSnapshot: () => null,
}));
vi.mock("@/components/owner-insights", () => ({ OwnerInsights: () => null }));

const mockedUseOrganization = vi.mocked(useOrganization);

function organizationContext(hasPermission: (permission: string) => boolean = () => true) {
  return {
    organizations: [],
    activeOrganization: {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "acme",
      legalName: "Acme LLC",
      displayName: "Acme",
      status: "active" as const,
      timezone: "America/Los_Angeles",
    },
    activeOrganizationId: "11111111-1111-4111-8111-111111111111",
    setActiveOrganizationId: vi.fn(),
    role: "organization_admin" as const,
    isPlatformOwner: false,
    hasPermission: vi.fn(hasPermission),
    loading: false,
  };
}

describe("CommandCenterPage", () => {
  it("leads with the organization name and Operations Dashboard framing, not engineering copy", () => {
    mockedUseOrganization.mockReturnValue(organizationContext());

    render(<CommandCenterPage />);

    expect(screen.getByText("Operations Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByText(/Phase 1/)).not.toBeInTheDocument();
  });

  it("shows a reusable Visit Verification link to staff who manage visits", () => {
    mockedUseOrganization.mockReturnValue(organizationContext((permission) => permission === "visits.manage"));

    render(<CommandCenterPage />);

    expect(screen.getByText("Visit Verification Link")).toBeInTheDocument();
    expect(screen.getByLabelText("Visit verification link")).toHaveValue(
      new URL("/service-verification", window.location.origin).toString(),
    );
    expect(screen.getByRole("button", { name: "Copy visit link" })).toBeInTheDocument();
  });

  it("does not expose the staff share card without visit-management permission", () => {
    mockedUseOrganization.mockReturnValue(organizationContext(() => false));

    render(<CommandCenterPage />);

    expect(screen.queryByText("Visit Verification Link")).not.toBeInTheDocument();
  });

  it("falls back to the platform name when there is no active organization yet", () => {
    mockedUseOrganization.mockReturnValue({
      organizations: [],
      activeOrganization: null,
      activeOrganizationId: null,
      setActiveOrganizationId: vi.fn(),
      role: null,
      isPlatformOwner: false,
      hasPermission: vi.fn(() => true),
      loading: false,
    });

    render(<CommandCenterPage />);

    expect(screen.getByText("Ogevia")).toBeInTheDocument();
  });
});
