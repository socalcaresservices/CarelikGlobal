import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { CandidatesPage } from "./candidates-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const ORG_ID = "11111111-1111-4111-8111-111111111111";

function baseOrganization(hasPermission = () => true) {
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
    hasPermission: vi.fn(hasPermission),
    loading: false
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("Candidates pipeline", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows a not-available message without applicants.read", () => {
    mockedUseOrganization.mockReturnValue(baseOrganization(() => false));
    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists candidates returned by list_candidates_v1", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "candidate-1",
          first_name: "Ashley",
          last_name: "Rivera",
          email: "ashley@example.com",
          phone: null,
          pipeline_stage: "application_received",
          source: "indeed",
          position_applied_for: "Caregiver",
          applied_at: "2026-08-13T12:00:00.000Z",
          desired_weekly_hours: 30,
          available_start_date: null,
          imported_at: null,
          created_at: "2026-08-13T12:00:00.000Z"
        }
      ],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Ashley Rivera")).toBeInTheDocument());
    expect(screen.getAllByText("Indeed")).not.toHaveLength(0);
    expect(screen.getAllByText("Caregiver").length).toBeGreaterThan(0);
    expect(screen.getByText("30h/week")).toBeInTheDocument();
    expect(mockedRpc).toHaveBeenCalledWith("list_candidates_v1", { target_organization_id: ORG_ID });
  });

  it("shows a pipeline funnel count per stage, unaffected by table filters", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "candidate-1",
          first_name: "Ashley",
          last_name: "Rivera",
          email: "ashley@example.com",
          phone: null,
          pipeline_stage: "screening",
          source: "indeed",
          position_applied_for: "Caregiver",
          applied_at: "2026-08-13T12:00:00.000Z",
          desired_weekly_hours: 30,
          available_start_date: null,
          imported_at: null,
          created_at: "2026-08-13T12:00:00.000Z"
        },
        {
          id: "candidate-2",
          first_name: "Jordan",
          last_name: "Diaz",
          email: "jordan@example.com",
          phone: null,
          pipeline_stage: "screening",
          source: "referral",
          position_applied_for: "Caregiver",
          applied_at: "2026-08-14T12:00:00.000Z",
          desired_weekly_hours: 20,
          available_start_date: null,
          imported_at: null,
          created_at: "2026-08-14T12:00:00.000Z"
        }
      ],
      error: null
    } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Ashley Rivera")).toBeInTheDocument());
    const funnelCard = screen.getByText("Pipeline funnel").closest("div")!;
    const screeningRow = within(funnelCard).getAllByText("Screening")[0]!.closest("div")!;
    expect(within(screeningRow).getByText("2")).toBeInTheDocument();
  });

  it("shows the empty Candidates state", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);
    renderPage();
    await waitFor(() => expect(screen.getByText("No candidates yet.")).toBeInTheDocument());
  });

  it("filters the pipeline by position", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [
        {
          id: "candidate-1",
          first_name: "Ashley",
          last_name: "Rivera",
          email: "ashley@example.com",
          phone: null,
          pipeline_stage: "application_received",
          source: "indeed",
          position_applied_for: "Caregiver",
          applied_at: "2026-08-13T12:00:00.000Z",
          desired_weekly_hours: 30,
          available_start_date: null,
          imported_at: null,
          created_at: "2026-08-13T12:00:00.000Z"
        },
        {
          id: "candidate-2",
          first_name: "Jordan",
          last_name: "Diaz",
          email: "jordan@example.com",
          phone: null,
          pipeline_stage: "application_received",
          source: "referral",
          position_applied_for: "Coordinator",
          applied_at: "2026-08-14T12:00:00.000Z",
          desired_weekly_hours: 20,
          available_start_date: null,
          imported_at: null,
          created_at: "2026-08-14T12:00:00.000Z"
        }
      ],
      error: null
    } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Ashley Rivera")).toBeInTheDocument());
    expect(screen.getByText("Jordan Diaz")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by position"), { target: { value: "Coordinator" } });

    expect(screen.queryByText("Ashley Rivera")).not.toBeInTheDocument();
    expect(screen.getByText("Jordan Diaz")).toBeInTheDocument();
    expect(screen.getByText("Position: Coordinator")).toBeInTheDocument();
  });
});

