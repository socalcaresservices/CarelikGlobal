// The monthly AUTHORISED hours above the client calendar (owner TEST finding 7): one line per service for the selected client and month, from the server's monthly
// summary; updates when the client or the month changes; loading, error and none are different states; nothing is repeated inside a day. SYNTHETIC data only.
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { ServiceVerificationBackendContext, type ServiceVerificationBackend } from "@/lib/sv-backend";
import { ServiceVerificationReportsPage } from "./service-verification-reports-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
const mockedUseOrganization = vi.mocked(useOrganization);
const ORG = "11111111-1111-4111-8111-111111111111";
const C1 = "33333333-3333-4333-8333-333333333331";
const C2 = "33333333-3333-4333-8333-333333333332";

const visit = (clientId: string, name: string, n: number) => ({
  id: `22222222-2222-4222-8222-22222222222${n}`, visit_number: `V-${n}`, client_id: clientId, client_code: `CL-00${n}`, client_legal_name: name,
  caregiver_user_id: "44444444-4444-4444-8444-444444444444", caregiver_name: "Jordan Rivera", service_id: "55555555-5555-4555-8555-555555555555", service_name: "Respite",
  service_date: "2026-08-01", time_in: "2026-08-01T13:00:00.000Z", time_out: "2026-08-01T14:00:00.000Z", worked_minutes: 60, verified_minutes: 60, billable_minutes: 60,
  status: "signed" as const, authorization_status: "within_authorization", signed_at: "2026-08-01T14:05:00.000Z", original_visit_id: null, is_corrected: false,
  month_to_date_before_minutes: 0, month_to_date_after_minutes: 60, remaining_minutes: 100, client_name_duplicate: false,
});
const row = (clientId: string, serviceId: string, serviceName: string, lineage: string, authorizedMinutes: number) => ({
  clientId, clientCode: "X", serviceId, serviceCode: serviceName.slice(0, 3).toUpperCase(), serviceName, authorizationLineageId: lineage, authorizationVersion: 1,
  authorizationPeriodStart: "2026-01-01", authorizationPeriodEnd: "2026-12-31", authorizedMinutes, workedMinutes: 0, verifiedMinutes: 0, billableMinutes: 0,
  reservedMinutes: 0, remainingMinutes: authorizedMinutes, reviewMinutes: 0, visitCount: 0, hoursLeftMinutes: authorizedMinutes,
});

function setup(summary: ServiceVerificationBackend["listMonthlyServiceSummary"]) {
  mockedUseOrganization.mockReturnValue({ activeOrganizationId: ORG, activeOrganization: { displayName: "Acme Care" }, hasPermission: vi.fn(() => true) } as never);
  const backend = {
    kind: "aws",
    listVisits: vi.fn().mockResolvedValue([visit(C1, "Robin Unique", 1), visit(C2, "Dana Sample", 2)]),
    getLetterhead: vi.fn().mockResolvedValue({ legal_name: "Acme Care LLC", display_name: "Acme Care" }),
    listClientLocations: vi.fn().mockResolvedValue([]),
    listCorrections: vi.fn().mockResolvedValue([]),
    listMonthlyServiceSummary: summary,
  } as unknown as ServiceVerificationBackend;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/service-verification/reports?view=calendar"]}>
      <QueryClientProvider client={queryClient}>
        <ServiceVerificationBackendContext.Provider value={backend}><ServiceVerificationReportsPage /></ServiceVerificationBackendContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return backend;
}
const line = (text: string) => (_: string, el: Element | null) => el?.tagName === "LI" && el.textContent === text;
const choose = async (id: string) => {
  const select = await screen.findByLabelText("Calendar client");
  await waitFor(() => expect(within(select).getAllByRole("option").length).toBeGreaterThan(2));
  fireEvent.change(select, { target: { value: id } });
};
afterEach(() => cleanup());

