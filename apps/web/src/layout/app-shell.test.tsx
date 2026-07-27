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

  it("shows the Workforce Insights link for an organization_owner", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.getByText("Workforce Insights")).toBeInTheDocument();
  });

  it("hides the Workforce Insights link for an organization_admin", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "admin@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_admin"));

    renderShell();
    expect(screen.queryByText("Workforce Insights")).not.toBeInTheDocument();
  });

  it("groups Organizations, Access, and Audit under a de-emphasized Administration heading", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.getByText("Administration")).toBeInTheDocument();
    expect(screen.getByText("Command Center")).toBeInTheDocument();
  });

  it("does not show engineering-phase copy in the header", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.queryByText(/Phase 1/)).not.toBeInTheDocument();
  });

  it("shows Applicants for someone with applicants.read", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.getByText("Applicants")).toBeInTheDocument();
  });

  it("hides Applicants without applicants.read", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "coordinator@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_admin"),
      hasPermission: vi.fn((permission: string) => permission !== "applicants.read")
    });

    renderShell();
    expect(screen.queryByText("Applicants")).not.toBeInTheDocument();
  });

  it("shows a separate Platform Administration heading for a platform owner, with Organizations listed once", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@carelik.test" } } as never);
    mockedUseOrganization.mockReturnValue({ ...baseOrganization("organization_owner"), isPlatformOwner: true });

    renderShell();
    expect(screen.getByText("Platform Administration")).toBeInTheDocument();
    expect(screen.getAllByText("Organizations")).toHaveLength(1);
  });

  it("hides the Platform Administration heading for a non-platform-owner", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.queryByText("Platform Administration")).not.toBeInTheDocument();
    expect(screen.getAllByText("Organizations")).toHaveLength(1);
  });
});
