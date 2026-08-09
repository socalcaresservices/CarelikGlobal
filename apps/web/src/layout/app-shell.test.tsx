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

  it("groups Applicants, Clients, and Team under a People heading", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.getByText("People")).toBeInTheDocument();
    expect(screen.getByText("Applicants")).toBeInTheDocument();
    expect(screen.getByText("Clients")).toBeInTheDocument();
    expect(screen.getByText("Team")).toBeInTheDocument();
  });

  it("groups Credentials, Authorizations, and Incidents under a Compliance heading", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.getByText("Compliance")).toBeInTheDocument();
    expect(screen.getByText("Credentials")).toBeInTheDocument();
    expect(screen.getByText("Authorizations")).toBeInTheDocument();
    expect(screen.getByText("Incidents")).toBeInTheDocument();
  });

  it("keeps Command Center, Workforce Insights, and Schedule ungrouped at the top of the sidebar", () => {
    // These three are the "check every day" screens - they intentionally
    // sit above the first section heading rather than under an "Overview"
    // label, the same way they did before the People/Compliance split.
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.queryByText("Overview")).not.toBeInTheDocument();
    expect(screen.getByText("Command Center")).toBeInTheDocument();
    expect(screen.getByText("Workforce Insights")).toBeInTheDocument();
    expect(screen.getByText("Schedule")).toBeInTheDocument();
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

  it("always shows Service Verification, but gates Visit Reports on visits.read", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "caregiver@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_admin"),
      hasPermission: vi.fn((permission: string) => permission !== "visits.read")
    });

    renderShell();
    expect(screen.getByText("Service Verification")).toBeInTheDocument();
    expect(screen.queryByText("Visit Reports")).not.toBeInTheDocument();
  });

  it("shows Visit Reports for someone with visits.read", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.getByText("Visit Reports")).toBeInTheDocument();
  });

  // The tenant workspace never shows platform administration nav, even
  // for a user who happens to also be a platform owner and a real
  // member of this organization (its creator, in practice) - platform
  // tools live exclusively on platform.carelik.com's PlatformShell.
  // Which host you're on decides whether you see them, not who you are.
  it("shows no Platform Administration nav for a platform owner viewing a tenant workspace", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@carelik.test" } } as never);
    mockedUseOrganization.mockReturnValue({ ...baseOrganization("organization_owner"), isPlatformOwner: true });

    renderShell();
    expect(screen.queryByText("Platform Administration")).not.toBeInTheDocument();
    expect(screen.queryByText("Organizations")).not.toBeInTheDocument();
    expect(screen.queryByText("Feature Flags")).not.toBeInTheDocument();
  });

  it("shows no Platform Administration nav for a non-platform-owner either", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));

    renderShell();
    expect(screen.queryByText("Platform Administration")).not.toBeInTheDocument();
    expect(screen.queryByText("Organizations")).not.toBeInTheDocument();
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

    // Appears twice: the sidebar header (in place of a logo) and the
    // top header (in place of the removed organization switcher - see
    // the "Build 022: Organization switcher hidden" comment in
    // app-shell.tsx).
    expect(screen.getAllByText("Acme Care")).toHaveLength(2);
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

  // There is no organization switcher in the tenant workspace by design
  // (Build 022: a user is scoped to one tenant via subdomain - see the
  // "Build 022: Organization switcher hidden in tenant context" comment
  // in app-shell.tsx) - the header shows the active organization's name
  // as plain text instead, already covered by the display-name and
  // logo tests above.
  it("shows no organization switcher, even with more than one organization in context", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "owner@acme.test" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_owner"),
      organizations: [brandedOrganization(), brandedOrganization({ id: "22222222-2222-4222-8222-222222222222", displayName: "Second Org" })],
      activeOrganization: brandedOrganization(),
      activeOrganizationId: ORG_ID
    });

    renderShell();

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Second Org")).not.toBeInTheDocument();
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
