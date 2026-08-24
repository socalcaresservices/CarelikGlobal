import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ActionCenter } from "./action-center";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";

function baseOrganization() {
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
    role: "organization_admin" as const,
    isPlatformOwner: false,
    hasRealOrganizationAccess: true,
    hasPermission: vi.fn(() => true),
    loading: false
  };
}

function mockClientsCount(rows: unknown[]) {
  const eqStatusMock = vi.fn().mockResolvedValue({ data: rows, error: null });
  const eqOrgMock = vi.fn(() => ({ eq: eqStatusMock }));
  const selectMock = vi.fn(() => ({ eq: eqOrgMock }));
  return selectMock;
}

function renderCenter() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ActionCenter />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("ActionCenter", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("flags a shift that ended without a status update", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    // 47-48 hours ago, safely outside "today" so this shift only counts
    // toward the overdue signal, not the today signal - keeps the
    // assertion below unambiguous.
    const fortySevenHoursAgo = new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString();
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_shifts") {
        return Promise.resolve({
          data: [
            {
              id: "shift-1",
              client_id: CLIENT_ID,
              starts_at: fortyEightHoursAgo,
              ends_at: fortySevenHoursAgo,
              status: "scheduled"
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() => expect(screen.getByText("Review", { selector: "span" })).toBeInTheDocument());
    const card = screen.getByText("Shifts needing a status update").closest("a");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  it("shows a compact healthy state when nothing needs attention, not a grid of zero cards", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() =>
      expect(screen.getByText(/All caught up/)).toBeInTheDocument()
    );
    // None of the individual signal labels should render as cards once
    // everything is healthy - only the one compact banner.
    expect(screen.queryByText("Shifts needing a status update")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending invitations")).not.toBeInTheDocument();
  });

  it("shows an error banner instead of a false 'All caught up' when a signal's fetch fails", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_incidents") return Promise.resolve({ data: null, error: new Error("network error") }) as never;
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() =>
      expect(screen.getByText("Could not load all signals — this list may be incomplete.")).toBeInTheDocument()
    );
    expect(screen.queryByText(/All caught up/)).not.toBeInTheDocument();
  });

  it("flags a caregiver over their weekly hour target as critical", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "get_caregiver_hours") {
        return Promise.resolve({
          data: [
            {
              caregiver_user_id: "caregiver-1",
              caregiver_name: "Sam Caregiver",
              target_hours_per_week: 20,
              scheduled_hours: 25
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() => expect(screen.getByText("Caregivers over their weekly hour target")).toBeInTheDocument());
    const card = screen.getByText("Caregivers over their weekly hour target").closest("a");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("Review")).toBeInTheDocument();
  });

  it("flags an expired credential as critical", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_caregiver_credentials") {
        return Promise.resolve({
          data: [{ id: "credential-1", expires_at: "2020-01-01" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() => expect(screen.getByText("Credentials expiring or expired")).toBeInTheDocument());
    const card = screen.getByText("Credentials expiring or expired").closest("a");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("Review")).toBeInTheDocument();
  });

  it("flags a client over their monthly authorized hours as critical", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const now = new Date();
    const periodStart = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const periodEnd = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_client_authorizations") {
        return Promise.resolve({
          data: [
            {
              id: "authorization-1",
              max_monthly_hours: 10,
              hours_used_this_month: 12,
              hours_scheduled_this_month: 8,
              period_start: periodStart,
              period_end: periodEnd
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() =>
      expect(screen.getByText("Clients over their monthly authorized hours")).toBeInTheDocument()
    );
    const card = screen.getByText("Clients over their monthly authorized hours").closest("a");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("Review")).toBeInTheDocument();
  });

  it("flags an authorization expiring soon separately from over-authorized usage", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const tenDaysFromNow = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_client_authorizations") {
        return Promise.resolve({
          data: [
            {
              id: "authorization-1",
              max_monthly_hours: 20,
              // Well under the cap, so this row must not also trip the
              // separate over-authorized signal - isolates the assertion
              // to the expiry signal only.
              hours_used_this_month: 0,
              hours_scheduled_this_month: 0,
              period_start: tenDaysAgo,
              period_end: tenDaysFromNow
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() => expect(screen.getByText("Authorizations expiring or expired")).toBeInTheDocument());
    const card = screen.getByText("Authorizations expiring or expired").closest("a");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(screen.queryByText("Clients over their monthly authorized hours")).not.toBeInTheDocument();
  });

  it("flags an open incident as critical", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_incidents") {
        return Promise.resolve({
          data: [{ id: "incident-1", status: "open" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() => expect(screen.getByText("Incidents awaiting review")).toBeInTheDocument());
    const card = screen.getByText("Incidents awaiting review").closest("a");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("Review")).toBeInTheDocument();
  });

  it("flags an unsigned visit", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_service_visits") {
        return Promise.resolve({
          data: [{ id: "visit-1", status: "awaiting_signature" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() => expect(screen.getByText("Visits awaiting signature")).toBeInTheDocument());
    const card = screen.getByText("Visits awaiting signature").closest("a");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("Review")).toBeInTheDocument();
  });

  it("flags a candidate not yet in a terminal pipeline stage", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_candidates_v1") {
        return Promise.resolve({
          data: [
            { id: "candidate-1", pipeline_stage: "interviewing" },
            { id: "candidate-2", pipeline_stage: "rejected" }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() => expect(screen.getByText("Candidates awaiting action")).toBeInTheDocument());
    const card = screen.getByText("Candidates awaiting action").closest("a");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  it("flags a document request awaiting review", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_document_requests_awaiting_review") {
        return Promise.resolve({
          data: [{ id: "request-1" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() => expect(screen.getByText("Document requests awaiting review")).toBeInTheDocument());
    const card = screen.getByText("Document requests awaiting review").closest("a");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  it("only shows signals the current permissions allow", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "shifts.read")
    });
    // At least one signal needs to be unhealthy, otherwise the component
    // renders the compact "All caught up" banner instead of any signal
    // labels - give it an overdue shift so the grid actually renders and
    // we can assert on which labels appear in it.
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const fortySevenHoursAgo = new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString();
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_shifts") {
        return Promise.resolve({
          data: [
            {
              id: "shift-1",
              client_id: CLIENT_ID,
              starts_at: fortyEightHoursAgo,
              ends_at: fortySevenHoursAgo,
              status: "scheduled"
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderCenter();

    await waitFor(() => expect(screen.getByText("Shifts needing a status update")).toBeInTheDocument());
    expect(screen.queryByText("Active clients with no upcoming visit")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending invitations")).not.toBeInTheDocument();
  });
});
