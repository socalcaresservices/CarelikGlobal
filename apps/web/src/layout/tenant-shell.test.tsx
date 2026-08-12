import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { TenantShell } from "./tenant-shell";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/layout/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div> }));
vi.mock("@/layout/staff-shell", () => ({ StaffShell: ({ children }: { children: React.ReactNode }) => <div data-testid="staff-shell">{children}</div> }));

const mockedUseOrganization = vi.mocked(useOrganization);

function renderTenantShell() {
  return render(
    <MemoryRouter>
      <TenantShell>
        <div>page content</div>
      </TenantShell>
    </MemoryRouter>
  );
}

describe("TenantShell", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders StaffShell for the caregiver role", () => {
    mockedUseOrganization.mockReturnValue({ role: "caregiver" } as never);

    renderTenantShell();

    expect(screen.getByTestId("staff-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
  });

  it("renders AppShell for every non-caregiver role", () => {
    for (const role of ["organization_owner", "organization_admin", "manager", "coordinator", "staff", "read_only"]) {
      mockedUseOrganization.mockReturnValue({ role } as never);
      const { unmount } = renderTenantShell();

      expect(screen.getByTestId("app-shell")).toBeInTheDocument();
      expect(screen.queryByTestId("staff-shell")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("renders AppShell when role is not yet resolved (null)", () => {
    mockedUseOrganization.mockReturnValue({ role: null } as never);

    renderTenantShell();

    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
  });
});
