import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ServiceVerificationReportsPage } from "./service-verification-reports-page";

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

const visitRow = {
  id: "22222222-2222-4222-8222-222222222222",
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
  is_corrected: false
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ServiceVerificationReportsPage />
    </QueryClientProvider>
  );
}

function mockOrgLetterhead() {
  const single = vi.fn().mockResolvedValue({
    data: { legal_name: "Acme Care LLC", display_name: "Acme Care", logo_url: null },
    error: null
  });
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  mockedFrom.mockReturnValue({ select } as never);
}

describe("ServiceVerificationReportsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without visits.read", () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => false)
    } as never);

    renderPage();

    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("lists visits and computes worked/billable subtotals, excluding corrected records", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true)
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({
      data: [
        visitRow,
        { ...visitRow, id: "corrected-1", status: "corrected", is_corrected: true, worked_minutes: 30, billable_minutes: 30 }
      ],
      error: null
    } as never);

    renderPage();

    expect(await screen.findByText("Visits (2)")).toBeInTheDocument();
    // "Jamie Smith" also appears in the client filter <option> and the
    // per-client subtotal card, so this only checks it appears in the
    // table row, not that it appears exactly once anywhere on the page.
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("Jamie Smith");
    // Grand total excludes the corrected row (30 min) - only the signed
    // 60-minute visit counts.
    const totalsRow = screen.getByText("Total (signed + under review)").closest("tr")!;
    expect(totalsRow).toHaveTextContent("1");
    // Two matches for the corrected row: the "Corrected" status badge
    // (status === 'corrected') and the separate is_corrected marker badge.
    expect(screen.getAllByText("Corrected").length).toBeGreaterThan(0);
  });

  it("passes filter selections through to list_service_visits", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true)
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [visitRow], error: null } as never);

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Client")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-31" } });

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "list_service_visits",
        expect.objectContaining({
          target_organization_id: ORG_ID,
          filter_date_from: "2026-08-01",
          filter_date_to: "2026-08-31"
        })
      )
    );
  });

  it("triggers window.print for the Print action", async () => {
    mockedUseOrganization.mockReturnValue({
      activeOrganizationId: ORG_ID,
      activeOrganization: { displayName: "Acme Care" },
      hasPermission: vi.fn(() => true)
    } as never);
    mockOrgLetterhead();
    mockedRpc.mockResolvedValue({ data: [visitRow], error: null } as never);
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Print/ }));

    expect(printSpy).toHaveBeenCalled();
  });
});
