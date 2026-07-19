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
    mockedFrom.mockReturnValue({
      select: mockClientRecord({
        id: CLIENT_ID,
        first_name: "Jordan",
        last_name: "Rivera",
        phone: "555-0100",
        email: null,
        address: null,
        care_notes: null,
        status: "active"
      })
    } as never);
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("No active authorization for today.")).toBeInTheDocument();
  });

  it("shows a not-found state for a missing client", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedFrom.mockReturnValue({ select: mockClientRecord(null) } as never);
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Not found")).toBeInTheDocument());
  });

  it("switches to the Notes tab", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedFrom.mockReturnValue({
      select: mockClientRecord({
        id: CLIENT_ID,
        first_name: "Jordan",
        last_name: "Rivera",
        phone: null,
        email: null,
        address: null,
        care_notes: "Prefers morning visits.",
        status: "active"
      })
    } as never);
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Notes" }));

    await waitFor(() => expect(screen.getByText("Prefers morning visits.")).toBeInTheDocument());
  });
});
