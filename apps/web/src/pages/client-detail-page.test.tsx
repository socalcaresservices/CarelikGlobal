import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ClientDetailPage } from "./client-detail-page";

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
    hasPermission: vi.fn(() => true),
    loading: false
  };
}

function mockClientRecord(data: unknown) {
  const singleMock = vi.fn().mockResolvedValue({ data, error: data ? null : { message: "not found" } });
  const eqMock = vi.fn(() => ({ single: singleMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  return selectMock;
}

interface ServiceOption {
  id: string;
  name: string;
  is_active: boolean;
}

// clients, services, and client_requested_services are all queried
// through supabase.from(), so the mock has to branch on the table name
// rather than returning one fixed chain for every call.
function mockFromByTable(client: unknown, services: ServiceOption[] = []) {
  const clientSelectMock = mockClientRecord(client);
  const clientUpdateEqMock = vi.fn().mockResolvedValue({ error: null });
  const clientUpdateMock = vi.fn(() => ({ eq: clientUpdateEqMock }));

  const requestedServicesDeleteEqMock = vi.fn().mockResolvedValue({ error: null });
  const requestedServicesDeleteMock = vi.fn(() => ({ eq: requestedServicesDeleteEqMock }));
  const requestedServicesInsertMock = vi.fn().mockResolvedValue({ error: null });

  mockedFrom.mockImplementation((table: string) => {
    if (table === "clients") {
      return { select: clientSelectMock, update: clientUpdateMock } as never;
    }
    if (table === "services") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: services, error: null }) }))
          }))
        }))
      } as never;
    }
    if (table === "client_requested_services") {
      return { delete: requestedServicesDeleteMock, insert: requestedServicesInsertMock } as never;
    }
    return {} as never;
  });

  return { clientUpdateMock, clientUpdateEqMock, requestedServicesDeleteMock, requestedServicesInsertMock };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/clients/${CLIENT_ID}`]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/clients/:id" element={<ClientDetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("ClientDetailPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the client's name, status, and a no-active-authorization state", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable({
      id: CLIENT_ID,
      first_name: "Jordan",
      last_name: "Rivera",
      phone: "555-0100",
      email: null,
      address: null,
      care_notes: null,
      status: "active",
      client_requested_services: []
    });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("No active authorization for today.")).toBeInTheDocument();
  });

  it("shows the monthly cap and usage status for an active authorization", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable({
      id: CLIENT_ID,
      first_name: "Jordan",
      last_name: "Rivera",
      phone: "555-0100",
      email: null,
      address: null,
      care_notes: null,
      status: "active",
      client_requested_services: []
    });
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_client_authorizations") {
        return Promise.resolve({
          data: [
            {
              id: "99999999-9999-4999-8999-999999999999",
              client_id: CLIENT_ID,
              service_name: "Personal care",
              payer: "Medicaid",
              max_monthly_hours: 20,
              period_start: "2026-01-01",
              period_end: "2030-01-01",
              hours_used_this_month: 12,
              hours_scheduled_this_month: 10
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Cap this month")).toBeInTheDocument());
    expect(screen.getByText("20h")).toBeInTheDocument();
    expect(screen.getByText("22h")).toBeInTheDocument();
    expect(screen.getByText("Over limit")).toBeInTheDocument();
  });

  it("shows a not-found state for a missing client", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(null);
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Not found")).toBeInTheDocument());
  });

  it("saves client location, care needs, and requested services", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const { clientUpdateMock, clientUpdateEqMock, requestedServicesDeleteMock, requestedServicesInsertMock } =
      mockFromByTable(
        {
          id: CLIENT_ID,
          first_name: "Jordan",
          last_name: "Rivera",
          phone: null,
          email: null,
          address: null,
          care_notes: null,
          status: "active",
          client_requested_services: []
        },
        [{ id: "44444444-4444-4444-8444-444444444444", name: "Personal care", is_active: true }]
      );
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("City")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("City"), { target: { value: "San Diego" } });
    fireEvent.change(screen.getByLabelText("Care needs (comma-separated)"), {
      target: { value: "Hoyer lift, Dementia care" }
    });

    fireEvent.focus(screen.getByLabelText("Services"));
    await waitFor(() => expect(screen.getByRole("option", { name: "Personal care" })).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole("option", { name: "Personal care" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(clientUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          address_city: "San Diego",
          care_needs: ["Hoyer lift", "Dementia care"]
        })
      )
    );
    expect(clientUpdateEqMock).toHaveBeenCalledWith("id", CLIENT_ID);
    await waitFor(() => expect(requestedServicesDeleteMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(requestedServicesInsertMock).toHaveBeenCalledWith([
        expect.objectContaining({
          organization_id: ORG_ID,
          client_id: CLIENT_ID,
          service_id: "44444444-4444-4444-8444-444444444444"
        })
      ])
    );
  });

  it("switches to the Notes tab", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable({
      id: CLIENT_ID,
      first_name: "Jordan",
      last_name: "Rivera",
      phone: null,
      email: null,
      address: null,
      care_notes: "Prefers morning visits.",
      status: "active",
      client_requested_services: []
    });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Notes" }));

    await waitFor(() => expect(screen.getByText("Prefers morning visits.")).toBeInTheDocument());
  });

  it("links to the CareScore-ranked Schedule page from the Schedule tab when shifts.update is held", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable({
      id: CLIENT_ID,
      first_name: "Jordan",
      last_name: "Rivera",
      phone: null,
      email: null,
      address: null,
      care_notes: null,
      status: "active",
      client_requested_services: []
    });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    const link = await screen.findByText("Assign a caregiver (ranked by CareScore)");
    expect(link.closest("a")).toHaveAttribute("href", `/schedule?clientId=${CLIENT_ID}`);
  });

  it("links to a pre-filled add-authorization flow from the Authorizations tab", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable({
      id: CLIENT_ID,
      first_name: "Jordan",
      last_name: "Rivera",
      phone: null,
      email: null,
      address: null,
      care_notes: null,
      status: "active",
      client_requested_services: []
    });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Authorizations" }));

    const link = await screen.findByText("Add authorization for this client");
    expect(link.closest("a")).toHaveAttribute("href", `/authorizations?clientId=${CLIENT_ID}`);
  });

  it("hides the assign-a-caregiver link without shifts.update", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission !== "shifts.update")
    });
    mockFromByTable({
      id: CLIENT_ID,
      first_name: "Jordan",
      last_name: "Rivera",
      phone: null,
      email: null,
      address: null,
      care_notes: null,
      status: "active",
      client_requested_services: []
    });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    expect(screen.queryByText("Assign a caregiver (ranked by CareScore)")).not.toBeInTheDocument();
  });
});
