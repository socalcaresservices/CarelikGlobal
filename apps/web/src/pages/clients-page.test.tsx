import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ClientsPage } from "./clients-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

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

function mockReadableClients(rows: unknown[]) {
  const orderMock = vi.fn().mockResolvedValue({ data: rows, error: null });
  const eqMock = vi.fn(() => ({ order: orderMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  return selectMock;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ClientsPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("ClientsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without clients.read", () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => false) });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists clients but hides the add form without clients.update", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "clients.read")
    });
    const selectMock = mockReadableClients([
      {
        id: "22222222-2222-4222-8222-222222222222",
        first_name: "Jordan",
        last_name: "Rivera",
        phone: "555-0100",
        email: null,
        address: null,
        care_notes: null,
        status: "active"
      }
    ]);
    mockedFrom.mockReturnValue({ select: selectMock } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    expect(screen.queryByText("Add a client")).not.toBeInTheDocument();
  });

  it("filters the list by status and clears the filter", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission === "clients.read")
    });
    const selectMock = mockReadableClients([
      {
        id: "22222222-2222-4222-8222-222222222222",
        first_name: "Jordan",
        last_name: "Rivera",
        phone: null,
        email: null,
        address: null,
        care_notes: null,
        status: "active"
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        first_name: "Casey",
        last_name: "Nolan",
        phone: null,
        email: null,
        address: null,
        care_notes: null,
        status: "discharged"
      }
    ]);
    mockedFrom.mockReturnValue({ select: selectMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    expect(screen.getByText("Casey Nolan")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "discharged" } });

    expect(screen.queryByText("Jordan Rivera")).not.toBeInTheDocument();
    expect(screen.getByText("Casey Nolan")).toBeInTheDocument();
    expect(screen.getByText("Status: discharged")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Clear all"));

    expect(screen.getByText("Jordan Rivera")).toBeInTheDocument();
    expect(screen.getByText("Casey Nolan")).toBeInTheDocument();
    expect(screen.queryByText("Status: discharged")).not.toBeInTheDocument();
  });

  it("adds a new client", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    const selectMock = mockReadableClients([]);
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockedFrom.mockReturnValue({ select: selectMock, insert: insertMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Add a client")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Jordan" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Rivera" } });
    fireEvent.click(screen.getByRole("button", { name: "Add client" }));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          first_name: "Jordan",
          last_name: "Rivera",
          status: "active"
        })
      )
    );
  });

  it("soft-deletes a client via Remove", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    const selectMock = mockReadableClients([
      {
        id: "22222222-2222-4222-8222-222222222222",
        first_name: "Jordan",
        last_name: "Rivera",
        phone: null,
        email: null,
        address: null,
        care_notes: null,
        status: "active"
      }
    ]);
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    mockedFrom.mockReturnValue({ select: selectMock, update: updateMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Remove")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }))
    );
    expect(eqMock).toHaveBeenCalledWith("id", "22222222-2222-4222-8222-222222222222");
  });
});
