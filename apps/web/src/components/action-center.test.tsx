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

  it("shows a healthy state when nothing needs attention", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);
    mockedFrom.mockReturnValue({ select: mockClientsCount([]) } as never);

    renderCenter();

    await waitFor(() => expect(screen.getByText("All caught up")).toBeInTheDocument());
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

  it("flags a client scheduled over their authorized hours as critical", async () => {
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
              authorized_hours: 10,
              scheduled_hours: 20,
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
      expect(screen.getByText("Clients scheduled over their authorized hours")).toBeInTheDocument()
    );
    const card = screen.getByText("Clients scheduled over their authorized hours").closest("a");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("Review")).toBeInTheDocument();
  });

  it("only shows signals the current permissions allow", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "shifts.read")
    });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderCenter();

    await waitFor(() => expect(screen.getByText("Shifts today")).toBeInTheDocument());
    expect(screen.queryByText("Active clients with no upcoming visit")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending invitations")).not.toBeInTheDocument();
  });
});
