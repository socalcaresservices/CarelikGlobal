import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { CaregiverDetailPage } from "./caregiver-detail-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CAREGIVER_ID = "44444444-4444-4444-8444-444444444444";

// caregiver_availability reads via .select().eq().eq(), writes via
// .delete().eq().eq() and .insert(). Everything else in this test file
// only touches supabase.rpc, so this is the one table that needs a
// .from() mock at all.
function mockAvailabilityFrom(rows: unknown[] = []) {
  const selectEq2 = vi.fn().mockResolvedValue({ data: rows, error: null });
  const selectEq1 = vi.fn(() => ({ eq: selectEq2 }));
  const selectMock = vi.fn(() => ({ eq: selectEq1 }));

  const deleteEq2 = vi.fn().mockResolvedValue({ error: null });
  const deleteEq1 = vi.fn(() => ({ eq: deleteEq2 }));
  const deleteMock = vi.fn(() => ({ eq: deleteEq1 }));

  const insertMock = vi.fn().mockResolvedValue({ error: null });

  mockedFrom.mockReturnValue({ select: selectMock, delete: deleteMock, insert: insertMock } as never);
  return { insertMock, deleteMock };
}

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

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/team/${CAREGIVER_ID}`]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/team/:id" element={<CaregiverDetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("CaregiverDetailPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without membership.read", () => {
    mockedUseAuth.mockReturnValue({ user: { id: "other-user" } } as never);
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => false) });
    mockAvailabilityFrom();

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("shows the member's name, role, and weekly hours", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "other-user" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" }],
          error: null
        }) as never;
      }
      if (fn === "get_caregiver_hours") {
        return Promise.resolve({
          data: [{ caregiver_user_id: CAREGIVER_ID, target_hours_per_week: 20, scheduled_hours: 25 }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockAvailabilityFrom();

    renderPage();

    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());
    expect(screen.getByText("(over target)")).toBeInTheDocument();
  });

  it("switches to the Credentials tab", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "other-user" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" }],
          error: null
        }) as never;
      }
      if (fn === "list_caregiver_credentials") {
        return Promise.resolve({
          data: [{ id: "cred-1", caregiver_user_id: CAREGIVER_ID, credential_type: "CPR", expires_at: null }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockAvailabilityFrom();

    renderPage();
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Credentials" }));

    await waitFor(() => expect(screen.getByText("CPR")).toBeInTheDocument());
  });

  it("saves caregiver location and skills", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: CAREGIVER_ID } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" }],
          error: null
        }) as never;
      }
      if (fn === "set_caregiver_profile") {
        return Promise.resolve({ data: null, error: null }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockAvailabilityFrom();

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("City")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("City"), { target: { value: "San Diego" } });
    fireEvent.change(screen.getByLabelText("Languages (comma-separated)"), { target: { value: "English, Spanish" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "set_caregiver_profile",
        expect.objectContaining({
          target_organization_id: ORG_ID,
          target_user_id: CAREGIVER_ID,
          new_address_city: "San Diego",
          new_languages: ["English", "Spanish"]
        })
      )
    );
  });

  it("shows saved weekly availability", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "other-user" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "caregiver", status: "active" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockAvailabilityFrom([{ day_of_week: "monday", start_time: "08:00:00", end_time: "12:00:00" }]);

    renderPage();
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());

    expect(screen.getByLabelText("Monday start time")).toHaveValue("08:00");
    expect(screen.getByLabelText("Monday end time")).toHaveValue("12:00");
  });

  it("saves updated weekly availability", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: CAREGIVER_ID } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "caregiver", status: "active" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    const { insertMock, deleteMock } = mockAvailabilityFrom([]);

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tuesday start time")).toBeInTheDocument());

    const tuesdayCheckbox = screen.getByLabelText("Tuesday") as HTMLInputElement;
    fireEvent.click(tuesdayCheckbox);
    fireEvent.change(screen.getByLabelText("Tuesday start time"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByLabelText("Tuesday end time"), { target: { value: "14:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith([
        {
          organization_id: ORG_ID,
          caregiver_user_id: CAREGIVER_ID,
          day_of_week: "tuesday",
          start_time: "08:00",
          end_time: "14:00"
        }
      ])
    );
  });

  it("rejects an end time that isn't after the start time", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: CAREGIVER_ID } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "caregiver", status: "active" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    const { insertMock } = mockAvailabilityFrom([]);

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Monday start time")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Monday"));
    fireEvent.change(screen.getByLabelText("Monday start time"), { target: { value: "14:00" } });
    fireEvent.change(screen.getByLabelText("Monday end time"), { target: { value: "08:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));

    await waitFor(() =>
      expect(screen.getByText("Monday's end time must be after its start time.")).toBeInTheDocument()
    );
    expect(insertMock).not.toHaveBeenCalled();
  });
});
