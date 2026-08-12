import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { IncidentsPage } from "./incidents-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
    auth: {
      getUser: vi.fn()
    }
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);
const mockedGetUser = vi.mocked(supabase.auth.getUser);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "55555555-5555-4555-8555-555555555555";

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
    userDisplayName: "Test User",
    hasPermission: vi.fn(),
    loading: false
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <IncidentsPage />
    </QueryClientProvider>
  );
}

describe("IncidentsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows an own-reports note and hides the form without any incident permission", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => false) });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    expect(screen.getByText("Showing only incidents you reported.")).toBeInTheDocument();
    expect(screen.queryByText("File an incident")).not.toBeInTheDocument();
  });

  it("lists incidents with severity and status", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "incidents.read")
    });
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          client_id: null,
          client_name: null,
          caregiver_user_id: null,
          caregiver_name: null,
          occurred_at: "2026-07-19T09:00:00.000Z",
          category: "Fall",
          severity: "high",
          status: "open",
          description: "Client had a fall.",
          reported_by: USER_ID,
          reported_by_name: "Sam Caregiver",
          resolution_notes: null,
          resolved_at: null
        }
      ],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Fall")).toBeInTheDocument());
    expect(screen.getByText("high", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("open", { selector: "span" })).toBeInTheDocument();
  });

  it("files a new incident", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "incidents.create")
    });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockedFrom.mockReturnValue({ insert: insertMock } as never);
    mockedGetUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("File an incident")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "Fall" } });
    fireEvent.change(screen.getByLabelText("What happened"), {
      target: { value: "Client had a minor fall while getting up." }
    });
    fireEvent.click(screen.getByRole("button", { name: "File incident" }));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          category: "Fall",
          reported_by: USER_ID
        })
      )
    );
  });

  it("changes an incident's status when the viewer can manage incidents", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn(() => true)
    });
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          client_id: null,
          client_name: null,
          caregiver_user_id: null,
          caregiver_name: null,
          occurred_at: "2026-07-19T09:00:00.000Z",
          category: "Fall",
          severity: "high",
          status: "open",
          description: "Client had a fall.",
          reported_by: USER_ID,
          reported_by_name: "Sam Caregiver",
          resolution_notes: null,
          resolved_at: null
        }
      ],
      error: null
    } as never);
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    mockedFrom.mockReturnValue({ update: updateMock, insert: vi.fn() } as never);

    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue("open")).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue("open"), { target: { value: "resolved" } });

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ status: "resolved" }))
    );
    expect(eqMock).toHaveBeenCalledWith("id", "66666666-6666-4666-8666-666666666666");
  });

  function makeIncidentRow(index: number) {
    // occurred_at strictly decreases with index so the rows arrive in the
    // same occurred_at-desc order the RPC itself returns them in - the
    // (occurred_at, id) keyset cursor depends on that ordering.
    return {
      id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
      client_id: null,
      client_name: null,
      caregiver_user_id: null,
      caregiver_name: null,
      occurred_at: new Date(Date.UTC(2026, 6, 19, 9, 0, 0) - index * 1000).toISOString(),
      category: `Category ${index}`,
      severity: "low" as const,
      status: "open" as const,
      description: "desc",
      reported_by: USER_ID,
      reported_by_name: "Sam Caregiver",
      resolution_notes: null,
      resolved_at: null
    };
  }

  it("offers to load older incidents when a full page comes back, and appends the next page on click", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "incidents.read")
    });
    // First page is a full 200 rows, signaling there may be more - the
    // second page is a single older row.
    const firstPage = Array.from({ length: 200 }, (_, index) => makeIncidentRow(index));
    const secondPage = [makeIncidentRow(200)];
    mockedRpc.mockImplementation((_fn: string, args: Record<string, unknown>) => {
      if (args.before_occurred_at === null) return Promise.resolve({ data: firstPage, error: null }) as never;
      return Promise.resolve({ data: secondPage, error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Category 0")).toBeInTheDocument());
    expect(screen.getByText("Load older incidents")).toBeInTheDocument();
    expect(screen.queryByText("Category 200")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Load older incidents"));

    await waitFor(() => expect(screen.getByText("Category 200")).toBeInTheDocument());
    const lastFirstPageRow = firstPage[199]!;
    expect(mockedRpc).toHaveBeenCalledWith("list_incidents", {
      target_organization_id: ORG_ID,
      result_limit: 200,
      before_occurred_at: lastFirstPageRow.occurred_at,
      before_id: lastFirstPageRow.id
    });
    // Second page has fewer than PAGE_SIZE rows, so there's nothing more.
    expect(screen.queryByText("Load older incidents")).not.toBeInTheDocument();
  });
});
