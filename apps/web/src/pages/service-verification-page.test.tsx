import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ServiceVerificationPage } from "./service-verification-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    storage: { from: vi.fn() }
  }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedStorageFrom = vi.mocked(supabase.storage.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_ID = "77777777-7777-4777-8777-777777777777";
const SERVICE_ID = "88888888-8888-4888-8888-888888888888";
const SHIFT_ID = "22222222-2222-4222-8222-222222222222";
const VISIT_ID = "66666666-6666-4666-8666-666666666666";
const CLIENT_CODE = "CL-ABC123";

function authUser() {
  return {
    user: { id: USER_ID } as never,
    session: {} as never,
    loading: false,
    signInWithGithub: vi.fn(),
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updatePassword: vi.fn(),
    signOut: vi.fn()
  };
}

function baseOrganization(overrides: Record<string, unknown> = {}) {
  return {
    activeOrganizationId: ORG_ID,
    activeOrganization: { id: ORG_ID, displayName: "Acme Care" },
    hasPermission: vi.fn(() => false),
    ...overrides
  };
}

const foundClient = { client_id: CLIENT_ID, client_code: CLIENT_CODE };

const startableShift = {
  shift_id: SHIFT_ID,
  visit_number: "ACME-V-20260813-AB12",
  client_id: CLIENT_ID,
  client_code: CLIENT_CODE,
  client_name: "Darby Crash",
  service_id: SERVICE_ID,
  service_code: "862",
  service_name: "Respite Care",
  service_color: "#4f46e5",
  authorization_id: "99999999-9999-4999-8999-999999999999",
  max_monthly_hours: 80,
  hours_used_this_month: 24.5,
  hours_scheduled_this_month: 2,
  starts_at: "2026-08-13T21:30:00.000Z",
  ends_at: "2026-08-13T23:30:00.000Z"
};

const activeVisit = {
  visit_id: VISIT_ID,
  visit_number: "ACME-V-20260813-AB12",
  client_code: CLIENT_CODE,
  client_name: "Darby Crash",
  service_code: "862",
  service_name: "Respite Care",
  scheduled_starts_at: "2026-08-13T21:30:00.000Z",
  scheduled_ends_at: "2026-08-13T23:30:00.000Z",
  time_in: "2026-08-13T21:30:00.000Z",
  max_monthly_hours: 80,
  signed_minutes_this_month: 1470
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ServiceVerificationPage />
    </QueryClientProvider>
  );
}

function mockRpcImplementation(overrides: Record<string, unknown> = {}) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn in overrides) return Promise.resolve(overrides[fn]) as never;
    if (fn === "get_active_service_visit_v2") return Promise.resolve({ data: [], error: null }) as never;
    if (fn === "find_client_by_code") return Promise.resolve({ data: [foundClient], error: null }) as never;
    if (fn === "list_startable_shifts_for_client") return Promise.resolve({ data: [startableShift], error: null }) as never;
    if (fn === "list_service_visits") return Promise.resolve({ data: [], error: null }) as never;
    if (fn === "start_service_visit") return Promise.resolve({ data: VISIT_ID, error: null }) as never;
    return Promise.resolve({ data: null, error: null }) as never;
  });
}

