import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { StaffVisitsPage } from "./staff-visits-page";

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
const SERVICE_ID = "33333333-3333-4333-8333-333333333333";

function baseOrganization() {
  return {
    activeOrganizationId: ORG_ID,
    activeOrganization: { id: ORG_ID, displayName: "Acme Care" },
    hasPermission: vi.fn(() => false)
  };
}

const assignedOption = {
  assignment_id: "assignment-1",
  client_id: CLIENT_ID,
  client_code: "SCS-C-00544",
  client_name: "Jordan Rivera",
  service_id: SERVICE_ID,
  service_code: "862",
  service_name: "Personal care",
  service_color: "#0F8B8D",
  authorization_id: "auth-1",
  authorization_period_start: "2026-01-01",
  authorization_period_end: "2026-12-31",
  max_monthly_hours: 40,
  hours_used_this_month: 10,
  hours_scheduled_this_month: 5
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/" element={<StaffVisitsPage />} />
          <Route path="/service-verification" element={<div>verification page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("StaffVisitsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows an empty state when the caregiver has no assignments", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization() as never);
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/don't have any assigned clients yet/)).toBeInTheDocument()
    );
  });

  it("walks through client, service, date/time, and review, then schedules the visit", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization() as never);
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_my_schedulable_assignments") {
        return Promise.resolve({ data: [assignedOption], error: null }) as never;
      }
      if (fn === "schedule_caregiver_visit") {
        return Promise.resolve({
          data: [{ shift_id: "shift-1", visit_number: "SCS-V-20260809-4F7K" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Jordan Rivera"));

    await waitFor(() => expect(screen.getByText("862 · Personal care")).toBeInTheDocument());
    expect(screen.getByText(/40h\/mo/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("862 · Personal care"));

    await waitFor(() => expect(screen.getByLabelText("Starts")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.getByText("Review visit")).toBeInTheDocument());
    expect(screen.getByText("SCS-C-00544")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm and schedule" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "schedule_caregiver_visit",
        expect.objectContaining({
          target_organization_id: ORG_ID,
          target_client_id: CLIENT_ID,
          target_service_id: SERVICE_ID
        })
      )
    );
    await waitFor(() => expect(screen.getByText("Visit scheduled")).toBeInTheDocument());
    expect(screen.getByText("SCS-V-20260809-4F7K")).toBeInTheDocument();

    fireEvent.click(screen.getByText("View visit"));
    expect(screen.getByText("verification page")).toBeInTheDocument();
  });

  it("lets a caregiver tap a completed step to jump back", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization() as never);
    mockedRpc.mockResolvedValue({ data: [assignedOption], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Jordan Rivera"));
    await waitFor(() => expect(screen.getByText("862 · Personal care")).toBeInTheDocument());
    fireEvent.click(screen.getByText("862 · Personal care"));
    await waitFor(() => expect(screen.getByLabelText("Starts")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Go back to step 1: Client" }));
    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
  });

  it("shows a live duration and remaining-hours preview while picking a time, flagging when it exceeds what's left", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization() as never);
    mockedRpc.mockResolvedValue({ data: [assignedOption], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Jordan Rivera"));
    await waitFor(() => expect(screen.getByText("862 · Personal care")).toBeInTheDocument());
    fireEvent.click(screen.getByText("862 · Personal care"));
    await waitFor(() => expect(screen.getByLabelText("Starts")).toBeInTheDocument());

    // assignedOption: 40h/mo cap, 10h used + 5h scheduled = 25h available.
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-09-01T09:00" } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2026-09-01T11:00" } });
    await waitFor(() => expect(screen.getByText(/2h/)).toBeInTheDocument());
    expect(screen.getByText(/25h/)).toBeInTheDocument();
    expect(screen.queryByText(/exceeds what's left/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2026-09-02T12:00" } });
    await waitFor(() => expect(screen.getByText(/exceeds what's left/)).toBeInTheDocument());
  });

  it("disables a service with no active authorization and shows why", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization() as never);
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_my_schedulable_assignments") {
        return Promise.resolve({
          data: [{ ...assignedOption, authorization_id: null, max_monthly_hours: null }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Jordan Rivera"));

    await waitFor(() =>
      expect(screen.getByText("No active authorization - contact your agency administrator.")).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: /862 · Personal care/ })).toBeDisabled();
  });

  it("shows the server's error message when scheduling is rejected (e.g. cap reached)", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization() as never);
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_my_schedulable_assignments") {
        return Promise.resolve({ data: [assignedOption], error: null }) as never;
      }
      if (fn === "schedule_caregiver_visit") {
        return Promise.resolve({
          data: null,
          error: new Error("Maximum authorized hours reached. Contact your agency administrator.")
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Jordan Rivera"));
    await waitFor(() => expect(screen.getByText("862 · Personal care")).toBeInTheDocument());
    fireEvent.click(screen.getByText("862 · Personal care"));
    await waitFor(() => expect(screen.getByLabelText("Starts")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("Review visit")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Confirm and schedule" }));

    await waitFor(() =>
      expect(screen.getByText("Maximum authorized hours reached. Contact your agency administrator.")).toBeInTheDocument()
    );
    expect(screen.queryByText("Visit scheduled")).not.toBeInTheDocument();
  });
});
