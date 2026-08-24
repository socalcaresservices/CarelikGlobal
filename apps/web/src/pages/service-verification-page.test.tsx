import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ServiceVerificationPage } from "./service-verification-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({
  useOrganization: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    storage: { from: vi.fn() },
  },
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedStorageFrom = vi.mocked(supabase.storage.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_ID = "77777777-7777-4777-8777-777777777777";
const SECOND_CLIENT_ID = "77777777-7777-4777-8777-777777777778";
const SERVICE_ID = "88888888-8888-4888-8888-888888888888";
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
    signOut: vi.fn(),
  };
}

function baseOrganization() {
  return {
    activeOrganizationId: ORG_ID,
    activeOrganization: { id: ORG_ID, displayName: "Acme Care", logoUrl: null },
    hasPermission: vi.fn(() => false),
  };
}

const assignedClients = [
  {
    client_id: CLIENT_ID,
    client_code: "C-104",
    next_scheduled_starts_at: "2026-08-24T21:30:00.000Z",
    next_scheduled_ends_at: "2026-08-24T23:30:00.000Z",
    active_service_count: 1,
  },
  {
    client_id: SECOND_CLIENT_ID,
    client_code: "C-207",
    next_scheduled_starts_at: "2026-08-25T00:00:00.000Z",
    next_scheduled_ends_at: "2026-08-25T02:00:00.000Z",
    active_service_count: 9,
  },
];

const authorizedService = {
  service_id: SERVICE_ID,
  service_code: "862",
  service_name: "Respite Care",
  service_color: "#4f46e5",
  authorization_id: "99999999-9999-4999-8999-999999999999",
  max_monthly_hours: 80,
  hours_used_this_month: 24.5,
  hours_scheduled_this_month: 2,
};

const activeVisit = {
  visit_id: VISIT_ID,
  visit_number: "OGEV-V-20260824-AB12",
  client_code: "C-104",
  service_code: "862",
  service_name: "Respite Care",
  scheduled_starts_at: "2026-08-24T21:30:00.000Z",
  scheduled_ends_at: "2026-08-24T23:30:00.000Z",
  time_in: "2026-08-24T21:30:00.000Z",
  time_out: null,
  worked_minutes: null,
  visit_status: "draft",
  max_monthly_hours: 80,
  confirmed_minutes_this_month: 1470,
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ServiceVerificationPage />
    </QueryClientProvider>,
  );
}

function mockRpcImplementation(overrides: Record<string, unknown> = {}) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn in overrides) return Promise.resolve(overrides[fn]) as never;
    if (fn === "get_active_service_visit_v3")
      return Promise.resolve({ data: [], error: null }) as never;
    if (fn === "list_assigned_visit_clients")
      return Promise.resolve({ data: assignedClients, error: null }) as never;
    if (fn === "list_authorized_services_for_client") {
      return Promise.resolve({
        data: [authorizedService],
        error: null,
      }) as never;
    }
    if (fn === "start_ad_hoc_service_visit")
      return Promise.resolve({ data: VISIT_ID, error: null }) as never;
    return Promise.resolve({ data: null, error: null }) as never;
  });
}

async function openConfirmation() {
  fireEvent.click(await screen.findByRole("button", { name: /Sign out now/ }));
  await screen.findByRole("heading", {
    name: "Client or guardian confirmation",
  });
}

