import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { SchedulePage } from "./schedule-page";

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
const CAREGIVER_ID = "44444444-4444-4444-8444-444444444444";

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
    role: "staff" as const,
    isPlatformOwner: false,
    hasPermission: vi.fn(),
    loading: false
  };
}

const sampleShift = {
  id: "33333333-3333-4333-8333-333333333333",
  client_id: CLIENT_ID,
  client_name: "Jordan Rivera",
  caregiver_user_id: CAREGIVER_ID,
  caregiver_name: "Sam Caregiver",
  starts_at: "2026-07-20T09:00:00.000Z",
  ends_at: "2026-07-20T11:00:00.000Z",
  status: "scheduled" as const,
  notes: null
};

function mockRpc({
  shifts = [],
  members = [],
  matches
}: {
  shifts?: unknown[];
  members?: unknown[];
  matches?: unknown[];
}) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "list_shifts") return Promise.resolve({ data: shifts, error: null }) as never;
    if (fn === "list_organization_members") return Promise.resolve({ data: members, error: null }) as never;
    if (fn === "list_caregiver_matches") return Promise.resolve({ data: matches ?? [], error: null }) as never;
    return Promise.resolve({ data: [], error: null }) as never;
  });
}

function mockReadableClients(rows: unknown[]) {
  const orderMock = vi.fn().mockResolvedValue({ data: rows, error: null });
  const eqMock = vi.fn(() => ({ order: orderMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  return selectMock;
}

function renderPage(initialEntries: string[] = ["/schedule"]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={queryClient}>
        <SchedulePage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("SchedulePage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows shifts even without shifts.read (own-shift visibility), and hides the scheduling form", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => false) });
    mockRpc({ shifts: [sampleShift] });

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    expect(screen.getByText("Showing only shifts assigned to you.")).toBeInTheDocument();
    expect(screen.queryByText("Schedule a shift")).not.toBeInTheDocument();
    expect(mockedRpc).toHaveBeenCalledWith("list_shifts", { target_organization_id: ORG_ID });
  });

  it("shows the scheduling form and creates a shift when shifts.update is held", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      shifts: [],
      members: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", status: "active" }],
      matches: [{ caregiver_user_id: CAREGIVER_ID, caregiver_name: "Sam Caregiver", match_score: 82 }]
    });
    const selectMock = mockReadableClients([{ id: CLIENT_ID, first_name: "Jordan", last_name: "Rivera" }]);
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockedFrom.mockReturnValue({ select: selectMock, insert: insertMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Schedule a shift")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Client"), { target: { value: CLIENT_ID } });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Sam Caregiver — CareScore 82" })).toBeInTheDocument()
    );
    fireEvent.change(screen.getByLabelText("Caregiver"), { target: { value: CAREGIVER_ID } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule shift" }));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          client_id: CLIENT_ID,
          caregiver_user_id: CAREGIVER_ID
        })
      )
    );
  });

  it("ranks caregivers by CareScore once a client is selected", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      shifts: [],
      members: [
        { user_id: CAREGIVER_ID, display_name: "Sam Caregiver", status: "active" },
        { user_id: "55555555-5555-4555-8555-555555555555", display_name: "Alex Aide", status: "active" }
      ],
      matches: [
        { caregiver_user_id: CAREGIVER_ID, caregiver_name: "Sam Caregiver", match_score: 91 },
        { caregiver_user_id: "55555555-5555-4555-8555-555555555555", caregiver_name: "Alex Aide", match_score: 40 }
      ]
    });
    const selectMock = mockReadableClients([{ id: CLIENT_ID, first_name: "Jordan", last_name: "Rivera" }]);
    mockedFrom.mockReturnValue({ select: selectMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    expect(screen.getByRole("option", { name: "Select a caregiver" })).toBeInTheDocument();
    expect(screen.queryByText("Ranked by CareScore, best match first.")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Client"), { target: { value: CLIENT_ID } });

    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Sam Caregiver — CareScore 91" })).toBeInTheDocument()
    );
    expect(screen.getByRole("option", { name: "Alex Aide — CareScore 40" })).toBeInTheDocument();
    expect(screen.getByText("Ranked by CareScore, best match first.")).toBeInTheDocument();
    expect(mockedRpc).toHaveBeenCalledWith("list_caregiver_matches", {
      target_organization_id: ORG_ID,
      target_client_id: CLIENT_ID
    });
  });

  it("preselects the client and ranks caregivers when arriving with ?clientId=", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      shifts: [],
      members: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", status: "active" }],
      matches: [{ caregiver_user_id: CAREGIVER_ID, caregiver_name: "Sam Caregiver", match_score: 77 }]
    });
    const selectMock = mockReadableClients([{ id: CLIENT_ID, first_name: "Jordan", last_name: "Rivera" }]);
    mockedFrom.mockReturnValue({ select: selectMock } as never);

    renderPage([`/schedule?clientId=${CLIENT_ID}`]);

    await waitFor(() => expect(screen.getByLabelText("Client")).toHaveValue(CLIENT_ID));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Sam Caregiver — CareScore 77" })).toBeInTheDocument()
    );
    expect(mockedRpc).toHaveBeenCalledWith("list_caregiver_matches", {
      target_organization_id: ORG_ID,
      target_client_id: CLIENT_ID
    });
  });

  it("changes a shift's status when shifts.update is held", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({ shifts: [sampleShift], members: [] });
    const selectMock = mockReadableClients([]);
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    mockedFrom.mockReturnValue({ select: selectMock, update: updateMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue("scheduled"), { target: { value: "completed" } });

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ status: "completed" }));
    expect(eqMock).toHaveBeenCalledWith("id", sampleShift.id);
  });

  it("shows an empty state when there are no shifts", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({ shifts: [], members: [] });
    mockedFrom.mockReturnValue({ select: mockReadableClients([]) } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("No shifts scheduled.")).toBeInTheDocument());
  });
});
