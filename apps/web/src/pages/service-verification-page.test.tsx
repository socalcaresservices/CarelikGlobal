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
const SHIFT_ID = "55555555-5555-4555-8555-555555555555";
const VISIT_ID = "66666666-6666-4666-8666-666666666666";

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

const option = {
  shift_id: SHIFT_ID,
  client_id: "77777777-7777-4777-8777-777777777777",
  client_code: "CL-ABC123",
  caregiver_user_id: USER_ID,
  caregiver_name: "Jordan Rivera",
  service_id: "88888888-8888-4888-8888-888888888888",
  service_name: "Personal Care",
  authorization_id: "99999999-9999-4999-8999-999999999999",
  max_monthly_hours: 40,
  starts_at: "2026-08-09T13:00:00.000Z",
  ends_at: "2026-08-09T14:00:00.000Z",
  signed_minutes_this_month: 60
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
    if (fn === "get_active_service_visit") return Promise.resolve({ data: [], error: null }) as never;
    if (fn === "list_service_verification_options") return Promise.resolve({ data: [option], error: null }) as never;
    if (fn === "list_service_visits") return Promise.resolve({ data: [], error: null }) as never;
    return Promise.resolve({ data: null, error: null }) as never;
  });
}

describe("ServiceVerificationPage", () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue(baseOrganization() as never);
    // jsdom has no real canvas support - stub the two methods
    // SignaturePad actually calls so pointer-event tests exercise real
    // component logic instead of throwing on unimplemented canvas APIs.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,Zm9v");
    // jsdom doesn't implement pointer capture either.
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    // A test that uses fake timers and fails before reaching its own
    // cleanup would otherwise leak fake timers into every test that runs
    // after it in this file - restoring here unconditionally is cheap
    // insurance against that class of cross-test flakiness.
    vi.useRealTimers();
  });

  it("shows the shift picker and starts a visit", async () => {
    mockRpcImplementation();
    renderPage();

    await waitFor(() => expect(screen.getByLabelText("Assigned shift")).toBeInTheDocument());
    // Wait for the option itself, not just the <select> - setting a
    // select's value to an option that doesn't exist yet in the DOM is a
    // silent no-op, which would leave selectedShiftId (and therefore
    // selectedOption) stuck at "".
    await screen.findByRole("option", { name: /CL-ABC123/ });
    fireEvent.change(screen.getByLabelText("Assigned shift"), { target: { value: SHIFT_ID } });
    expect(await screen.findByText("CL-ABC123", { selector: "p" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Time in: start visit" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("start_service_visit", {
        target_organization_id: ORG_ID,
        target_shift_id: SHIFT_ID,
        visit_task_categories: [],
        visit_service_notes: null
      })
    );
  });

  it("shows the live elapsed timer and warns when the visit will exceed the authorization", async () => {
    // Real timers throughout - findByText's internal polling relies on
    // real setTimeout, which fake timers would otherwise starve. time_in
    // is set relative to the real Date.now() at render time so the
    // elapsed-seconds math is deterministic without mocking Date at all.
    const timeInMs = Date.now() - 5 * 60_000;

    mockRpcImplementation({
      get_active_service_visit: {
        data: [
          {
            visit_id: VISIT_ID,
            client_code: "CL-ABC123",
            service_name: "Personal Care",
            time_in: new Date(timeInMs).toISOString(),
            // 6 minutes authorized, already used 5 - a ~5-minute-elapsed
            // visit should already project over the cap.
            max_monthly_hours: 0.1,
            signed_minutes_this_month: 5
          }
        ],
        error: null
      }
    });

    renderPage();

    expect(await screen.findByText("Visit in progress")).toBeInTheDocument();
    // Allow a couple of seconds of slack for however long the test itself
    // took to reach this point, rather than pinning an exact "5:00".
    expect(screen.getByText(/^(4:5[5-9]|5:0[0-4])$/)).toBeInTheDocument();
    expect(screen.getByText(/will exceed the remaining authorized hours/)).toBeInTheDocument();
  });

  it("ends a visit and moves to the review step", async () => {
    mockRpcImplementation({
      get_active_service_visit: {
        data: [
          {
            visit_id: VISIT_ID,
            client_code: "CL-ABC123",
            service_name: "Personal Care",
            time_in: "2026-08-09T13:00:00.000Z",
            max_monthly_hours: 40,
            signed_minutes_this_month: 0
          }
        ],
        error: null
      },
      end_service_visit: {
        data: [
          { visit_id: VISIT_ID, worked_minutes: 45, time_in: "2026-08-09T13:00:00.000Z", time_out: "2026-08-09T13:45:00.000Z" }
        ],
        error: null
      }
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Time out: end visit" }));

    await waitFor(() => expect(screen.getByText("Caregiver review")).toBeInTheDocument());
    expect(screen.getByText("0.75 hours")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Continue to client sign-off" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I confirm that the visit information above/));
    fireEvent.click(screen.getByRole("button", { name: "Continue to client sign-off" }));

    expect(await screen.findByText("Confirm today’s visit")).toBeInTheDocument();
  });

  it("uploads the signature and signs the visit", async () => {
    mockRpcImplementation({
      get_active_service_visit: {
        data: [
          {
            visit_id: VISIT_ID,
            client_code: "CL-ABC123",
            service_name: "Personal Care",
            time_in: "2026-08-09T13:00:00.000Z",
            max_monthly_hours: 40,
            signed_minutes_this_month: 0
          }
        ],
        error: null
      },
      end_service_visit: {
        data: [
          { visit_id: VISIT_ID, worked_minutes: 45, time_in: "2026-08-09T13:00:00.000Z", time_out: "2026-08-09T13:45:00.000Z" }
        ],
        error: null
      },
      sign_service_visit: {
        data: [{ month_to_date_minutes: 45, remaining_minutes: 2355, authorization_status: "within_authorization" }],
        error: null
      }
    });
    const upload = vi.fn().mockResolvedValue({ data: { path: "x" }, error: null });
    mockedStorageFrom.mockReturnValue({ upload } as never);
    // jsdom has no fetch implementation for data: URLs - stub it so
    // submitSignature's fetch(signature).blob() resolves like a browser
    // would for the canvas data URL SignaturePad produces.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob(["fake-png"], { type: "image/png" })) })
    );

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Time out: end visit" }));
    await waitFor(() => expect(screen.getByText("Caregiver review")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/I confirm that the visit information above/));
    fireEvent.click(screen.getByRole("button", { name: "Continue to client sign-off" }));

    const canvas = await screen.findByLabelText("Signature pad");
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { clientX: 20, clientY: 20 });

    fireEvent.click(screen.getByLabelText(/I reviewed the visit information/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and sign" }));

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(
        `${ORG_ID}/${VISIT_ID}/client-signature.png`,
        expect.anything(),
        { contentType: "image/png", upsert: false }
      )
    );
    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("sign_service_visit", {
        target_visit_id: VISIT_ID,
        signer_role: "client",
        signature_storage_path: `${ORG_ID}/${VISIT_ID}/client-signature.png`
      })
    );
    expect(await screen.findByText("Visit signed successfully")).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("shows a sign-in prompt instead of the form when logged out", () => {
    mockedUseAuth.mockReturnValue({ ...authUser(), user: null });
    mockRpcImplementation();

    renderPage();

    expect(screen.getByText("Sign in to use Service Verification.")).toBeInTheDocument();
  });
});
