import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { GlobalSearch } from "./global-search";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const CAREGIVER_ID = "44444444-4444-4444-8444-444444444444";

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

function LocationDisplay() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderSearch() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <QueryClientProvider client={queryClient}>
        <GlobalSearch />
        <Routes>
          <Route path="*" element={<LocationDisplay />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("GlobalSearch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not search until at least 2 characters are typed", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    renderSearch();

    fireEvent.change(screen.getByLabelText("Search everything"), { target: { value: "j" } });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("shows a no-matches message when the search returns nothing", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderSearch();
    fireEvent.change(screen.getByLabelText("Search everything"), { target: { value: "zzz" } });

    await waitFor(() => expect(screen.getByText('No matches for "zzz".')).toBeInTheDocument());
  });

  it("shows grouped, labelled results and navigates to a client on selection", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [
        { result_type: "client", entity_id: CLIENT_ID, title: "Jordan Rivera", subtitle: "555-0100" },
        { result_type: "caregiver", entity_id: CAREGIVER_ID, title: "Sam Caregiver", subtitle: "Staff" }
      ],
      error: null
    } as never);

    renderSearch();
    fireEvent.change(screen.getByLabelText("Search everything"), { target: { value: "ri" } });

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    expect(screen.getByText("Client")).toBeInTheDocument();
    expect(screen.getByText("Caregiver")).toBeInTheDocument();
    expect(screen.getByText("Sam Caregiver")).toBeInTheDocument();

    expect(mockedRpc).toHaveBeenCalledWith("global_search", {
      target_organization_id: ORG_ID,
      search_query: "ri"
    });

    fireEvent.click(screen.getByText("Jordan Rivera"));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/clients/${CLIENT_ID}`));
  });

  it("shows a service result and navigates to Authorizations on selection", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const SERVICE_ID = "66666666-6666-4666-8666-666666666666";
    mockedRpc.mockResolvedValue({
      data: [{ result_type: "service", entity_id: SERVICE_ID, title: "Personal care", subtitle: "Active service" }],
      error: null
    } as never);

    renderSearch();
    fireEvent.change(screen.getByLabelText("Search everything"), { target: { value: "personal" } });

    await waitFor(() => expect(screen.getByText("Personal care")).toBeInTheDocument());
    expect(screen.getByText("Service")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Personal care"));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/authorizations"));
  });

  it("shows a loading state while searching and an error state on failure", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    let resolveRpc: (value: unknown) => void = () => {};
    mockedRpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRpc = resolve;
        }) as never
    );

    renderSearch();
    fireEvent.change(screen.getByLabelText("Search everything"), { target: { value: "ri" } });

    await waitFor(() => expect(screen.getByText("Searching…")).toBeInTheDocument());

    resolveRpc({ data: null, error: new Error("boom") });

    await waitFor(() => expect(screen.getByText("Could not search.")).toBeInTheDocument());
  });

  it("navigates the results with arrow keys and selects with Enter", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [
        { result_type: "client", entity_id: CLIENT_ID, title: "Jordan Rivera", subtitle: "555-0100" },
        { result_type: "caregiver", entity_id: CAREGIVER_ID, title: "Sam Caregiver", subtitle: "Staff" }
      ],
      error: null
    } as never);

    renderSearch();
    const input = screen.getByLabelText("Search everything");
    fireEvent.change(input, { target: { value: "ri" } });

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/team/${CAREGIVER_ID}`));
  });

  it("closes the dropdown on Escape without navigating", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [{ result_type: "client", entity_id: CLIENT_ID, title: "Jordan Rivera", subtitle: null }],
      error: null
    } as never);

    renderSearch();
    const input = screen.getByLabelText("Search everything");
    fireEvent.change(input, { target: { value: "ri" } });
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByText("Jordan Rivera")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });

  it("closes the dropdown when clicking outside", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [{ result_type: "client", entity_id: CLIENT_ID, title: "Jordan Rivera", subtitle: null }],
      error: null
    } as never);

    renderSearch();
    fireEvent.change(screen.getByLabelText("Search everything"), { target: { value: "ri" } });
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());

    fireEvent.mouseDown(document.body);

    await waitFor(() => expect(screen.queryByText("Jordan Rivera")).not.toBeInTheDocument());
  });
});
