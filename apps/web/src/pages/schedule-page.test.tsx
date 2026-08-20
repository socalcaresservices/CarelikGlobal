import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const AUTHORIZATION_ID = "55555555-5555-4555-8555-555555555555";
const SERVICE_ID = "66666666-6666-4666-8666-666666666666";

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

function mockSchedulingTables(
  clients: unknown[],
  workforce: unknown[],
  insert = vi.fn().mockResolvedValue({ error: null }),
  authorizations: unknown[] = [{
    id: AUTHORIZATION_ID,
    service_id: SERVICE_ID,
    period_start: "2026-01-01",
    period_end: "2026-12-31",
    services: { code: "PCS", name: "Personal Care" }
  }]
) {
  mockedFrom.mockImplementation((table: string) => {
    if (table === "clients") return { select: mockReadableClients(clients) } as never;
    if (table === "caregiver_records") {
      const order = vi.fn().mockResolvedValue({ data: workforce, error: null });
      const is = vi.fn(() => ({ order }));
      const inStatus = vi.fn(() => ({ is }));
      const eq = vi.fn(() => ({ in: inStatus }));
      return { select: vi.fn(() => ({ eq })) } as never;
    }
    if (table === "client_authorizations") {
      const order = vi.fn().mockResolvedValue({ data: authorizations, error: null });
      const isDeleted = vi.fn(() => ({ order }));
      const eqClient = vi.fn(() => ({ is: isDeleted }));
      const eqOrganization = vi.fn(() => ({ eq: eqClient }));
      return { select: vi.fn(() => ({ eq: eqOrganization })) } as never;
    }
    if (table === "shifts") return { insert } as never;
    return {} as never;
  });
  return insert;
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
    expect(mockedRpc).toHaveBeenCalledWith(
      "list_shifts",
      expect.objectContaining({
        target_organization_id: ORG_ID,
        from_time: expect.any(String),
        to_time: expect.any(String)
      })
    );
  });

  it("shows a Needs coverage card for shifts whose caregiver called out", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      shifts: [
        sampleShift,
        {
          ...sampleShift,
          id: "called-out-shift",
          needs_coverage: true,
          call_out_reason: "Family emergency"
        }
      ]
    });
    mockSchedulingTables([], []);

    renderPage();

    await waitFor(() => expect(screen.getByText("Needs coverage")).toBeInTheDocument());
    const coverageCard = screen.getByText("Needs coverage").closest("div")!;
    expect(within(coverageCard).getByText("Reason: Family emergency")).toBeInTheDocument();
  });

  it("bounds the shift fetch to a rolling window around today, not every shift ever", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({ shifts: [], members: [] });
    mockSchedulingTables([], []);

    const before = Date.now();
    renderPage();
    await waitFor(() => expect(screen.getByText("No shifts scheduled.")).toBeInTheDocument());
    const after = Date.now();

    const call = mockedRpc.mock.calls.find(([fn]) => fn === "list_shifts")!;
    const args = call[1] as { from_time: string; to_time: string };
    const from = new Date(args.from_time).getTime();
    const to = new Date(args.to_time).getTime();
    const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;

    // from_time is ~60 days before "now" and to_time is ~60 days after -
    // allow slack either side of the test's own render time rather than
    // asserting an exact instant.
    expect(before - from).toBeGreaterThan(sixtyDaysMs - 5000);
    expect(after - from).toBeLessThan(sixtyDaysMs + 5000);
    expect(to - before).toBeGreaterThan(sixtyDaysMs - 5000);
    expect(to - after).toBeLessThan(sixtyDaysMs + 5000);
  });

  it("shows the scheduling form and creates a shift when shifts.update is held", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      shifts: [],
      members: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", status: "active" }],
      matches: [{ caregiver_user_id: CAREGIVER_ID, caregiver_name: "Sam Caregiver", match_score: 82 }]
    });
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockSchedulingTables([{ id: CLIENT_ID, first_name: "Jordan", last_name: "Rivera" }], [{ id: CAREGIVER_ID, linked_user_id: null, first_name: "Sam", last_name: "Caregiver", preferred_name: null }], insertMock);

    renderPage();
    await waitFor(() => expect(screen.getByText("Schedule a shift")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Client"), { target: { value: CLIENT_ID } });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /PCS — Personal Care/ })).toBeInTheDocument()
    );
    fireEvent.change(screen.getByLabelText("Authorized service"), { target: { value: AUTHORIZATION_ID } });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Sam Caregiver (no login)" })).toBeInTheDocument()
    );
    fireEvent.change(screen.getByLabelText("Caregiver"), { target: { value: CAREGIVER_ID } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule shift" }));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          client_id: CLIENT_ID,
          caregiver_record_id: CAREGIVER_ID,
          caregiver_user_id: null,
          service_id: SERVICE_ID
        })
      )
    );
  });

  it("lists Care Team records including caregivers without logins", async () => {
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
    mockSchedulingTables([{ id: CLIENT_ID, first_name: "Jordan", last_name: "Rivera" }], [
      { id: CAREGIVER_ID, linked_user_id: null, first_name: "Sam", last_name: "Caregiver", preferred_name: null },
      { id: "55555555-5555-4555-8555-555555555555", linked_user_id: "user-2", first_name: "Alex", last_name: "Aide", preferred_name: null }
    ]);

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    expect(screen.getByRole("option", { name: "Select a caregiver" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Sam Caregiver (no login)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Alex Aide" })).toBeInTheDocument();
    expect(screen.getByText("Care Team records can be scheduled before a login is linked.")).toBeInTheDocument();
  });

  it("preselects the client and loads Care Team when arriving with ?clientId=", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      shifts: [],
      members: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", status: "active" }],
      matches: [{ caregiver_user_id: CAREGIVER_ID, caregiver_name: "Sam Caregiver", match_score: 77 }]
    });
    mockSchedulingTables([{ id: CLIENT_ID, first_name: "Jordan", last_name: "Rivera" }], [
      { id: CAREGIVER_ID, linked_user_id: null, first_name: "Sam", last_name: "Caregiver", preferred_name: null }
    ]);

    renderPage([`/schedule?clientId=${CLIENT_ID}`]);

    await waitFor(() => expect(screen.getByLabelText("Client")).toHaveValue(CLIENT_ID));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Sam Caregiver (no login)" })).toBeInTheDocument()
    );
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
