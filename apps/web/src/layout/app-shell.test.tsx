import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { AppShell } from "./app-shell";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/components/global-search", () => ({ GlobalSearch: () => null }));
// ContextBar gets its own dedicated test file (context-bar.test.tsx) -
// stubbed here so the nav-focused tests below aren't also asserting on
// (or getting tripped up by) its supabase.rpc("get_agency_dashboard")
// call.
vi.mock("@/components/context-bar", () => ({ ContextBar: () => null }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

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

function brandedOrganization(overrides: Record<string, unknown> = {}) {
  return {
    id: ORG_ID,
    slug: "acme",
    legalName: "Acme Care LLC",
    displayName: "Acme Care",
    status: "active" as const,
    timezone: "America/Los_Angeles",
    logoUrl: null,
    primaryColor: null,
    secondaryColor: null,
    accentColor: null,
    themeMode: "light" as const,
    showPoweredBy: true,
    ...overrides
  };
}

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AppShell>
          <div />
        </AppShell>
      </QueryClientProvider>
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

  it("shows a badge with the actionable count next to Credentials and Incidents", async () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_owner"),
      activeOrganizationId: ORG_ID
    });
    mockedRpc.mockResolvedValue({
      data: [
        {
          clients_uncovered: 0,
          schedule_issues: 0,
          access_pending: 0,
          credentials_issues: 4,
          authorizations_issues: 0,
          incidents_open: 2
        }
      ],
      error: null
    } as never);

    renderShell();

    await waitFor(() => expect(mockedRpc).toHaveBeenCalledWith("get_actionable_counts", { target_organization_id: ORG_ID }));
    const credentialsLink = (await screen.findByText("Credentials")).closest("a")!;
    expect(within(credentialsLink).getByText("4")).toBeInTheDocument();
    const incidentsLink = screen.getByText("Incidents").closest("a")!;
    expect(within(incidentsLink).getByText("2")).toBeInTheDocument();
    // A zero count renders no badge at all, not a "0" pill.
    const clientsLink = screen.getByText("Clients").closest("a")!;
    expect(within(clientsLink).queryByText("0")).not.toBeInTheDocument();
  });

  it("shows no badge when every actionable count is zero", async () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_owner"),
      activeOrganizationId: ORG_ID
    });
    mockedRpc.mockResolvedValue({
      data: [
        {
          clients_uncovered: 0,
          schedule_issues: 0,
          access_pending: 0,
          credentials_issues: 0,
          authorizations_issues: 0,
          incidents_open: 0
        }
      ],
      error: null
    } as never);

    renderShell();

    await waitFor(() => expect(mockedRpc).toHaveBeenCalled());
    const credentialsLink = (await screen.findByText("Credentials")).closest("a")!;
    expect(within(credentialsLink).queryByText("0")).not.toBeInTheDocument();
  });

  it("falls back to the CareLik Global mark and 'Powered by CareLik' footer without an active organization", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();

    expect(screen.getByText("CareLik Global")).toBeInTheDocument();
    expect(screen.getByText("Powered by CareLik")).toBeInTheDocument();
  });

  it("shows the organization's logo instead of the CareLik mark when branded", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_owner"),
      activeOrganization: brandedOrganization({ logoUrl: "https://example.com/acme-logo.png" })
    });

    renderShell();

    const logo = screen.getByAltText("Acme Care");
    expect(logo).toHaveAttribute("src", "https://example.com/acme-logo.png");
    expect(screen.queryByText("CareLik Global")).not.toBeInTheDocument();
  });

  it("shows the organization's display name (not CareLik Global) when active but unbranded", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_owner"),
      activeOrganization: brandedOrganization()
    });

    renderShell();

    expect(screen.getByText("Acme Care")).toBeInTheDocument();
    expect(screen.queryByText("CareLik Global")).not.toBeInTheDocument();
  });

  it("sets --color-accent from the organization's primary color, which every branded surface reads", () => {
    // NavLinkItem's active state (and every packages/ui Button primary
    // variant rendered inside the shell) reads var(--color-accent) rather
    // than getting its own inline backgroundColor - this only needs to
    // confirm AppShell sets the custom property at its root and that the
    // active link's className is wired to consume it, not recompute the
    // resolved color (jsdom doesn't load the compiled Tailwind stylesheet,
    // so getComputedStyle can't resolve var(...) here).
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_owner"),
      activeOrganization: brandedOrganization({ primaryColor: "#123456" })
    });

    const { container } = renderShell();

    expect(container.firstChild).toHaveStyle({
      "--color-accent": "#123456",
      "--color-accent-foreground": "#ffffff"
    });
    const commandCenterLink = screen.getByText("Command Center").closest("a")!;
    expect(commandCenterLink.className).toContain("bg-[var(--color-accent,#0f172a)]");
  });

  it("falls back to the default palette when the organization hasn't set a primary color", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_owner"),
      activeOrganization: brandedOrganization({ primaryColor: null })
    });

    const { container } = renderShell();

    expect(container.firstChild).not.toHaveStyle({ "--color-accent": expect.anything() });
  });

  it("hides the 'Powered by CareLik' footer when the organization has turned it off", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_owner"),
      activeOrganization: brandedOrganization({ showPoweredBy: false })
    });

    renderShell();

    expect(screen.queryByText("Powered by CareLik")).not.toBeInTheDocument();
  });
});