describe("ServiceVerificationPage v2", () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue(baseOrganization() as never);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,Zm9v");
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("only starts an administrator-scheduled shift and keeps service code paired with service", async () => {
    mockRpcImplementation();
    renderPage();

    fireEvent.change(await screen.findByLabelText("Client code"), { target: { value: CLIENT_CODE } });
    fireEvent.click(screen.getByRole("button", { name: "Verify client" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("find_client_by_code", {
        target_organization_id: ORG_ID,
        target_client_code: CLIENT_CODE
      })
    );

    expect(await screen.findByText("Darby Crash")).toBeInTheDocument();
    expect(screen.getByText("862")).toBeInTheDocument();
    expect(screen.getByText("Respite Care")).toBeInTheDocument();
    expect(screen.getByText(/Caregivers cannot backdate or edit it/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start visit now" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("start_service_visit", {
        target_organization_id: ORG_ID,
        target_shift_id: SHIFT_ID,
        visit_task_categories: [],
        visit_service_notes: null
      })
    );
  });

  it("blocks the caregiver when no administrator-scheduled visit exists", async () => {
    mockRpcImplementation({ list_startable_shifts_for_client: { data: [], error: null } });
    renderPage();

    fireEvent.change(await screen.findByLabelText("Client code"), { target: { value: CLIENT_CODE } });
    fireEvent.click(screen.getByRole("button", { name: "Verify client" }));

    expect(await screen.findByText("No scheduled visit is available for this client today.")).toBeInTheDocument();
    expect(screen.getByText(/Extra visits must be added by an agency administrator/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start visit now" })).not.toBeInTheDocument();
  });

  it("shows a live server-timed visit without caregiver cancel or time-edit controls", async () => {
    const timeInMs = Date.now() - 5 * 60_000;
    mockRpcImplementation({
      get_active_service_visit_v2: {
        data: [{ ...activeVisit, time_in: new Date(timeInMs).toISOString() }],
        error: null
      }
    });

    renderPage();

    expect(await screen.findByText("Visit in progress")).toBeInTheDocument();
    expect(screen.getByText(/^(4:5[5-9]|5:0[0-4])$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End visit now" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel visit/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/time in/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/time out/i)).not.toBeInTheDocument();
  });

  it("combines time-out, client confirmation, and caregiver attestation into one confirmation screen", async () => {
    mockRpcImplementation({
      get_active_service_visit_v2: { data: [activeVisit], error: null },
      end_service_visit: {
        data: [
          {
            visit_id: VISIT_ID,
            worked_minutes: 120,
            time_in: "2026-08-13T21:30:00.000Z",
            time_out: "2026-08-13T23:30:00.000Z"
          }
        ],
        error: null
      }
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "End visit now" }));

    await waitFor(() => expect(screen.getByText("Confirm visit")).toBeInTheDocument());
    expect(screen.getByText("2 hours")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Draw signature/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Type name/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Verbal confirmation/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Assisted mark/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Unable to confirm/ })).toBeInTheDocument();
  });

  it("submits a typed client confirmation without requiring a signature image", async () => {
    mockRpcImplementation({
      get_active_service_visit_v2: { data: [activeVisit], error: null },
      end_service_visit: {
        data: [
          {
            visit_id: VISIT_ID,
            worked_minutes: 120,
            time_in: "2026-08-13T21:30:00.000Z",
            time_out: "2026-08-13T23:30:00.000Z"
          }
        ],
        error: null
      },
      confirm_service_visit: {
        data: [
          {
            status: "signed",
            month_to_date_minutes: 1590,
            remaining_minutes: 3210,
            authorization_status: "within_authorization"
          }
        ],
        error: null
      }
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "End visit now" }));
    await screen.findByText("Confirm visit");

    fireEvent.click(screen.getByRole("button", { name: /Type name/ }));
    fireEvent.change(screen.getByLabelText("Name of person confirming"), { target: { value: "J. Crash" } });
    fireEvent.change(screen.getByLabelText(/Relationship/), { target: { value: "Client" } });
    fireEvent.click(screen.getByLabelText(/I confirm that I provided the service/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & submit visit" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("confirm_service_visit", {
        target_visit_id: VISIT_ID,
        signer_role: "client",
        confirmation_method: "typed",
        signature_storage_path: null,
        typed_signer_name: "J. Crash",
        signer_relationship: "Client",
        confirmation_reason: null
      })
    );
    expect(mockedStorageFrom).not.toHaveBeenCalled();
    expect(await screen.findByText("Visit submitted")).toBeInTheDocument();
  });

  it("uploads a drawn signature and locks the visit", async () => {
    mockRpcImplementation({
      get_active_service_visit_v2: { data: [activeVisit], error: null },
      end_service_visit: {
        data: [
          {
            visit_id: VISIT_ID,
            worked_minutes: 120,
            time_in: "2026-08-13T21:30:00.000Z",
            time_out: "2026-08-13T23:30:00.000Z"
          }
        ],
        error: null
      },
      confirm_service_visit: {
        data: [
          {
            status: "signed",
            month_to_date_minutes: 1590,
            remaining_minutes: 3210,
            authorization_status: "within_authorization"
          }
        ],
        error: null
      }
    });

    const upload = vi.fn().mockResolvedValue({ data: { path: "x" }, error: null });
    mockedStorageFrom.mockReturnValue({ upload } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob(["fake-png"], { type: "image/png" })) })
    );

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "End visit now" }));
    await screen.findByText("Confirm visit");

    const canvas = screen.getByLabelText("Signature pad");
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByLabelText(/I confirm that I provided the service/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & submit visit" }));

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(
        `${ORG_ID}/${VISIT_ID}/client-signature.png`,
        expect.anything(),
        { contentType: "image/png", upsert: false }
      )
    );
    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("confirm_service_visit", {
        target_visit_id: VISIT_ID,
        signer_role: "client",
        confirmation_method: "draw",
        signature_storage_path: `${ORG_ID}/${VISIT_ID}/client-signature.png`,
        typed_signer_name: null,
        signer_relationship: null,
        confirmation_reason: null
      })
    );
  });

  it("sends an unconfirmed visit to administrator review with a required reason", async () => {
    mockRpcImplementation({
      get_active_service_visit_v2: { data: [activeVisit], error: null },
      end_service_visit: {
        data: [
          {
            visit_id: VISIT_ID,
            worked_minutes: 120,
            time_in: "2026-08-13T21:30:00.000Z",
            time_out: "2026-08-13T23:30:00.000Z"
          }
        ],
        error: null
      },
      confirm_service_visit: {
        data: [
          {
            status: "administrator_review",
            month_to_date_minutes: 1590,
            remaining_minutes: 3210,
            authorization_status: "within_authorization"
          }
        ],
        error: null
      }
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "End visit now" }));
    await screen.findByText("Confirm visit");

    fireEvent.click(screen.getByRole("button", { name: /Unable to confirm/ }));
    expect(screen.getByRole("button", { name: "Confirm & submit visit" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Why could confirmation not be obtained?"), {
      target: { value: "Client was asleep when the caregiver left." }
    });
    fireEvent.click(screen.getByLabelText(/I confirm that I provided the service/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & submit visit" }));

    expect(await screen.findByText("Pending review")).toBeInTheDocument();
  });

  it("shows a sign-in prompt when logged out", () => {
    mockedUseAuth.mockReturnValue({ ...authUser(), user: null });
    mockRpcImplementation();
    renderPage();
    expect(screen.getByText("Sign in to use Service Verification.")).toBeInTheDocument();
  });
});
