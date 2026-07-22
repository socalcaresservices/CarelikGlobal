import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { AppShell } from "./app-shell";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/components/global-search", () => ({ GlobalSearch: () => null }));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);

function baseOrganization(role: "organization_owner" | "organization_admin" | null) {
  return {
    organizations: [],
    activeOrganization: null,
    activeOrganizationId: null,
    setActiveOrganizationId: vi.fn(),
    role,
    isPlatformOwner: false,
    hasPermission: vi.fn(() => true),
    loading: false
  };
}

function renderShell() {
  return render(
    <MemoryRouter>
      <AppShell>
        <div />
      </AppShell>
    </MemoryRouter>
  );
}

describe("AppShell nav", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the Owner Dashboard link for an organization_owner", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.getByText("Owner Dashboard")).toBeInTheDocument();
  });

  it("hides the Owner Dashboard link for an organization_admin", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "admin@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_admin"));

    renderShell();
    expect(screen.queryByText("Owner Dashboard")).not.toBeInTheDocument();
  });
});
