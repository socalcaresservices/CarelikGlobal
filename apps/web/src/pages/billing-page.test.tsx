import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { BillingPage } from "./billing-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: vi.fn() }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const VISIT_ID = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ID = "33333333-3333-4333-8333-333333333333";

function baseOrganization(overrides: Partial<ReturnType<typeof useOrganization>> = {}) {
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
    hasPermission: vi.fn(() => true),
    loading: false,
    ...overrides
  } as never;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BillingPage />
    </QueryClientProvider>
  );
}

describe("BillingPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without billing.read", () => {
    mockedUseOrganization.mockReturnValue(baseOrganization({ hasPermission: vi.fn(() => false) }));

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists billing-ready visits and approves one", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_billing_ready_visits") {
        return Promise.resolve({
          data: [
            {
              visit_id: VISIT_ID,
              client_id: "44444444-4444-4444-8444-444444444444",
              client_name: "Jordan Rivera",
              service_name: "Personal care",
              caregiver_name: "Casey Lee",
              service_date: "2026-08-05",
              worked_minutes: 240,
              billable_minutes: 240,
              signed_at: "2026-08-05T20:00:00Z"
            }
          ],
          error: null
        }) as never;
      }
      if (fn === "approve_visit_for_billing") {
        return Promise.resolve({ data: APPROVAL_ID, error: null }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera · Personal care")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(screen.getByLabelText("Approved minutes")).toHaveValue(240));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("approve_visit_for_billing", {
        target_visit_id: VISIT_ID,
        approved_minutes: 240,
        notes: null
      })
    );
  });

  it("submits selected approvals as a batch", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_billing_approvals") {
        return Promise.resolve({
          data: [
            {
              approval_id: APPROVAL_ID,
              visit_id: VISIT_ID,
              client_name: "Jordan Rivera",
              service_name: "Personal care",
              service_date: "2026-08-05",
              approved_minutes: 240,
              approved_by_name: "Admin User",
              approved_at: "2026-08-06T00:00:00Z",
              is_voided: false,
              is_submitted: false
            }
          ],
          error: null
        }) as never;
      }
      if (fn === "submit_billing_approvals") {
        return Promise.resolve({ data: "55555555-5555-4555-8555-555555555555", error: null }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await waitFor(() => expect(screen.getByText("Jordan Rivera · Personal care")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Select Jordan Rivera Personal care"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit 1 selected" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Submit 1 selected" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("submit_billing_approvals", {
        target_organization_id: ORG_ID,
        approval_ids: [APPROVAL_ID],
        notes: null
      })
    );
  });

  it("does not show the submit button without billing.submit", async () => {
    mockedUseOrganization.mockReturnValue(
      baseOrganization({ hasPermission: vi.fn((p: string) => p !== "billing.submit") })
    );
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_billing_approvals") {
        return Promise.resolve({
          data: [
            {
              approval_id: APPROVAL_ID,
              visit_id: VISIT_ID,
              client_name: "Jordan Rivera",
              service_name: "Personal care",
              service_date: "2026-08-05",
              approved_minutes: 240,
              approved_by_name: "Admin User",
              approved_at: "2026-08-06T00:00:00Z",
              is_voided: false,
              is_submitted: false
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await waitFor(() => expect(screen.getByText("Jordan Rivera · Personal care")).toBeInTheDocument());
    expect(screen.queryByLabelText("Select Jordan Rivera Personal care")).not.toBeInTheDocument();
  });

  it("shows submission history", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_billing_submissions") {
        return Promise.resolve({
          data: [
            {
              submission_id: "66666666-6666-4666-8666-666666666666",
              submitted_by_name: "Admin User",
              submitted_at: "2026-08-06T00:00:00Z",
              period_start: "2026-08-01",
              period_end: "2026-08-31",
              notes: "August batch",
              item_count: 3,
              active_item_count: 3,
              total_submitted_minutes: 720
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Submission history" }));
    await waitFor(() => expect(screen.getByText("3 of 3 visits · 12h")).toBeInTheDocument());
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("August batch")).toBeInTheDocument();
  });
});
