import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ServiceVerificationBackendContext, type ServiceVerificationBackend } from "@/lib/sv-backend";
import { ServiceVerificationReportsPage } from "./service-verification-reports-page";
import { formatClockTime, formatVisitDate, toPacificWallTime } from "@/lib/service-verification";

vi.mock("@/providers/organization-provider", () => ({
  useOrganization: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

const visitRow = {
  id: "22222222-2222-4222-8222-222222222222",
  visit_number: "SCS-V-20260801-4F7K",
  client_id: "33333333-3333-4333-8333-333333333333",
  client_code: "CL-ABC123",
  client_legal_name: "Jamie Smith",
  caregiver_user_id: "44444444-4444-4444-8444-444444444444",
  caregiver_name: "Jordan Rivera",
  service_id: "55555555-5555-4555-8555-555555555555",
  service_name: "Personal Care",
  service_date: "2026-08-01",
  time_in: "2026-08-01T13:00:00.000Z",
  time_out: "2026-08-01T14:00:00.000Z",
  worked_minutes: 60,
  verified_minutes: 60,
  billable_minutes: 60,
  status: "signed" as const,
  authorization_status: "within_authorization",
  signed_at: "2026-08-01T14:05:00.000Z",
  original_visit_id: null,
  is_corrected: false,
  month_to_date_before_minutes: 600,
  month_to_date_after_minutes: 660,
  remaining_minutes: 1740,
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ServiceVerificationReportsPage />
    </QueryClientProvider>,
  );
}

async function openReport(name: RegExp) {
  const option = await screen.findByRole("option", { name });
  fireEvent.change(screen.getByLabelText("Report"), {
    target: { value: option.getAttribute("value") },
  });
}

function mockOrgLetterhead() {
  mockedFrom.mockImplementation((table: string) => {
    if (table === "clients") {
      const is = vi.fn().mockResolvedValue({
        data: [
          {
            id: visitRow.client_id,
            address_city: "Anaheim",
            address_state: "CA",
          },
        ],
        error: null,
      });
      const eq = vi.fn(() => ({ is }));
      return { select: vi.fn(() => ({ eq })) } as never;
    }
    const single = vi.fn().mockResolvedValue({
      data: {
        legal_name: "Acme Care LLC",
        display_name: "Acme Care",
        logo_url: null,
      },
      error: null,
    });
    const eq = vi.fn(() => ({ single }));
    return { select: vi.fn(() => ({ eq })) } as never;
  });
}

describe("ServiceVerificationReportsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
  });

  it("shows a not-available message without visits.read", () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => false),
    } as never);

    renderPage();

    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("shows each visit's scheduled shift next to the actual times, or that it has none", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({
      data: [
        {
          ...visitRow,
          scheduled_starts_at: "2026-08-01T12:30:00.000Z",
          scheduled_ends_at: "2026-08-01T14:30:00.000Z",
        },
        {
          ...visitRow,
          id: "unlinked-1",
          visit_number: "SCS-V-20260801-9Z9Z",
          scheduled_starts_at: null,
          scheduled_ends_at: null,
        },
      ],
      error: null,
    } as never);

    renderPage();
    await openReport(/Visit details/);

    const table = await screen.findByRole("table", { name: "Visit details" });
    // 12:30Z-14:30Z is 5:30-7:30 AM Pacific (PDT).
    const linkedRow = within(table).getByText("SCS-V-20260801-4F7K").closest("tr")!;
    expect(linkedRow).toHaveTextContent(/Scheduled 5:30\sAM–7:30\sAM/);
    const unlinkedRow = within(table).getByText("SCS-V-20260801-9Z9Z").closest("tr")!;
    expect(unlinkedRow).toHaveTextContent("Not linked to a scheduled shift");
  });

  it("lists missed clock-outs and unconfirmed visits under Exceptions, but not visits still in their shift", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const open = { ...visitRow, status: "draft" as const, time_out: null, worked_minutes: null, billable_minutes: null, signed_at: null };
    mockedRpc.mockResolvedValue({
      data: [
        { ...open, id: "missed-1", caregiver_name: "Missed Clockout", time_in: ago(300), scheduled_starts_at: ago(300), scheduled_ends_at: ago(90) },
        { ...open, id: "working-1", caregiver_name: "Still Working", time_in: ago(30), scheduled_starts_at: ago(30), scheduled_ends_at: ago(-120) },
        { ...visitRow, id: "unconfirmed-1", caregiver_name: "Never Confirmed", status: "awaiting_signature", time_in: ago(300), time_out: ago(120), signed_at: null },
      ],
      error: null,
    } as never);

    renderPage();
    await openReport(/Exceptions needing attention/);

    const card = (await screen.findByText("Incomplete visits (2)")).closest("div")!;
    const items = within(card).getAllByRole("listitem");
    // Most overdue first: signed out 2h ago, then 1h 30m past scheduled end.
    expect(items[0]).toHaveTextContent("Never Confirmed");
    expect(items[0]).toHaveTextContent("Not confirmed");
    expect(items[0]).toHaveTextContent("Signed out 2h 0m ago");
    expect(items[1]).toHaveTextContent("Missed Clockout");
    expect(items[1]).toHaveTextContent("Missing Time Out");
    expect(items[1]).toHaveTextContent("1h 30m past scheduled end");
    expect(card).not.toHaveTextContent("Still Working");
    expect(screen.queryByText(/No visits currently need manager attention/)).not.toBeInTheDocument();
  });

  it("lets a visit manager close a missed clock-out with an explicit Pacific date, AM/PM and duration", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    const base = new Date();
    base.setSeconds(0, 0);
    const ago = (minutes: number) => new Date(base.getTime() - minutes * 60_000).toISOString();
    const missed = {
      ...visitRow, id: "missed-1", caregiver_name: "Missed Clockout", status: "draft" as const, time_out: null,
      worked_minutes: null, billable_minutes: null, signed_at: null,
      time_in: ago(300), scheduled_starts_at: ago(300), scheduled_ends_at: ago(90),
    };
    mockedRpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === "list_service_visits" ? { data: [missed], error: null } : { data: [], error: null }) as never,
    );
    const enter = (iso: string) => {
      const wall = toPacificWallTime(iso);
      fireEvent.change(screen.getByLabelText("Date"), { target: { value: wall.date } });
      fireEvent.change(screen.getByLabelText("Hour"), { target: { value: String(wall.hour) } });
      fireEvent.change(screen.getByLabelText("Minute"), { target: { value: String(wall.minute) } });
      fireEvent.click(screen.getByRole("radio", { name: wall.meridiem! }));
    };

    renderPage();
    await openReport(/Exceptions needing attention/);
    fireEvent.click(await screen.findByRole("button", { name: "Close visit" }));

    // Only the date is pre-filled (Time In's Pacific date); the time must be entered.
    expect(screen.getByLabelText("Date")).toHaveValue(toPacificWallTime(missed.time_in).date);
    expect(screen.getByLabelText("Hour")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "AM" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "PM" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/^Scheduled end:/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save Time Out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A reason is required to close a missed visit.");

    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Caregiver confirmed by phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Time Out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose the hour, minute, and AM or PM.");

    // Before Time In (e.g. the wrong AM/PM): named, with both times.
    enter(ago(360));
    fireEvent.click(screen.getByRole("button", { name: "Save Time Out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/must be after Time In \(.+\)\. Check the date and AM\/PM\./);

    // In the future.
    enter(new Date(base.getTime() + 120 * 60_000).toISOString());
    fireEvent.click(screen.getByRole("button", { name: "Save Time Out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/is in the future/);
    expect(mockedRpc).not.toHaveBeenCalledWith("close_missed_service_visit", expect.anything());

    // Valid: the summary spells out Time In, Time Out and the worked duration.
    enter(ago(60));
    const summary = screen.getByLabelText("Time Out summary");
    expect(summary).toHaveTextContent(`${formatVisitDate(ago(60))}, ${formatClockTime(ago(60))}`);
    expect(summary).toHaveTextContent("Duration4 hr");
    fireEvent.click(screen.getByRole("button", { name: "Save Time Out" }));
    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("close_missed_service_visit", {
        target_visit_id: "missed-1",
        actual_time_out: ago(60),
        reason: "Caregiver confirmed by phone",
      }),
    );
  });

  it("shows the server's message when it refuses a Time Out (e.g. an overlap)", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    const base = new Date();
    base.setSeconds(0, 0);
    const ago = (minutes: number) => new Date(base.getTime() - minutes * 60_000).toISOString();
    const missed = {
      ...visitRow, id: "missed-1", status: "draft" as const, time_out: null, worked_minutes: null,
      billable_minutes: null, signed_at: null, time_in: ago(300), scheduled_starts_at: ago(300), scheduled_ends_at: ago(90),
    };
    mockedRpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === "list_service_visits"
          ? { data: [missed], error: null }
          : fn === "close_missed_service_visit"
            ? { data: null, error: { message: "The Time Out overlaps another visit for this caregiver" } }
            : { data: [], error: null },
      ) as never,
    );

    renderPage();
    await openReport(/Exceptions needing attention/);
    fireEvent.click(await screen.findByRole("button", { name: "Close visit" }));
    const wall = toPacificWallTime(ago(60));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: wall.date } });
    fireEvent.change(screen.getByLabelText("Hour"), { target: { value: String(wall.hour) } });
    fireEvent.change(screen.getByLabelText("Minute"), { target: { value: String(wall.minute) } });
    fireEvent.click(screen.getByRole("radio", { name: wall.meridiem! }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Phone check" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Time Out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The Time Out overlaps another visit for this caregiver");
  });

  it("does not offer the close-out without visits.manage", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn((key: string) => key !== "visits.manage"),
    } as never);
    mockOrgLetterhead();
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    mockedRpc.mockResolvedValue({
      data: [{
        ...visitRow, id: "missed-1", status: "draft" as const, time_out: null, worked_minutes: null,
        billable_minutes: null, signed_at: null, time_in: ago(300), scheduled_starts_at: ago(300), scheduled_ends_at: ago(90),
      }],
      error: null,
    } as never);

    renderPage();
    await openReport(/Exceptions needing attention/);
    expect(await screen.findByText("Missing Time Out")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close visit" })).not.toBeInTheDocument();
  });

  it("marks visits whose Time Out a manager entered", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [{ ...visitRow, time_out_entered_by_manager: true }], error: null } as never);

    renderPage();
    await openReport(/Visit details/);
    const table = await screen.findByRole("table", { name: "Visit details" });
    expect(within(table).getByText("Time Out entered by manager")).toBeInTheDocument();
  });

  it("shows scheduled (reserved) time and what is left to schedule in the monthly reconciliation", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    const backend = {
      listVisits: vi.fn().mockResolvedValue([]),
      getLetterhead: vi.fn().mockResolvedValue({ legal_name: "Acme Care LLC", display_name: "Acme Care" }),
      listClientLocations: vi.fn().mockResolvedValue([]),
      listCorrections: vi.fn().mockResolvedValue([]),
      listMonthlyServiceSummary: vi.fn().mockResolvedValue([
        {
          clientId: "c1", clientCode: "TEST-C01", serviceId: "s1", serviceCode: "RSP", serviceName: "Respite",
          authorizationLineageId: "l1", authorizationPeriodStart: "2026-10-01", authorizationPeriodEnd: "2026-12-31",
          authorizedMinutes: 600, workedMinutes: 10, verifiedMinutes: 10, billableMinutes: 10,
          reservedMinutes: 420, remainingMinutes: 170, reviewMinutes: 0, visitCount: 1,
        },
      ]),
    } as unknown as ServiceVerificationBackend;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ServiceVerificationBackendContext.Provider value={backend}>
          <ServiceVerificationReportsPage />
        </ServiceVerificationBackendContext.Provider>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("Report"), { target: { value: "reconciliation" } });

    const header = await screen.findByRole("columnheader", { name: "Remaining to schedule" });
    const table = header.closest("table")!;
    const headers = within(table).getAllByRole("columnheader").map((th) => th.textContent);
    const row = within(table).getAllByRole("row")[1]!;
    const cells = within(row).getAllByRole("cell").map((td) => td.textContent);
    expect(cells[headers.indexOf("Scheduled")]).toBe("7 hr");
    expect(cells[headers.indexOf("Remaining to schedule")]).toBe("2 hr 50 min");
  });

  it("lists visits and computes worked/billable subtotals, excluding corrected records", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({
      data: [
        visitRow,
        {
          ...visitRow,
          id: "corrected-1",
          status: "corrected",
          is_corrected: true,
          worked_minutes: 30,
          billable_minutes: 30,
        },
      ],
      error: null,
    } as never);

    renderPage();

    await openReport(/Visit details/);

    expect(await screen.findByText("Visits (1)")).toBeInTheDocument();
    // "Jamie Smith" also appears in the client filter <option> and the
    // per-client subtotal card, so this only checks it appears in the
    // table row, not that it appears exactly once anywhere on the page.
    const table = screen.getByRole("table", { name: "Visit details" });
    expect(table).toHaveTextContent("Jamie Smith");
    // Superseded correction-chain rows are hidden by default; totals count
    // only the current signed/reviewable version.
    expect(screen.getByText("Worked: 1 hr")).toBeInTheDocument();
    expect(screen.getByText("Billable: 1 hr")).toBeInTheDocument();
    expect(screen.queryByText("Superseded")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show superseded records"));
    expect(await screen.findByText("Superseded")).toBeInTheDocument();
  });

  it("shows manager filters, charts, and a caregiver-hours sheet", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [visitRow], error: null } as never);

    renderPage();

    expect(await screen.findByText("Report Center")).toBeInTheDocument();
    expect(
      await screen.findByRole("option", { name: "Anaheim, CA" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Chart type")).toHaveValue("bar");
    expect(screen.getByLabelText("Group chart by")).toHaveValue("caregiver");
    expect(
      screen.queryByRole("table", { name: "Caregiver hours summary" }),
    ).not.toBeInTheDocument();

    await openReport(/Caregiver hours/);
    const caregiverSheet = screen.getByRole("table", {
      name: "Caregiver hours summary",
    });
    expect(caregiverSheet).toHaveTextContent("Jordan Rivera");
    expect(caregiverSheet).toHaveTextContent("1 hr");
  });

  it("copies one common staff link and explains assignment protection", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [visitRow], error: null } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderPage();

    await openReport(/Staff access/);

    fireEvent.click(
      await screen.findByRole("button", { name: "Copy staff sign-in link" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/service-verification`,
      ),
    );
    expect(screen.getByText("Staff link copied")).toBeInTheDocument();
    expect(
      screen.getByText(/can only see clients and services assigned to them/i),
    ).toBeInTheDocument();
  });

  it("maps each service's daily worked and billable hours into the monthly client calendar", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({
      data: [
        visitRow,
        {
          ...visitRow,
          id: "needs-review",
          caregiver_user_id: "review-caregiver",
          caregiver_name: "Sam Caregiver",
          worked_minutes: 45,
          verified_minutes: 0,
          billable_minutes: 0,
          status: "administrator_review",
        },
        {
          ...visitRow,
          id: "superseded",
          caregiver_user_id: "old-caregiver",
          caregiver_name: "Old Record",
          status: "corrected",
          is_corrected: true,
        },
      ],
      error: null,
    } as never);

    renderPage();

    // Wait until the visit query has populated the client option before
    // selecting it. Changing a native <select> to a value whose option has
    // not rendered yet resolves back to the empty "All clients" value.
    await screen.findByRole("option", { name: "Jamie Smith" });
    fireEvent.change(screen.getByLabelText("Client"), {
      target: { value: visitRow.client_id },
    });
    await openReport(/Client monthly calendar/);
    fireEvent.change(screen.getByLabelText("Calendar month"), {
      target: { value: "2026-08" },
    });

    const calendar = await screen.findByRole("grid", {
      name: /Service hours for Jamie Smith in 2026-08/,
    });
    expect(await within(calendar).findByText("Personal Care")).toBeInTheDocument();
    expect(within(calendar).getByText("1 hr 45 min")).toBeInTheDocument();
    expect(within(calendar).getByText("Billable 1 hr")).toBeInTheDocument();
    expect(within(calendar).queryByText("Jordan Rivera")).not.toBeInTheDocument();
    expect(within(calendar).queryByText("Old Record")).not.toBeInTheDocument();
  });

  it("shows exception visits flagged for review, correction, or over-authorization, but not a plain signed visit", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({
      data: [
        visitRow,
        { ...visitRow, id: "needs-review", status: "administrator_review" },
        {
          ...visitRow,
          id: "over-authorized",
          authorization_status: "exceeds_authorization",
        },
      ],
      error: null,
    } as never);

    renderPage();

    await openReport(/Exceptions/);

    await waitFor(() =>
      expect(screen.getByText("Exception visits")).toBeInTheDocument(),
    );
    const exceptionCard = screen.getByText("Exception visits").closest("div")!;
    expect(within(exceptionCard).getByText("Needs review")).toBeInTheDocument();
    expect(
      within(exceptionCard).getByText("Exceeds authorization"),
    ).toBeInTheDocument();
    // Only 2 rows in the card: the plain signed/within-authorization
    // visitRow itself never appears here.
    expect(within(exceptionCard).getAllByRole("listitem")).toHaveLength(2);
  });

  it("uses actual signed visit time and does not load fixed schedules", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_service_visits") {
        return Promise.resolve({ data: [visitRow], error: null }) as never;
      }
      if (fn === "list_shifts") {
        return Promise.resolve({
          data: [
            {
              client_id: visitRow.client_id,
              client_name: "Jamie Smith",
              caregiver_user_id: visitRow.caregiver_user_id,
              caregiver_name: "Jordan Rivera",
              starts_at: "2026-08-01T13:00:00.000Z",
              ends_at: "2026-08-01T14:30:00.000Z",
              status: "completed",
            },
            {
              client_id: "unsigned-client",
              client_name: "Alex Doe",
              caregiver_user_id: "unsigned-caregiver",
              caregiver_name: "Sam Caregiver",
              starts_at: "2026-08-02T13:00:00.000Z",
              ends_at: "2026-08-02T14:00:00.000Z",
              status: "scheduled",
            },
          ],
          error: null,
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/actual signed visit time/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Scheduled vs delivered hours"),
    ).not.toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalledWith(
      "list_shifts",
      expect.anything(),
    );
  });

  it("does not create scheduled-hour totals when there are no signed visits", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_service_visits") {
        return Promise.resolve({ data: [], error: null }) as never;
      }
      if (fn === "list_shifts") {
        return Promise.resolve({
          data: [
            {
              client_id: "called-out-client",
              client_name: "Robin Lee",
              caregiver_user_id: "called-out-caregiver",
              caregiver_name: "Casey Nguyen",
              starts_at: "2026-08-03T13:00:00.000Z",
              ends_at: "2026-08-03T15:00:00.000Z",
              status: "scheduled",
              needs_coverage: true,
            },
          ],
          error: null,
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/actual signed visit time/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/scheduled ·/i)).not.toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalledWith(
      "list_shifts",
      expect.anything(),
    );
  });

  it("passes filter selections through to list_service_visits", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [visitRow], error: null } as never);

    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText("Client")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-08-31" },
    });

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "list_service_visits",
        expect.objectContaining({
          target_organization_id: ORG_ID,
          filter_date_from: "2026-08-01",
          filter_date_to: "2026-08-31",
        }),
      ),
    );
  });

  it("opens a named caregiver folder and preserves it in the report link", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [visitRow], error: null } as never);

    renderPage();
    await openReport(/Caregiver hours/);
    fireEvent.click(
      await screen.findByRole("button", { name: /Caregiver Jordan Rivera/ }),
    );

    await waitFor(() =>
      expect(window.location.search).toContain(
        `caregiver=${visitRow.caregiver_user_id}`,
      ),
    );
    expect(
      await screen.findByRole("button", { name: "All caregivers" }),
    ).toBeInTheDocument();
  });

  it("shows the visit number with separate authorized, used MTD, and remaining values", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [visitRow], error: null } as never);

    renderPage();

    await openReport(/Visit details/);

    expect(await screen.findByText("SCS-V-20260801-4F7K")).toBeInTheDocument();
    const visitTable = screen.getByRole("table", { name: "Visit details" });
    expect(within(visitTable).getByText("40 hr")).toBeInTheDocument();
    expect(within(visitTable).getByText("11 hr")).toBeInTheDocument();
    expect(within(visitTable).getByText("29 hr")).toBeInTheDocument();
  });

  it("submits a correction for a signed visit", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_service_visits")
        return Promise.resolve({ data: [visitRow], error: null }) as never;
      if (fn === "correct_service_visit")
        return Promise.resolve({ data: "corrected-id", error: null }) as never;
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();
    await openReport(/Visit details/);
    await screen.findByText("SCS-V-20260801-4F7K");

    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.change(screen.getByLabelText("Reason (required)"), {
      target: { value: "Forgot to clock out on time" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "correct_service_visit",
        expect.objectContaining({
          target_visit_id: visitRow.id,
          reason: "Forgot to clock out on time",
        }),
      ),
    );
  });

  it("requires a reason before submitting a correction", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [visitRow], error: null } as never);

    renderPage();
    await openReport(/Visit details/);
    await screen.findByText("SCS-V-20260801-4F7K");

    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() =>
      expect(
        screen.getByText("A reason is required to correct a visit."),
      ).toBeInTheDocument(),
    );
  });

  it("shows correction history for a visit", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_service_visits")
        return Promise.resolve({ data: [visitRow], error: null }) as never;
      if (fn === "list_visit_corrections") {
        return Promise.resolve({
          data: [
            {
              id: "correction-1",
              corrected_by_name: "Admin User",
              reason: "Clock-out time was wrong",
              before_snapshot: {
                timeIn: "2026-08-01T13:00:00.000Z",
                timeOut: "2026-08-01T14:00:00.000Z",
                workedMinutes: 60,
                billableMinutes: 60,
              },
              after_snapshot: {
                timeIn: "2026-08-01T13:00:00.000Z",
                timeOut: "2026-08-01T14:30:00.000Z",
                workedMinutes: 90,
                billableMinutes: 90,
              },
              created_at: "2026-08-02T10:00:00.000Z",
            },
          ],
          error: null,
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();
    await openReport(/Visit details/);
    await screen.findByText("SCS-V-20260801-4F7K");

    fireEvent.click(screen.getByRole("button", { name: "History" }));

    await waitFor(() =>
      expect(
        screen.getByText("Admin User", { exact: false }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/Clock-out time was wrong/)).toBeInTheDocument();
  });

  it("hides Correct and History actions without visits.manage", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(
        (permission: string) => permission === "visits.read",
      ),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [visitRow], error: null } as never);

    renderPage();
    await openReport(/Visit details/);
    await screen.findByText("SCS-V-20260801-4F7K");

    expect(
      screen.queryByRole("button", { name: "Correct" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "History" }),
    ).not.toBeInTheDocument();
  });

  it("triggers window.print for the Print action", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true),
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [visitRow], error: null } as never);
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Print / Save as PDF" }),
    );

    expect(printSpy).toHaveBeenCalled();
  });
});
