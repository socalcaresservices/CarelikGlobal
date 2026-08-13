import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { MarketingPage } from "./marketing-page";
import { toAdminUrl } from "@/lib/tenant-resolver";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));

const mockedUseAuth = vi.mocked(useAuth);

function renderPage() {
  return render(
    <MemoryRouter>
      <MarketingPage />
    </MemoryRouter>
  );
}

describe("MarketingPage", () => {
  it("shows the headline and feature list, and a Sign in CTA when logged out", () => {
    mockedUseAuth.mockReturnValue({ user: null } as never);

    renderPage();

    expect(screen.getByText("Care operations software for home care agencies")).toBeInTheDocument();
    expect(screen.getByText("CareScore matching")).toBeInTheDocument();
    expect(screen.getByText("Service Verification")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Sign in" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Go to Ogevia")).not.toBeInTheDocument();
  });

  it("sends an authenticated user to the application host", () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-1" } } as never);

    renderPage();

    const link = screen.getByRole("link", { name: "Go to platform admin" });
    expect(link).toHaveAttribute("href", toAdminUrl("/organizations"));
  });

  it("links to the pricing page", () => {
    mockedUseAuth.mockReturnValue({ user: null } as never);

    renderPage();

    const links = screen.getAllByRole("link", { name: "View plans" });
    expect(links[0]).toHaveAttribute("href", "/pricing");
  });
});
