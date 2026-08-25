import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { RoleLandingPage } from "./role-landing-page";

vi.mock("@/providers/organization-provider", () => ({
  useOrganization: vi.fn(),
}));

vi.mock("@/pages/command-center-page", () => ({
  CommandCenterPage: () => <div>manager dashboard</div>,
}));

const mockedUseOrganization = vi.mocked(useOrganization);

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<RoleLandingPage />} />
        <Route
          path="/service-verification"
          element={<div>caregiver verify visit</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RoleLandingPage", () => {
  afterEach(() => vi.clearAllMocks());

  it.each(["organization_owner", "manager", "organization_admin"] as const)(
    "opens the management dashboard for %s",
    (role) => {
      mockedUseOrganization.mockReturnValue({ role, loading: false } as never);
      renderLanding();
      expect(screen.getByText("manager dashboard")).toBeInTheDocument();
    },
  );

  it("sends caregivers directly to Verify Visit", () => {
    mockedUseOrganization.mockReturnValue({
      role: "caregiver",
      loading: false,
    } as never);
    renderLanding();
    expect(screen.getByText("caregiver verify visit")).toBeInTheDocument();
  });
});
