import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useIsPlatformOwner } from "@/lib/use-platform-owner";
import { MarketingPage } from "./marketing-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/use-platform-owner", () => ({ useIsPlatformOwner: vi.fn() }));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseIsPlatformOwner = vi.mocked(useIsPlatformOwner);

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
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: false, loading: false });

    renderPage();

    expect(screen.getByText("Care operations software for home care agencies")).toBeInTheDocument();
    expect(screen.getByText("CareScore matching")).toBeInTheDocument();
    expect(screen.getByText("Service Verification")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Sign in" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Go to platform admin")).not.toBeInTheDocument();
  });

  it("shows a cross-host 'Go to platform admin' link only for a verified platform owner", () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-1" } } as never);
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });

    renderPage();

    const link = screen.getByRole("link", { name: "Go to platform admin" });
    expect(link.getAttribute("href")).toMatch(/^https?:\/\/app\..*\/platform\/organizations$/);
  });

  it("shows 'Go to your organization' (not platform admin) for a signed-in non-platform-owner", () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-2" } } as never);
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: false, loading: false });

    renderPage();

    const link = screen.getByRole("link", { name: "Go to your organization" });
    expect(link.getAttribute("href")).toMatch(/^https?:\/\/app\./);
    expect(screen.queryByText("Go to platform admin")).not.toBeInTheDocument();
  });

  it("links to the pricing page", () => {
    mockedUseAuth.mockReturnValue({ user: null } as never);
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: false, loading: false });

    renderPage();

    const links = screen.getAllByRole("link", { name: "View plans" });
    expect(links[0]).toHaveAttribute("href", "/pricing");
  });

  it("routes the Sign in link to the app host, not this same marketing page", () => {
    mockedUseAuth.mockReturnValue({ user: null } as never);
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: false, loading: false });

    renderPage();

    const links = screen.getAllByRole("link", { name: "Sign in" });
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^https?:\/\/app\..*\/login$/);
    }
  });
});
