import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
const SERVICE_ID = "44444444-4444-4444-8444-444444444444";

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

function renderPage(initialPath = "/authorizations") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>
        <AuthorizationsPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

interface MockLookups {
  clients?: Array<{ id: string; first_name: string; last_name: string }>;
  services?: Array<{ id: string; name: string; is_active: boolean }>;
}

// clients, services, and client_authorizations are all queried through
// supabase.from(), so the mock has to branch on the table name rather
// than returning one fixed chain for every call.
function mockFromByTable({ clients = [], services = [] }: MockLookups = {}) {
  const insertMock = vi.fn().mockResolvedValue({ error: null });
  const eqMock = vi.fn().mockResolvedValue({ error: null });
  const updateMock = vi.fn(() => ({ eq: eqMock }));

  mockedFrom.mockImplementation((table: string) => {
    if (table === "clients") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: clients, error: null }) }))
        }))
      } as never;
    }
    if (table === "services") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: services, error: null }) }))
          }))
        })),
        insert: insertMock,
        update: updateMock
      } as never;
    }
    return { insert: insertMock, update: updateMock } as never;
  });

  return { insertMock, updateMock, eqMock };
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

  it("lists authorizations with a usage status", async () => {
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
          service_id: SERVICE_ID,
          service_name: "Personal care",
          payer: "Medicaid",
          authorization_number: "AUTH-1",
          max_monthly_hours: 20,
          period_start: "2026-07-01",
          period_end: "2027-06-30",
          notes: null,
          hours_used_this_month: 15,
          hours_scheduled_this_month: 10
        }
      ],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    expect(screen.getByText("Personal care")).toBeInTheDocument();
    expect(screen.getByText("Over limit")).toBeInTheDocument();
    expect(screen.queryByText("Add an authorization")).not.toBeInTheDocument();
  });

  it("adds a new authorization", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);
    const { insertMock } = mockFromByTable({
      clients: [{ id: CLIENT_ID, first_name: "Jordan", last_name: "Rivera" }],
      services: [{ id: SERVICE_ID, name: "Personal care", is_active: true }]
    });

    renderPage();

    fireEvent.focus(screen.getByLabelText("Client"));
    await waitFor(() => expect(screen.getByRole("option", { name: "Jordan Rivera" })).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole("option", { name: "Jordan Rivera" }));

    fireEvent.focus(screen.getByLabelText("Service"));
    await waitFor(() => expect(screen.getByRole("option", { name: "Personal care" })).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole("option", { name: "Personal care" }));

    fireEvent.change(screen.getByLabelText("Payer"), { target: { value: "Medicaid" } });
    fireEvent.change(screen.getByLabelText("Max hours / month"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Period start"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("Period end"), { target: { value: "2027-06-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Add authorization" }));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          client_id: CLIENT_ID,
          service_id: SERVICE_ID,
          payer: "Medicaid",
          max_monthly_hours: 20
        })
      )
    );
  });

  it("pre-fills and locks the client field when arriving with ?clientId=", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);
    mockFromByTable({
      clients: [{ id: CLIENT_ID, first_name: "Jordan", last_name: "Rivera" }],
      services: [{ id: SERVICE_ID, name: "Personal care", is_active: true }]
    });

    renderPage(`/authorizations?clientId=${CLIENT_ID}`);

    await waitFor(() => expect(screen.getByLabelText("Client")).toBeDisabled());
    await waitFor(() => expect(screen.getByLabelText("Client")).toHaveValue("Jordan Rivera"));
    expect(screen.queryByRole("button", { name: "Clear Client" })).not.toBeInTheDocument();
  });

  it("soft-deletes an authorization via Remove", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          client_id: CLIENT_ID,
          client_name: "Jordan Rivera",
          service_id: SERVICE_ID,
          service_name: "Personal care",
          payer: "Medicaid",
          authorization_number: null,
          max_monthly_hours: 20,
          period_start: "2026-07-01",
          period_end: "2027-06-30",
          notes: null,
          hours_used_this_month: 5,
          hours_scheduled_this_month: 5
        }
      ],
      error: null
    } as never);
    const { updateMock, eqMock } = mockFromByTable();

    renderPage();
    await waitFor(() => expect(screen.getByText("Remove")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }))
    );
    expect(eqMock).toHaveBeenCalledWith("id", "33333333-3333-4333-8333-333333333333");
  });
});
