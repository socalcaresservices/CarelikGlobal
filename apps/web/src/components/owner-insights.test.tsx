import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { OwnerInsights } from "./owner-insights";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function baseOrganization(role: "organization_owner" | "organization_admin" | "platform_owner") {
  return {
    organizations: [],
    activeOrganization: {
      id: ORG_ID,
      slug: "acme",
      legalName: "Acme LLC",
      displayName: "Acme",
      status: "active" as const,
      timezone: "America/Los_Angeles"
    },
    activeOrganizationId: ORG_ID,
    setActiveOrganizationId: vi.fn(),
    role,
    isPlatformOwner: role === "platform_owner",
    hasRealOrganizationAccess: true,
    hasPermission: vi.fn(() => true),
    loading: false
  };
}

function mockRpc({
  members = [],
  credentials = [],
  authorizations = [],
  incidents = [],
  audit = [],
  applicants = [],
  shifts = []
}: {
  members?: unknown[];
  credentials?: unknown[];
  authorizations?: unknown[];
  incidents?: unknown[];
  audit?: unknown[];
  applicants?: unknown[];
  shifts?: unknown[];
}) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "list_organization_members") return Promise.resolve({ data: members, error: null }) as never;
    if (fn === "list_caregiver_credentials") return Promise.resolve({ data: credentials, error: null }) as never;
    if (fn === "list_client_authorizations") return Promise.resolve({ data: authorizations, error: null }) as never;
    if (fn === "list_incidents") return Promise.resolve({ data: incidents, error: null }) as never;
    if (fn === "list_audit_logs") return Promise.resolve({ data: audit, error: null }) as never;
    if (fn === "list_applicants") return Promise.resolve({ data: applicants, error: null }) as never;
    if (fn === "list_shifts") return Promise.resolve({ data: shifts, error: null }) as never;
    return Promise.resolve({ data: [], error: null }) as never;
  });
}

function renderComponent() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OwnerInsights />
    </QueryClientProvider>
  );
}

describe("OwnerInsights", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing for a non-owner role", () => {
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_admin"));
    mockRpc({});

    const { container } = renderComponent();
    expect(container).toBeEmptyDOMElement();
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("shows breakdown counts and a coverage chart for an organization_owner", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));
    mockRpc({
      members: [
        { role: "caregiver", status: "active" },
        { role: "caregiver", status: "active" },
        { role: "staff", status: "invited" }
      ],
      credentials: [{ expires_at: null }, { expires_at: "2020-01-01" }],
      authorizations: [
        {
          max_monthly_hours: 20,
          hours_used_this_month: 25,
          hours_scheduled_this_month: 0,
          period_end: "2099-01-01"
        }
      ],
      incidents: [{ severity: "high", status: "open", occurred_at: new Date().toISOString() }],
      audit: [{ occurred_at: new Date().toISOString() }],
      applicants: [{ status: "new" }, { status: "new" }, { status: "hired" }],
      shifts: [
        { status: "scheduled", needs_coverage: true },
        { status: "scheduled", needs_coverage: false },
        { status: "completed", needs_coverage: false }
      ]
    });

    renderComponent();

    await waitFor(() => expect(screen.getByText("caregiver")).toBeInTheDocument());

    const teamByRoleCard = screen.getByText("Team by role").closest("div")!;
    expect(within(teamByRoleCard).getByText("caregiver")).toBeInTheDocument();
    expect(within(teamByRoleCard).getByText("2")).toBeInTheDocument();

    const complianceCard = screen.getByText("Credential compliance").closest("div")!;
    expect(within(complianceCard).getByText("No expiration")).toBeInTheDocument();
    expect(within(complianceCard).getByText("Expired")).toBeInTheDocument();

    const usageCard = screen.getByText("Authorizations by usage").closest("div")!;
    expect(within(usageCard).getByText("Over limit")).toBeInTheDocument();

    const incidentStatusCard = screen.getByText("Incidents by status").closest("div")!;
    expect(within(incidentStatusCard).getByText("Open")).toBeInTheDocument();

    const incidentSeverityCard = screen.getByText("Incidents by severity").closest("div")!;
    expect(within(incidentSeverityCard).getByText("high")).toBeInTheDocument();

    const activityCard = screen.getByText("Recent activity").closest("div")!;
    expect(within(activityCard).getByText("1")).toBeInTheDocument();

    const applicantsCard = screen.getByText("Applicants by status").closest("div")!;
    expect(within(applicantsCard).getByText("New")).toBeInTheDocument();
    expect(within(applicantsCard).getByText("2")).toBeInTheDocument();
    expect(within(applicantsCard).getByText("Hired")).toBeInTheDocument();

    // Coverage-this-week chart: one scheduled shift still needs coverage.
    await waitFor(() => expect(screen.getByText("1 shift needs coverage right now.")).toBeInTheDocument());
    expect(screen.getByRole("img", { name: "Shifts this week by outcome" })).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Monthly authorized hours: used, scheduled, and remaining" })
      ).toBeInTheDocument()
    );
    expect(screen.getByText("Used")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByText("Remaining")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team composition by role" })).toBeInTheDocument();
  });

  it("shows an all-clear message on the coverage chart when nothing needs coverage", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));
    mockRpc({
      members: [{ role: "staff", status: "active" }],
      shifts: [{ status: "scheduled", needs_coverage: false }]
    });

    renderComponent();

    await waitFor(() =>
      expect(screen.getByText("Every shift this week has a caregiver.")).toBeInTheDocument()
    );
  });

  it("shows an empty state for monthly capacity when there are no authorizations", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));
    mockRpc({ members: [{ role: "staff", status: "active" }] });

    renderComponent();

    await waitFor(() => expect(screen.getByText("Monthly capacity")).toBeInTheDocument());
    const capacityCard = screen.getByText("Monthly capacity").closest("div")!;
    await waitFor(() => expect(within(capacityCard).getByText("No authorizations tracked yet.")).toBeInTheDocument());
    expect(
      within(capacityCard).queryByRole("img", { name: "Monthly authorized hours: used, scheduled, and remaining" })
    ).not.toBeInTheDocument();
  });

  it("shows an error message when a section's fetch fails, instead of a false empty state", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization("organization_owner"));
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") return Promise.resolve({ data: [], error: null }) as never;
      if (fn === "list_incidents") return Promise.resolve({ data: null, error: new Error("network error") }) as never;
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderComponent();

    await waitFor(() => expect(screen.getByText("Team by role")).toBeInTheDocument());
    const incidentStatusCard = screen.getByText("Incidents by status").closest("div")!;
    await waitFor(() => expect(within(incidentStatusCard).getByText("Could not load incidents.")).toBeInTheDocument());
    expect(within(incidentStatusCard).queryByText("No incidents reported.")).not.toBeInTheDocument();
  });

  it("allows a platform_owner to view the insights", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization("platform_owner"));
    mockRpc({ members: [{ role: "staff", status: "active" }] });

    renderComponent();

    await waitFor(() => expect(screen.getByText("Team by role")).toBeInTheDocument());
  });

  it("skips a section when the caller lacks that section's read permission", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization("organization_owner"),
      hasPermission: vi.fn((permission: string) => permission !== "incidents.read")
    });
    mockRpc({ members: [{ role: "staff", status: "active" }] });

    renderComponent();

    await waitFor(() => expect(screen.getByText("Team by role")).toBeInTheDocument());
    expect(screen.queryByText("Incidents by status")).not.toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalledWith("list_incidents", expect.anything());
  });
});
