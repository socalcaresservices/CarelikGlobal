import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { ClientOperationsDashboard } from "./client-operations-dashboard";

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: vi.fn() },
}));

const mockedRpc = vi.mocked(supabase.rpc);
const row = {
  client_id: "client-1",
  client_name: "Jamie Smith",
  client_code: "CL-123",
  caregiver_display_code: "Oak Tree",
  client_status: "active",
  location: "Temecula, CA",
  service_id: "service-1",
  service_name: "Respite",
  max_monthly_hours: 80,
  authorization_period_end: "2026-12-31",
  delivered_minutes: 600,
  assigned_caregivers: ["Jordan Rivera"],
  requested_windows: [
    { day: "monday", start: "09:00:00", end: "13:00:00", notes: null },
  ],
  top_match_name: "Jordan Rivera",
  top_match_score: 91,
  gap_reason: null,
  gap_notes: null,
  gap_resolved: false,
};

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ClientOperationsDashboard
          organizationId="org-1"
          canManage
          canSchedule
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("ClientOperationsDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRpc.mockImplementation((name: string) => {
      if (name === "list_client_operations") {
        return Promise.resolve({ data: [row], error: null }) as never;
      }
      return Promise.resolve({ data: "review-1", error: null }) as never;
    });
  });

  it("shows authorized, delivered, remaining, forecast, assignment, and CareScore data", async () => {
    renderDashboard();

    expect(await screen.findByText("Jamie Smith")).toBeInTheDocument();
    expect(screen.getByText("Care ID Oak Tree")).toBeInTheDocument();
    expect(screen.getByText("Assigned: Jordan Rivera")).toBeInTheDocument();
    expect(screen.getByText("Jordan Rivera · 91")).toBeInTheDocument();
    expect(screen.getByText("80 hrs")).toBeInTheDocument();
    expect(screen.getAllByText("10 hrs").length).toBeGreaterThan(0);
    expect(screen.getByText(/Mon 9:00 AM–1:00 PM/)).toBeInTheDocument();
  });

  it("records a manager's monthly shortfall reason", async () => {
    renderDashboard();
    fireEvent.click(
      await screen.findByRole("button", { name: "Record reason" }),
    );
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "client_unavailable" },
    });
    fireEvent.change(screen.getByLabelText("Manager notes"), {
      target: { value: "Family traveled this week" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save reason" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "record_client_service_gap_review",
        expect.objectContaining({
          target_client_id: "client-1",
          target_service_id: "service-1",
          target_reason: "client_unavailable",
          target_notes: "Family traveled this week",
        }),
      ),
    );
  });
});