describe("Authorised hours above the calendar", () => {
  it("shows each service on its own line for the selected client: 'Respite — Authorised: 40 h', 'Personal Care — Authorised: 12.5 h'; services are not combined; nothing sits inside a day cell", async () => {
    const fn = vi.fn(async (_org: string, clientId: string | null) => clientId === C1
      ? [row(C1, "s-resp", "Respite", "l1", 2400), row(C1, "s-pc", "Personal Care", "l2", 750)]
      : [row(C2, "s-resp", "Respite", "l3", 600)]);
    setup(fn as never);
    expect(screen.queryByTestId("authorised-hours")).toBeNull(); // no client chosen yet
    await choose(C1);
    const list = await screen.findByTestId("authorised-hours");
    const items = within(list).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Personal Care — Authorised: 12.5 h", "Respite — Authorised: 40 h"]);
    expect(screen.getAllByText(/Authorised:/)).toHaveLength(2);
    const grid = screen.getByRole("grid");
    expect(within(grid).queryByText(/Authorised/)).toBeNull();
    expect(list).not.toHaveTextContent(/Hours left|Billable|Pending|Reserved/); // not the Hours left breakdown
  });

  it("updates when the client changes and when the month changes (the summary is requested for that client and month)", async () => {
    const fn = vi.fn(async (_org: string, clientId: string | null, monthStart: string) => clientId === C1
      ? [row(C1, "s-resp", "Respite", "l1", monthStart.startsWith("2026-11") ? 1200 : 2400)]
      : [row(C2, "s-resp", "Respite", "l3", 600)]);
    setup(fn as never);
    await choose(C1);
    expect(await screen.findByText(line("Respite — Authorised: 40 h"))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Calendar month"), { target: { value: "2026-11" } });
    expect(await screen.findByText(line("Respite — Authorised: 20 h"))).toBeInTheDocument();
    expect(fn).toHaveBeenCalledWith(ORG, C1, "2026-11-01");
    fireEvent.change(screen.getByLabelText("Calendar client"), { target: { value: C2 } });
    expect(await screen.findByText(line("Respite — Authorised: 10 h"))).toBeInTheDocument();
    expect(screen.queryByText(line("Respite — Authorised: 20 h"))).toBeNull();
  });

  it("loading, error and no-authorization are different: loading text, an alert that is not a zero, and 'No authorization this month'", async () => {
    let release!: (v: unknown[]) => void;
    const pending = new Promise<unknown[]>((r) => { release = r; });
    setup(vi.fn(() => pending) as never);
    await choose(C1);
    expect(await screen.findByText("Loading authorised hours…")).toBeInTheDocument();
    release([]);
    expect(await screen.findByText("No authorization this month")).toBeInTheDocument();
    cleanup();
    setup(vi.fn(async () => { throw new Error("boom"); }) as never);
    await choose(C1);
    const alert = await screen.findByTestId("authorised-hours-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("not shown as zero");
    expect(screen.queryByText(/Authorised: 0/)).toBeNull();
  });

  it("only the CURRENT authorization counts: an earlier authorization of the same service is history, never added or listed as authorized time", async () => {
    const earlier = { ...row(C1, "s-resp", "Respite", "l-old", 6000), authorizationPeriodStart: "2026-01-01", authorizationPeriodEnd: "2026-08-31" };
    const current = { ...row(C1, "s-resp", "Respite", "l-new", 1200), authorizationPeriodStart: "2026-08-01", authorizationPeriodEnd: "2026-12-31" };
    setup(vi.fn(async () => [earlier, current]) as never);
    await choose(C1);
    expect(await screen.findByText(line("Respite — Authorised: 20 h"))).toBeInTheDocument();
    expect(screen.queryByText(/100 h/)).not.toBeInTheDocument();
    // the totals table does not list the earlier authorization (it carries no activity)
    const table = await screen.findByRole("table", { name: "Monthly service totals" });
    expect(within(table).queryByText(/Earlier authorization/)).not.toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(2); // header + the current authorization
  });

  it("worked time under an earlier authorization stays visible as history with no authorized time", async () => {
    const earlier = { ...row(C1, "s-resp", "Respite", "l-old", 6000), authorizationPeriodStart: "2026-01-01", authorizationPeriodEnd: "2026-08-31", workedMinutes: 90, billableMinutes: 90, visitCount: 1 };
    const current = { ...row(C1, "s-resp", "Respite", "l-new", 1200), authorizationPeriodStart: "2026-08-01", authorizationPeriodEnd: "2026-12-31" };
    setup(vi.fn(async () => [earlier, current]) as never);
    await choose(C1);
    expect(await screen.findByText(line("Respite — Authorised: 20 h"))).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Monthly service totals" });
    expect(within(table).getByText(/Earlier authorization \(history\)/)).toBeInTheDocument();
  });
});