describe("Manual candidate creation", () => {
  afterEach(() => vi.clearAllMocks());

  async function openManualForm() {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "create_manual_candidate") return Promise.resolve({ data: "new-candidate-id", error: null }) as never;
      return Promise.resolve({ data: [], error: null }) as never;
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("No candidates yet.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Add candidate/ }));
    await waitFor(() => expect(screen.getByText("Add a candidate manually")).toBeInTheDocument());
  }

  it("requires first name, last name, Position, and at least one contact method before Save is enabled", async () => {
    await openManualForm();

    const saveButton = screen.getByRole("button", { name: "Create candidate" });
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Pat" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "WalkIn" } });
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "Caregiver" } });
    expect(saveButton).toBeDisabled(); // still no contact method

    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "555-111-2222" } });
    expect(saveButton).not.toBeDisabled();
  });

  it("reveals a Specify position field for Other and requires it before Save is enabled", async () => {
    await openManualForm();

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Pat" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "WalkIn" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "555-111-2222" } });
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "Other" } });

    const saveButton = screen.getByRole("button", { name: "Create candidate" });
    expect(screen.getByLabelText("Specify position")).toBeInTheDocument();
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Specify position"), { target: { value: "Overnight Companion" } });
    expect(saveButton).not.toBeDisabled();
  });

  it("creates a phone-only candidate (no email), shows a success message, and never sends a Position access-role change", async () => {
    await openManualForm();

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Pat" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "WalkIn" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "555-111-2222" } });
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "Manager" } });
    fireEvent.click(screen.getByRole("button", { name: "Create candidate" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith(
        "create_manual_candidate",
        expect.objectContaining({
          target_organization_id: ORG_ID,
          candidate_payload: expect.objectContaining({
            first_name: "Pat",
            last_name: "WalkIn",
            phone: "555-111-2222",
            position_applied_for: "Manager"
          })
        })
      )
    );
    // The RPC call carries only position_applied_for text - no role/permission
    // key is ever sent, so "Manager" here can never grant software access.
    const call = mockedRpc.mock.calls.find(([fn]) => fn === "create_manual_candidate")!;
    expect(call[1]).not.toHaveProperty("role");
    expect((call[1] as { candidate_payload: object }).candidate_payload).not.toHaveProperty("role");

    await waitFor(() =>
      expect(screen.getByText("Pat WalkIn was added to the candidate pipeline.")).toBeInTheDocument()
    );
  });

  it("shows a clear error message when candidate creation fails, instead of failing silently", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "create_manual_candidate") {
        return Promise.resolve({ data: null, error: new Error("A candidate with this email or phone already exists") }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("No candidates yet.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Add candidate/ }));
    await waitFor(() => expect(screen.getByText("Add a candidate manually")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Pat" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "WalkIn" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "555-111-2222" } });
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "Caregiver" } });
    fireEvent.click(screen.getByRole("button", { name: "Create candidate" }));

    await waitFor(() =>
      expect(screen.getByText("A candidate with this email or phone already exists")).toBeInTheDocument()
    );
  });

  it("disables Save while a create is in flight, preventing a duplicate candidate from a double-click", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    let resolveCreate: (value: unknown) => void = () => {};
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "create_manual_candidate") {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("No candidates yet.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Add candidate/ }));
    await waitFor(() => expect(screen.getByText("Add a candidate manually")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Pat" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "WalkIn" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "555-111-2222" } });
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "Caregiver" } });

    const saveButton = screen.getByRole("button", { name: "Create candidate" });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    await waitFor(() => expect(saveButton).toBeDisabled());
    const createCalls = mockedRpc.mock.calls.filter(([fn]) => fn === "create_manual_candidate");
    expect(createCalls).toHaveLength(1);

    resolveCreate({ data: "new-candidate-id", error: null });
  });
});