describe("ServiceVerificationPage v3", () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue(baseOrganization() as never);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(
      () => "data:image/png;base64,Zm9v",
    );
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows only assigned client codes and never renders a client legal name", async () => {
    mockRpcImplementation();
    renderPage();

    const picker = await screen.findByLabelText("Assigned client");
    await screen.findByRole("option", { name: /Client C-104/ });
    expect(picker).toHaveTextContent("Client C-104");
    expect(picker).toHaveTextContent("Client C-207");
    expect(picker).toHaveTextContent("9 active services");
    expect(screen.queryByText("Darby Crash")).not.toBeInTheDocument();
    expect(
      screen.getByText("Service verification · Not EVV"),
    ).toBeInTheDocument();
    expect(screen.getByText("No GPS")).toBeInTheDocument();

    expect(mockedRpc).toHaveBeenCalledWith("list_assigned_visit_clients", {
      target_organization_id: ORG_ID,
    });
  });

  it("auto-selects one authorized service and starts exactly that client-service pair", async () => {
    mockRpcImplementation();
    renderPage();

    await screen.findByRole("option", { name: /Client C-104/ });
    fireEvent.change(screen.getByLabelText("Assigned client"), {
      target: { value: CLIENT_ID },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Service for this visit")).toHaveValue(
        SERVICE_ID,
      ),
    );
    expect(screen.getAllByText("862 · Respite Care")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Sign in now/ }));
    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("start_ad_hoc_service_visit", {
        target_organization_id: ORG_ID,
        target_client_id: CLIENT_ID,
        target_service_id: SERVICE_ID,
        visit_task_categories: [],
        visit_service_notes: null,
      }),
    );
  });

  it("requires an explicit choice when a client has nine services", async () => {
    const services = Array.from({ length: 9 }, (_, index) => ({
      ...authorizedService,
      service_id: `88888888-8888-4888-8888-88888888888${index}`,
      service_code: `S-${index + 1}`,
      service_name: `Service ${index + 1}`,
    }));
    mockRpcImplementation({
      list_authorized_services_for_client: { data: services, error: null },
    });
    renderPage();

    await screen.findByRole("option", { name: /Client C-207/ });
    fireEvent.change(screen.getByLabelText("Assigned client"), {
      target: { value: SECOND_CLIENT_ID },
    });
    expect(
      await screen.findByText(
        "This client has 9 active services. Choose the exact one.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign in now/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Service for this visit"), {
      target: { value: services[8]!.service_id },
    });
    expect(screen.getByRole("button", { name: /Sign in now/ })).toBeEnabled();
  });

  it("blocks sign-in when the selected client has no active authorized service", async () => {
    mockRpcImplementation({
      list_authorized_services_for_client: { data: [], error: null },
    });
    renderPage();

    await screen.findByRole("option", { name: /Client C-104/ });
    fireEvent.change(screen.getByLabelText("Assigned client"), {
      target: { value: CLIENT_ID },
    });

    expect(
      await screen.findByText(
        "No active service authorization is available for Client C-104.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign in now/ })).toBeDisabled();
  });

  it("shows one locked live visit with no time-edit or client-name controls", async () => {
    const timeIn = new Date(Date.now() - 5 * 60_000).toISOString();
    mockRpcImplementation({
      get_active_service_visit_v3: {
        data: [{ ...activeVisit, time_in: timeIn }],
        error: null,
      },
    });
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Visit in progress" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Client C-104")).toBeInTheDocument();
    expect(
      screen.getByText("Client and service are locked."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Sign out now/ }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/time in/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Darby Crash")).not.toBeInTheDocument();
  });

  it("recovers an ended visit directly into confirmation after a refresh", async () => {
    mockRpcImplementation({
      get_active_service_visit_v3: {
        data: [
          {
            ...activeVisit,
            visit_status: "awaiting_signature",
            time_out: "2026-08-24T23:30:00.000Z",
            worked_minutes: 120,
          },
        ],
        error: null,
      },
    });
    renderPage();

    expect(
      await screen.findByRole("heading", {
        name: "Client or guardian confirmation",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Client C-104")).toBeInTheDocument();
    expect(screen.getByText("2 hours")).toBeInTheDocument();
  });

  it("ends with a server timestamp and captures a client signature", async () => {
    mockRpcImplementation({
      get_active_service_visit_v3: { data: [activeVisit], error: null },
      end_service_visit: {
        data: [
          {
            visit_id: VISIT_ID,
            worked_minutes: 120,
            time_in: "2026-08-24T21:30:00.000Z",
            time_out: "2026-08-24T23:30:00.000Z",
          },
        ],
        error: null,
      },
      confirm_service_visit: {
        data: [
          {
            status: "signed",
            authorization_status: "within_authorization",
            worked_minutes: 120,
            billable_minutes: 120,
            month_to_date_minutes: 1590,
            remaining_minutes: 3210,
          },
        ],
        error: null,
      },
    });
    const upload = vi
      .fn()
      .mockResolvedValue({ data: { path: "x" }, error: null });
    mockedStorageFrom.mockReturnValue({ upload } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        blob: () =>
          Promise.resolve(new Blob(["fake-png"], { type: "image/png" })),
      }),
    );
    renderPage();

    await openConfirmation();
    const canvas = screen.getByLabelText("Client or guardian signature");
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole("button", { name: /Confirm visit/ }));

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(
        `${ORG_ID}/${VISIT_ID}/client-signature.png`,
        expect.anything(),
        { contentType: "image/png", upsert: true },
      ),
    );
    expect(mockedRpc).toHaveBeenCalledWith("confirm_service_visit", {
      target_visit_id: VISIT_ID,
      signer_role: "client",
      confirmation_method: "draw",
      signature_storage_path: `${ORG_ID}/${VISIT_ID}/client-signature.png`,
      typed_signer_name: null,
      signer_relationship: null,
      confirmation_reason: null,
    });
    expect(
      await screen.findByRole("heading", { name: "Visit saved" }),
    ).toBeInTheDocument();
  });

  it("saves a no-signer visit as unverified and not billable", async () => {
    mockRpcImplementation({
      get_active_service_visit_v3: { data: [activeVisit], error: null },
      end_service_visit: {
        data: [
          {
            visit_id: VISIT_ID,
            worked_minutes: 120,
            time_in: "2026-08-24T21:30:00.000Z",
            time_out: "2026-08-24T23:30:00.000Z",
          },
        ],
        error: null,
      },
      confirm_service_visit: {
        data: [
          {
            status: "administrator_review",
            authorization_status: "within_authorization",
            worked_minutes: 120,
            billable_minutes: 0,
            month_to_date_minutes: 1470,
            remaining_minutes: 3330,
          },
        ],
        error: null,
      },
    });
    renderPage();

    await openConfirmation();
    fireEvent.click(
      screen.getByRole("button", { name: "No client or guardian available" }),
    );
    expect(
      screen.getByRole("button", { name: "Submit for manager review" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Why is manager review needed?"), {
      target: { value: "Client or guardian unavailable" },
    });
    fireEvent.change(screen.getByLabelText("Brief explanation"), {
      target: { value: "Client was asleep" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Submit for manager review" }),
    );

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("confirm_service_visit", {
        target_visit_id: VISIT_ID,
        signer_role: "client",
        confirmation_method: "unable_to_confirm",
        signature_storage_path: null,
        typed_signer_name: null,
        signer_relationship: null,
        confirmation_reason:
          "Client or guardian unavailable: Client was asleep",
      }),
    );
    expect(mockedStorageFrom).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "Saved for manager review" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not counted as confirmed or billable/i),
    ).toBeInTheDocument();
  });

  it("does not mislabel a signed visit when authorization leaves zero billable minutes", async () => {
    mockRpcImplementation({
      get_active_service_visit_v3: { data: [activeVisit], error: null },
      end_service_visit: {
        data: [
          {
            visit_id: VISIT_ID,
            worked_minutes: 120,
            time_in: "2026-08-24T21:30:00.000Z",
            time_out: "2026-08-24T23:30:00.000Z",
          },
        ],
        error: null,
      },
      confirm_service_visit: {
        data: [
          {
            status: "administrator_review",
            authorization_status: "exceeds_authorization",
            worked_minutes: 120,
            billable_minutes: 0,
            month_to_date_minutes: 4800,
            remaining_minutes: 0,
          },
        ],
        error: null,
      },
    });
    mockedStorageFrom.mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: "x" }, error: null }),
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        blob: () =>
          Promise.resolve(new Blob(["fake-png"], { type: "image/png" })),
      }),
    );
    renderPage();

    await openConfirmation();
    const canvas = screen.getByLabelText("Client or guardian signature");
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole("button", { name: /Confirm visit/ }));

    expect(
      await screen.findByRole("heading", { name: "Visit saved" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Client confirmation was recorded/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No client confirmation was recorded/i),
    ).not.toBeInTheDocument();
  });

  it("blocks the screen if the active-visit safety check fails", async () => {
    mockRpcImplementation({
      get_active_service_visit_v3: {
        data: null,
        error: { message: "network down" },
      },
    });
    renderPage();

    expect(
      await screen.findByText(
        "Ogevia could not safely check for an open visit.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sign in now/ }),
    ).not.toBeInTheDocument();
  });

  it("shows a sign-in prompt when logged out", () => {
    mockedUseAuth.mockReturnValue({ ...authUser(), user: null });
    mockRpcImplementation();
    renderPage();
    expect(
      screen.getByText("Sign in to use Service Verification."),
    ).toBeInTheDocument();
    expect(mockedRpc).not.toHaveBeenCalled();
  });
});
