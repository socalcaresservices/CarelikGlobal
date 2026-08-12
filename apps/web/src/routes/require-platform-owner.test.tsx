import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { RequirePlatformOwner } from "./require-platform-owner";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));

const mockedUseOrganization = vi.mocked(useOrganization);

function renderGuard() {
  return render(
    <RequirePlatformOwner>
      <div>platform content</div>
    </RequirePlatformOwner>
  );
}

describe("RequirePlatformOwner", () => {
  it("shows a loading state while OrganizationProvider is still resolving", () => {
    mockedUseOrganization.mockReturnValue({ isPlatformOwner: false, loading: true } as never);

    renderGuard();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("platform content")).not.toBeInTheDocument();
  });

  it("renders platform content for a platform owner", () => {
    mockedUseOrganization.mockReturnValue({ isPlatformOwner: true, loading: false } as never);

    renderGuard();
    expect(screen.getByText("platform content")).toBeInTheDocument();
  });

  // An organization owner/admin has full run of their own tenant (including
  // permissions a platform owner also happens to hold) but that is a
  // completely different privilege scope from platform administration -
  // this must stay denied no matter how permissive their own org's role is.
  it("denies an organization admin", () => {
    mockedUseOrganization.mockReturnValue({ isPlatformOwner: false, loading: false, role: "organization_admin" } as never);

    renderGuard();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("platform content")).not.toBeInTheDocument();
  });

  it("denies a caregiver/staff member", () => {
    mockedUseOrganization.mockReturnValue({ isPlatformOwner: false, loading: false, role: "caregiver" } as never);

    renderGuard();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("platform content")).not.toBeInTheDocument();
  });
});
