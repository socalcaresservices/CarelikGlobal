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
    userDisplayName: "Test User",
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

function lookupSelectStub(rows: unknown[]) {
  return vi.fn(() => ({
    eq: vi.fn(() => ({
      is: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: rows, error: null }) }))
    }))
  }));
}

// clients, services, skills, languages, and client_requested_services are
// all queried through supabase.from(), so the mock has to branch on the
// table name rather than returning one fixed chain for every call.
function mockFromByTable(
  client: unknown,
  services: ServiceOption[] = [],
  skills: ServiceOption[] = [],
  languages: ServiceOption[] = []
) {
  const clientSelectMock = mockClientRecord(client);
  const clientUpdateEqMock = vi.fn().mockResolvedValue({ error: null });
  const clientUpdateMock = vi.fn(() => ({ eq: clientUpdateEqMock }));

  const requestedServicesDeleteEqMock = vi.fn().mockResolvedValue({ error: null });
  const requestedServicesDeleteMock = vi.fn(() => ({ eq: requestedServicesDeleteEqMock }));
  const requestedServicesInsertMock = vi.fn().mockResolvedValue({ error: null });

  const assignmentInsertMock = vi.fn().mockResolvedValue({ error: null });
  const assignmentUpdateEqMock = vi.fn().mockResolvedValue({ error: null });
  const assignmentUpdateMock = vi.fn(() => ({ eq: assignmentUpdateEqMock }));

  mockedFrom.mockImplementation((table: string) => {
    if (table === "clients") {
      return { select: clientSelectMock, update: clientUpdateMock } as never;
    }
    if (table === "services") {
      return { select: lookupSelectStub(services) } as never;
    }
    if (table === "skills") {
      return { select: lookupSelectStub(skills) } as never;
    }
    if (table === "languages") {
      return { select: lookupSelectStub(languages) } as never;
    }
    if (table === "client_requested_services") {
      return { delete: requestedServicesDeleteMock, insert: requestedServicesInsertMock } as never;
    }
    if (table === "caregiver_assignments") {
      return { insert: assignmentInsertMock, update: assignmentUpdateMock } as never;
    }
    return {} as never;
  });

  return {
    clientUpdateMock,
    clientUpdateEqMock,
    requestedServicesDeleteMock,
    requestedServicesInsertMock,
    assignmentInsertMock,
    assignmentUpdateMock,
    assignmentUpdateEqMock
  };
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

  it("keeps the identity/authorization/tab header sticky so it stays visible while scrolling a long tab", async () => {
    // Same reasoning as caregiver-detail-page.tsx's equivalent test: the
    // header Card carries name, status, the authorization KPI row, and the
    // tab bar - it previously scrolled away with tab content instead of
    // staying put.
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
    const headerCard = screen.getByText("Jordan Rivera").closest("div.sticky");
    expect(headerCard).not.toBeNull();
    expect(headerCard).toHaveClass("top-0");
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
    // Committed (22h) already exceeds the cap (20h) - remaining clamps
    // at 0 rather than going negative.
    expect(screen.getByText("0h remaining")).toBeInTheDocument();
  });

  it("shows positive remaining hours when an authorization is under its cap", async () => {
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
              hours_used_this_month: 5,
              hours_scheduled_this_month: 3
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    // Cap 20h - (5h used + 3h scheduled) = 12h remaining.
    await waitFor(() => expect(screen.getByText("12h remaining")).toBeInTheDocument());
  });

  it("shows a not-found state for a missing client", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(null);
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Not found")).toBeInTheDocument());
  });

  it("shows an error message on the Authorizations tab when the fetch fails, instead of a false empty state", async () => {
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
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_client_authorizations") {
        return Promise.resolve({ data: null, error: new Error("network error") }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Authorizations" }));

    await waitFor(() =>
      expect(screen.getByText("Could not load authorizations for this client.")).toBeInTheDocument()
    );
    expect(screen.queryByText("No authorizations on file.")).not.toBeInTheDocument();
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
        [{ id: "44444444-4444-4444-8444-444444444444", name: "Personal care", is_active: true }],
        [{ id: "skill-1", name: "Dementia care", is_active: true }]
      );
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("City")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("City"), { target: { value: "San Diego" } });

    fireEvent.focus(screen.getByLabelText("Care needs"));
    await waitFor(() => expect(screen.getByRole("option", { name: "Dementia care" })).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole("option", { name: "Dementia care" }));

    fireEvent.focus(screen.getByLabelText("Services"));
    await waitFor(() => expect(screen.getByRole("option", { name: "Personal care" })).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole("option", { name: "Personal care" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(clientUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          address_city: "San Diego",
          care_needs: ["Dementia care"]
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

  it("shows ranked CareScore matches with a breakdown on the Matches tab", async () => {
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
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_caregiver_matches") {
        return Promise.resolve({
          data: [
            {
              caregiver_user_id: "caregiver-1",
              caregiver_name: "Sam Caregiver",
              match_score: 87,
              proximity_score: 30,
              language_score: 25,
              availability_score: 17,
              skills_score: 10,
              history_score: 5
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Matches" }));

    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());
    expect(screen.getByText("87")).toBeInTheDocument();
    expect(screen.getByText("Proximity 30/30")).toBeInTheDocument();
    expect(screen.getByText("Skills 10/10")).toBeInTheDocument();
    expect(screen.getByText("Sam Caregiver").closest("a")).toHaveAttribute("href", "/team/caregiver-1");
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

  it("lists caregiver assignments and assigns a new one on the Caregivers tab", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const { assignmentInsertMock } = mockFromByTable(
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
      [{ id: "44444444-4444-4444-8444-444444444444", code: "862", name: "Personal care", is_active: true } as never]
    );
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_caregiver_assignments") {
        return Promise.resolve({
          data: [
            {
              id: "assignment-1",
              caregiver_user_id: "caregiver-1",
              caregiver_name: "Sam Caregiver",
              client_id: CLIENT_ID,
              service_id: "44444444-4444-4444-8444-444444444444",
              service_name: "Personal care",
              service_code: "862",
              effective_start: "2026-01-01",
              effective_end: null,
              is_active: true
            }
          ],
          error: null
        }) as never;
      }
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: "caregiver-2", display_name: "Alex Caregiver", status: "active" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Caregivers" }));

    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());
    expect(screen.getByText("862 · Personal care")).toBeInTheDocument();
    expect(screen.getByText("Active", { selector: "span" })).toBeInTheDocument();

    fireEvent.focus(screen.getByLabelText("Caregiver"));
    await waitFor(() => expect(screen.getByRole("option", { name: "Alex Caregiver" })).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole("option", { name: "Alex Caregiver" }));

    fireEvent.focus(screen.getByLabelText("Service"));
    await waitFor(() => expect(screen.getByRole("option", { name: "862 · Personal care" })).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole("option", { name: "862 · Personal care" }));

    fireEvent.click(screen.getByRole("button", { name: "Assign" }));

    await waitFor(() =>
      expect(assignmentInsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          client_id: CLIENT_ID,
          caregiver_user_id: "caregiver-2",
          service_id: "44444444-4444-4444-8444-444444444444"
        })
      )
    );
  });

  it("revokes a caregiver assignment", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const { assignmentUpdateMock, assignmentUpdateEqMock } = mockFromByTable({
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
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_caregiver_assignments") {
        return Promise.resolve({
          data: [
            {
              id: "assignment-1",
              caregiver_user_id: "caregiver-1",
              caregiver_name: "Sam Caregiver",
              client_id: CLIENT_ID,
              service_id: "44444444-4444-4444-8444-444444444444",
              service_name: "Personal care",
              service_code: "862",
              effective_start: "2026-01-01",
              effective_end: null,
              is_active: true
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Caregivers" }));
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(assignmentUpdateMock).toHaveBeenCalledWith({ is_active: false }));
    expect(assignmentUpdateEqMock).toHaveBeenCalledWith("id", "assignment-1");
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
