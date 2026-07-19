import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { AuthorizationsPage } from "./authorizations-page";

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
    hasPermission: vi.fn(),
    loading: false
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthorizationsPage />
    </QueryClientProvider>
  );
}

describe("AuthorizationsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without authorizations.read", () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => false) });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists authorizations with a utilization status", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "authorizations.read")
    });
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          client_id: CLIENT_ID,
          client_name: "Jordan Rivera",
          payer: "Medicaid",
          authorized_hours: 20,
          period_start: "2026-07-01",
          period_end: "2026-07-31",
          notes: null,
          scheduled_hours: 25
        }
      ],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    expect(screen.getByText("Over authorized hours")).toBeInTheDocument();
    expect(screen.queryByText("Add an authorization")).not.toBeInTheDocument();
  });

  it("adds a new authorization", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);
    const orderMock = vi.fn().mockResolvedValue({
      data: [{ id: CLIENT_ID, first_name: "Jordan", last_name: "Rivera" }],
      error: null
    });
    const eqMock = vi.fn(() => ({ order: orderMock }));
    const selectMock = vi.fn(() => ({ eq: eqMock }));
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockedFrom.mockReturnValue({ select: selectMock, insert: insertMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByRole("option", { name: "Jordan Rivera" })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Client"), { target: { value: CLIENT_ID } });
    fireEvent.change(screen.getByLabelText("Payer"), { target: { value: "Medicaid" } });
    fireEvent.change(screen.getByLabelText("Authorized hours"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Period start"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("Period end"), { target: { value: "2026-07-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Add authorization" }));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          client_id: CLIENT_ID,
          payer: "Medicaid",
          authorized_hours: 20
        })
      )
    );
  });

  it("soft-deletes an authorization via Remove", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          client_id: CLIENT_ID,
          client_name: "Jordan Rivera",
          payer: "Medicaid",
          authorized_hours: 20,
          period_start: "2026-07-01",
          period_end: "2026-07-31",
          notes: null,
          scheduled_hours: 10
        }
      ],
      error: null
    } as never);
    const clientsSelectMock = vi.fn(() => ({ eq: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) })) }));
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    mockedFrom.mockReturnValue({ select: clientsSelectMock, update: updateMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Remove")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }))
    );
    expect(eqMock).toHaveBeenCalledWith("id", "33333333-3333-4333-8333-333333333333");
  });
});
