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
// .delete().eq().eq() and .insert(). skills/languages (the Location,
// languages & skills picker's option source) read via
// .select().eq().is().order() - branch by table name so both shapes are
// available; everything else in this file only touches supabase.rpc.
function mockAvailabilityFrom(rows: unknown[] = [], skills: unknown[] = [], languages: unknown[] = []) {
  const selectEq2 = vi.fn().mockResolvedValue({ data: rows, error: null });
  const selectEq1 = vi.fn(() => ({ eq: selectEq2 }));
  const selectMock = vi.fn(() => ({ eq: selectEq1 }));

  const deleteEq2 = vi.fn().mockResolvedValue({ error: null });
  const deleteEq1 = vi.fn(() => ({ eq: deleteEq2 }));
  const deleteMock = vi.fn(() => ({ eq: deleteEq1 }));

  const insertMock = vi.fn().mockResolvedValue({ error: null });

  function lookupSelectStub(lookupRows: unknown[]) {
    return vi.fn(() => ({
      eq: vi.fn(() => ({
        is: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: lookupRows, error: null }) }))
      }))
    }));
  }

  mockedFrom.mockImplementation((table: string) => {
    if (table === "skills") return { select: lookupSelectStub(skills) } as never;
    if (table === "languages") return { select: lookupSelectStub(languages) } as never;
    return { select: selectMock, delete: deleteMock, insert: insertMock } as never;
  });
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
    expect(screen.getByText("125% utilized")).toBeInTheDocument();
  });

  it("keeps the identity/score/tab header sticky so it stays visible while scrolling a long tab", async () => {
    // The header Card holds the caregiver's name, CareScore/GeoScore, and
    // the tab bar itself - previously it scrolled away with tab content,
    // so a long Schedule/Credentials/History list left the user with no
    // idea whose record they were even looking at partway down the page.
    mockedUseAuth.mockReturnValue({ user: { id: "other-user" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockAvailabilityFrom();

    renderPage();

    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());
    const headerCard = screen.getByText("Sam Caregiver").closest("div.sticky");
    expect(headerCard).not.toBeNull();
    expect(headerCard).toHaveClass("top-0");
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
    expect(screen.getByText("No expiration")).toBeInTheDocument();
    const link = screen.getByText("Add credential for this caregiver");
    expect(link.closest("a")).toHaveAttribute("href", `/credentials?caregiverId=${CAREGIVER_ID}`);
  });

  it("shows an error message on the Schedule tab when the shifts fetch fails, instead of a false empty state", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "other-user" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" }],
          error: null
        }) as never;
      }
      if (fn === "list_shifts") {
        return Promise.resolve({ data: null, error: new Error("network error") }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockAvailabilityFrom();

    renderPage();
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(screen.getByText("Could not load shifts for this caregiver.")).toBeInTheDocument());
    expect(screen.queryByText("No shifts for this caregiver.")).not.toBeInTheDocument();
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
    mockAvailabilityFrom([], [], [{ id: "lang-1", name: "Spanish", is_active: true }]);

    renderPage();
    await waitFor(() => expect(screen.getByLabelText("City")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("City"), { target: { value: "San Diego" } });

    fireEvent.focus(screen.getByLabelText("Languages"));
    await waitFor(() => expect(screen.getByRole("option", { name: "Spanish" })).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole("option", { name: "Spanish" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "set_caregiver_profile",
        expect.objectContaining({
          target_organization_id: ORG_ID,
          target_user_id: CAREGIVER_ID,
          new_address_city: "San Diego",
          new_languages: ["Spanish"]
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

  it("shows notes on the Notes tab, with an Edit action for membership.update", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "other-user" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" }],
          error: null
        }) as never;
      }
      if (fn === "get_caregiver_notes") {
        return Promise.resolve({ data: [{ notes: "Prefers morning shifts." }], error: null }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockAvailabilityFrom();

    renderPage();
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Notes" }));

    await waitFor(() => expect(screen.getByText("Prefers morning shifts.")).toBeInTheDocument());
    expect(
      screen.getByText("Internal notes staff keep about this caregiver - not visible to the caregiver themselves.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("hides the Notes edit action without membership.update", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "other-user" } } as never);
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn((permission: string) => permission !== "membership.update")
    });
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" }],
          error: null
        }) as never;
      }
      if (fn === "get_caregiver_notes") {
        return Promise.resolve({ data: [{ notes: "Prefers morning shifts." }], error: null }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockAvailabilityFrom();

    renderPage();
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Notes" }));

    await waitFor(() => expect(screen.getByText("Prefers morning shifts.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("saves edited notes", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "other-user" } } as never);
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" }],
          error: null
        }) as never;
      }
      if (fn === "get_caregiver_notes") {
        return Promise.resolve({ data: [{ notes: null }], error: null }) as never;
      }
      if (fn === "set_caregiver_notes") {
        return Promise.resolve({ data: null, error: null }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    mockAvailabilityFrom();

    renderPage();
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    await waitFor(() => expect(screen.getByText("No notes on file.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Had a great first shift." } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("set_caregiver_notes", {
        target_organization_id: ORG_ID,
        target_user_id: CAREGIVER_ID,
        new_notes: "Had a great first shift."
      })
    );
  });
});
