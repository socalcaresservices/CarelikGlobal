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

describe("CommandCenterPage", () => {
  it("leads with the organization name and Operations Dashboard framing, not engineering copy", () => {
    mockedUseOrganization.mockReturnValue({
      organizations: [],
      activeOrganization: {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "acme",
        legalName: "Acme LLC",
        displayName: "Acme",
        status: "active",
        timezone: "America/Los_Angeles",
      },
      activeOrganizationId: "11111111-1111-4111-8111-111111111111",
      setActiveOrganizationId: vi.fn(),
      role: "organization_admin",
      isPlatformOwner: false,
      hasPermission: vi.fn(() => true),
      loading: false,
    });

    render(<CommandCenterPage />);

    expect(screen.getByText("Operations Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByText(/Phase 1/)).not.toBeInTheDocument();
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
