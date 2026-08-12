import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { supabase } from "@/lib/supabase";
import { MarketingPage } from "./marketing-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn() }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedFrom = vi.mocked(supabase.from);

function mockPlatformRole(role: string | null) {
  mockedFrom.mockReturnValue({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn().mockResolvedValue({ data: { platform_role: role }, error: null })
      }))
    }))
  } as never);
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <MarketingPage />
      </QueryClientProvider>
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
    expect(screen.queryByText("Go to platform admin")).not.toBeInTheDocument();
  });

  it("shows a cross-host 'Go to platform admin' link only for a verified platform owner", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-1" } } as never);
    mockPlatformRole("platform_owner");

    renderPage();

    const link = await screen.findByRole("link", { name: "Go to platform admin" });
    expect(link.getAttribute("href")).toMatch(/^https?:\/\/admin\./);
  });

  it("shows 'Go to your organization' (not platform admin) for a signed-in non-platform-owner", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-2" } } as never);
    mockPlatformRole(null);

    renderPage();

    const link = await screen.findByRole("link", { name: "Go to your organization" });
    expect(link.getAttribute("href")).toMatch(/^https?:\/\/app\./);
    expect(screen.queryByText("Go to platform admin")).not.toBeInTheDocument();
  });

  it("links to the pricing page", () => {
    mockedUseAuth.mockReturnValue({ user: null } as never);

    renderPage();

    const links = screen.getAllByRole("link", { name: "View plans" });
    expect(links[0]).toHaveAttribute("href", "/pricing");
  });
});
