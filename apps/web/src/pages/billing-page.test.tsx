import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { BillingPage } from "./billing-page";

vi.mock("@/providers/organization-provider", () => ({
  useOrganization: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
  },
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const VISIT_ID = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ID = "33333333-3333-4333-8333-333333333333";

function baseOrganization({
  role = "organization_owner",
  canApprove = true,
  canSubmit = true,
  canReadFinancial = true,
}: {
  role?: "organization_owner" | "manager";
  canApprove?: boolean;
  canSubmit?: boolean;
  canReadFinancial?: boolean;
} = {}) {
  return {
    organizations: [],
    activeOrganization: {
      id: ORG_ID,
      slug: "acme",
      legalName: "Acme LLC",
      displayName: "Acme",
      status: "active" as const,
      timezone: "America/Los_Angeles",
    },
    activeOrganizationId: ORG_ID,
    setActiveOrganizationId: vi.fn(),
    role,
    isPlatformOwner: false,
    hasPermission: vi.fn((permission: string) => {
      if (permission === "billing.visits.read") return true;
      if (permission === "billing.read" || permission === "billing.update")
        return canReadFinancial;
      if (permission === "billing.approve") return canApprove;
      if (permission === "billing.submit") return canSubmit;
      return false;
    }),
    loading: false,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BillingPage />
    </QueryClientProvider>,
  );
}

function mockRpc({
  ready = [],
  approvals = [],
  submissions = [],
  items = [],
}: {
  ready?: unknown[];
  approvals?: unknown[];
  submissions?: unknown[];
  items?: unknown[];
} = {}) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "list_billing_ready_visits")
      return Promise.resolve({ data: ready, error: null }) as never;
    if (fn === "list_billing_approvals")
      return Promise.resolve({ data: approvals, error: null }) as never;
    if (fn === "list_billing_submissions")
      return Promise.resolve({ data: submissions, error: null }) as never;
    if (fn === "list_billing_submission_items")
      return Promise.resolve({ data: items, error: null }) as never;
    if (fn === "approve_visit_for_billing")
      return Promise.resolve({ data: null, error: null }) as never;
    if (fn === "submit_billing_approvals")
      return Promise.resolve({ data: "sub-1", error: null }) as never;
    return Promise.resolve({ data: [], error: null }) as never;
  });
}

describe("BillingPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without billing.visits.read", () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn(() => false),
    });
    mockRpc();

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists ready-to-bill visits with an estimated amount", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockRpc({
      ready: [
        {
          visit_id: VISIT_ID,
          client_id: "c1",
          client_name: "Jordan Rivera",
          service_name: "Personal care",
          caregiver_name: "Alex Caregiver",
          service_date: "2026-08-01",
          worked_minutes: 120,
          billable_minutes: 120,
          signed_at: "2026-08-01T20:00:00Z",
          rate_cents: 4000,
          estimated_amount_cents: 8000,
        },
      ],
    });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Jordan Rivera")).toBeInTheDocument(),
    );
    expect(screen.getByText("$80.00")).toBeInTheDocument();
    expect(screen.getByText("$40.00/hr")).toBeInTheDocument();
  });

  it("gives a manager an hours-only visit review with no financial data or submission controls", async () => {
    mockedUseOrganization.mockReturnValue(
      baseOrganization({
        role: "manager",
        canSubmit: false,
        canReadFinancial: false,
      }),
    );
    mockRpc({
      ready: [
        {
          visit_id: VISIT_ID,
          client_id: "c1",
          client_name: "Jordan Rivera",
          service_name: "Personal care",
          caregiver_name: "Alex Caregiver",
          service_date: "2026-08-01",
          worked_minutes: 120,
          billable_minutes: 120,
          signed_at: "2026-08-01T20:00:00Z",
          rate_cents: 4000,
          estimated_amount_cents: 8000,
        },
      ],
      approvals: [
        {
          approval_id: APPROVAL_ID,
          visit_id: VISIT_ID,
          client_name: "Jordan Rivera",
          service_name: "Personal care",
          service_date: "2026-08-01",
          approved_minutes: 120,
          rate_cents: 4000,
          amount_cents: 8000,
          approved_by_name: "Sam Manager",
          approved_at: "2026-08-01T21:00:00Z",
          is_voided: false,
          is_submitted: false,
        },
      ],
    });

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText("Review and approve visit hours"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("$80.00")).not.toBeInTheDocument();
    expect(screen.queryByText("$40.00/hr")).not.toBeInTheDocument();
    expect(screen.queryByText("Rate")).not.toBeInTheDocument();
    expect(screen.queryByText("Est. amount")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Submit selected/ }),
    ).not.toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalledWith(
      "list_billing_submissions",
      expect.anything(),
    );
  });

  it("approves a ready visit for billing", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockRpc({
      ready: [
        {
          visit_id: VISIT_ID,
          client_id: "c1",
          client_name: "Jordan Rivera",
          service_name: "Personal care",
          caregiver_name: "Alex Caregiver",
          service_date: "2026-08-01",
          worked_minutes: 120,
          billable_minutes: 120,
          signed_at: "2026-08-01T20:00:00Z",
          rate_cents: 4000,
          estimated_amount_cents: 8000,
        },
      ],
    });

    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Jordan Rivera")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Approved minutes")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "approve_visit_for_billing",
        expect.objectContaining({
          target_visit_id: VISIT_ID,
          approved_minutes: 120,
        }),
      ),
    );
  });

  it("submits selected approvals as a batch", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockRpc({
      approvals: [
        {
          approval_id: APPROVAL_ID,
          visit_id: VISIT_ID,
          client_name: "Jordan Rivera",
          service_name: "Personal care",
          service_date: "2026-08-01",
          approved_minutes: 120,
          rate_cents: 4000,
          amount_cents: 8000,
          approved_by_name: "Sam Manager",
          approved_at: "2026-08-01T21:00:00Z",
          is_voided: false,
          is_submitted: false,
        },
      ],
    });

    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Jordan Rivera")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByLabelText("Select Jordan Rivera 2026-08-01"));
    fireEvent.click(
      screen.getByRole("button", { name: "Submit selected (1)" }),
    );

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "submit_billing_approvals",
        expect.objectContaining({
          target_organization_id: ORG_ID,
          approval_ids: [APPROVAL_ID],
        }),
      ),
    );
  });

  it("exports a submission's line items as CSV", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockRpc({
      submissions: [
        {
          submission_id: "sub-1",
          submitted_by_name: "Sam Manager",
          submitted_at: "2026-08-02T10:00:00Z",
          period_start: null,
          period_end: null,
          notes: null,
          item_count: 1,
          active_item_count: 1,
          total_submitted_minutes: 120,
          total_amount_cents: 8000,
        },
      ],
      items: [
        {
          item_id: "item-1",
          visit_id: VISIT_ID,
          client_name: "Jordan Rivera",
          service_name: "Personal care",
          service_date: "2026-08-01",
          submitted_minutes: 120,
          rate_cents: 4000,
          submitted_amount_cents: 8000,
          is_voided: false,
          void_reason: null,
        },
      ],
    });

    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/by Sam Manager/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "View items" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Export CSV" }),
      ).not.toBeDisabled(),
    );

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });
});
