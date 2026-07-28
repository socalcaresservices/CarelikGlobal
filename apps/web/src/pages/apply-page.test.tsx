import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { ApplyPage } from "./apply-page";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "33333333-3333-4333-8333-333333333333";

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/apply/:orgSlug" element={<ApplyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function mockRpcByFn(
  services: Array<{ id: string; name: string }> = [],
  organizationOverrides: Record<string, unknown> = {}
) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "get_organization_by_slug") {
      return Promise.resolve({
        data: [
          {
            id: ORG_ID,
            display_name: "Acme Home Care",
            logo_url: null,
            primary_color: null,
            accent_color: null,
            ...organizationOverrides
          }
        ],
        error: null
      }) as never;
    }
    if (fn === "list_public_organization_services") {
      return Promise.resolve({ data: services, error: null }) as never;
    }
    return Promise.resolve({ data: [], error: null }) as never;
  });
}

async function startApplication() {
  await waitFor(() => expect(screen.getByText("Join Our Care Team")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Start Application"));
  await waitFor(() => expect(screen.getByLabelText("First name")).toBeInTheDocument());
}

async function reachEmploymentStep() {
  fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ashley" } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Rivera" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ashley@example.com" } });
  fireEvent.click(screen.getByText("Next"));

  await waitFor(() => expect(screen.getByLabelText("ZIP code")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Next"));

  await waitFor(() => expect(screen.getByLabelText("Employment type")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("Employment type"), { target: { value: "full_time" } });
}

describe("ApplyPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-found state for an unknown organization slug", async () => {
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderAt("/apply/not-a-real-org");

    await waitFor(() => expect(screen.getByText("Application not found")).toBeInTheDocument());
  });

  it("shows a distinct error state (not 'not found') when the organization fetch fails", async () => {
    mockedRpc.mockResolvedValue({ data: null, error: new Error("network error") } as never);

    renderAt("/apply/acme");

    await waitFor(() => expect(screen.getByText("Something went wrong")).toBeInTheDocument());
    expect(screen.queryByText("Application not found")).not.toBeInTheDocument();
  });

  it("shows the welcome screen, then starts the wizard on the Personal information step", async () => {
    mockRpcByFn([{ id: SERVICE_ID, name: "Companion Care" }]);

    renderAt("/apply/acme");

    await waitFor(() => expect(screen.getByText("Acme Home Care")).toBeInTheDocument());
    expect(screen.getByText("Join Our Care Team")).toBeInTheDocument();
    expect(screen.getByText("Approximately 6–8 minutes")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Start Application"));

    await waitFor(() => expect(screen.getByLabelText("First name")).toBeInTheDocument());
    expect(screen.getByText("Step 1 of 8 · Personal information")).toBeInTheDocument();
  });

  it("blocks advancing past the Personal step until required fields are filled", async () => {
    mockRpcByFn();
    renderAt("/apply/acme");
    await startApplication();

    fireEvent.click(screen.getByText("Next"));

    expect(await screen.findByRole("alert")).toHaveTextContent("First name is required.");
    // Still on the Personal step - the field is still visible.
    expect(screen.getByLabelText("First name")).toBeInTheDocument();
  });

  it("blocks advancing past the Personal step with a malformed email", async () => {
    mockRpcByFn();
    renderAt("/apply/acme");
    await startApplication();

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ashley" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Rivera" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByText("Next"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid email address.");
    expect(screen.getByLabelText("First name")).toBeInTheDocument();
  });

  it("blocks advancing past the Employment step with a negative hours value", async () => {
    mockRpcByFn();
    renderAt("/apply/acme");
    await startApplication();
    await reachEmploymentStep();

    fireEvent.change(screen.getByLabelText("Desired weekly hours"), { target: { value: "-5" } });
    fireEvent.click(screen.getByText("Next"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Desired weekly hours can't be negative.");
    expect(screen.getByLabelText("Employment type")).toBeInTheDocument();
  });

  it("blocks advancing past the Employment step with an out-of-range hours value", async () => {
    mockRpcByFn();
    renderAt("/apply/acme");
    await startApplication();
    await reachEmploymentStep();

    fireEvent.change(screen.getByLabelText("Desired monthly hours"), { target: { value: "9999" } });
    fireEvent.click(screen.getByText("Next"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Desired monthly hours must be 744 or less.");
  });

  it("blocks advancing past the Employment step when minimum weekly hours exceeds maximum", async () => {
    mockRpcByFn();
    renderAt("/apply/acme");
    await startApplication();
    await reachEmploymentStep();

    fireEvent.change(screen.getByLabelText("Minimum weekly hours"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Maximum weekly hours"), { target: { value: "10" } });
    fireEvent.click(screen.getByText("Next"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Minimum weekly hours can't be more than maximum weekly hours."
    );
  });

  it("walks through every step, including a split shift and services, and submits on Review", async () => {
    mockRpcByFn([{ id: SERVICE_ID, name: "Companion Care" }]);

    const applicantInsertMock = vi.fn().mockResolvedValue({ error: null });
    const availabilityInsertMock = vi.fn().mockResolvedValue({ error: null });
    const servicesInsertMock = vi.fn().mockResolvedValue({ error: null });

    mockedFrom.mockImplementation((table: string) => {
      if (table === "job_applicants") return { insert: applicantInsertMock } as never;
      if (table === "job_applicant_availability") return { insert: availabilityInsertMock } as never;
      if (table === "job_applicant_services") return { insert: servicesInsertMock } as never;
      return {} as never;
    });

    renderAt("/apply/acme");
    await startApplication();

    // Step 1: Personal
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ashley" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Rivera" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ashley@example.com" } });
    fireEvent.click(screen.getByText("Next"));

    // Step 2: Address
    await waitFor(() => expect(screen.getByLabelText("ZIP code")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("ZIP code"), { target: { value: "92879" } });
    fireEvent.click(screen.getByText("Next"));

    // Step 3: Employment preferences - required, blocks without a selection
    await waitFor(() => expect(screen.getByLabelText("Employment type")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Next"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Select the employment type");
    fireEvent.change(screen.getByLabelText("Employment type"), { target: { value: "full_time" } });
    fireEvent.click(screen.getByText("Next"));

    // Step 4: Services - card-style toggle button
    await waitFor(() => expect(screen.getByRole("button", { name: "Companion Care" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Companion Care" }));
    fireEvent.click(screen.getByText("Next"));

    // Step 5: Availability - a split shift on Monday
    await waitFor(() => expect(screen.getByLabelText("Monday")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Monday"));
    fireEvent.change(screen.getByLabelText("Monday shift 1 start time"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("Monday shift 1 end time"), { target: { value: "12:00" } });
    fireEvent.click(screen.getByText("+ Add another shift on Monday"));
    fireEvent.change(screen.getByLabelText("Monday shift 2 start time"), { target: { value: "19:00" } });
    fireEvent.change(screen.getByLabelText("Monday shift 2 end time"), { target: { value: "23:00" } });
    fireEvent.click(screen.getByText("Next"));

    // Step 6: Transportation - optional, skip straight through
    await waitFor(() => expect(screen.getByLabelText("Maximum travel time (minutes)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Next"));

    // Step 7: Requirements - consent is required
    await waitFor(() =>
      expect(screen.getByLabelText("I am willing to undergo a background check")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByText("Next"));
    expect(await screen.findByRole("alert")).toHaveTextContent("willing to undergo a background check");
    fireEvent.click(screen.getByLabelText("I am willing to undergo a background check"));
    fireEvent.click(screen.getByText("Next"));

    // Step 8: Review - shows a summary and the real submit button
    await waitFor(() => expect(screen.getByText("Step 8 of 8 · Review")).toBeInTheDocument());
    expect(screen.getByText("Companion Care")).toBeInTheDocument();
    expect(screen.getByText("Full-Time")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Submit application"));

    await waitFor(() => expect(screen.getByText("Thanks for applying!")).toBeInTheDocument());

    expect(applicantInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        organization_id: ORG_ID,
        first_name: "Ashley",
        last_name: "Rivera",
        address_zip: "92879",
        employment_type: "full_time",
        background_check_consent: true
      })
    );
    expect(availabilityInsertMock).toHaveBeenCalledWith([
      expect.objectContaining({ day_of_week: "monday", start_time: "09:00", end_time: "12:00" }),
      expect.objectContaining({ day_of_week: "monday", start_time: "19:00", end_time: "23:00" })
    ]);
    expect(servicesInsertMock).toHaveBeenCalledWith([
      expect.objectContaining({ organization_id: ORG_ID, service_id: SERVICE_ID })
    ]);

    // The draft is cleared from localStorage once the application succeeds.
    expect(window.localStorage.getItem("carelik-apply-draft:acme")).toBeNull();
  });

  it("lets the applicant jump back to a step from Review, edit it, and resume", async () => {
    mockRpcByFn();
    renderAt("/apply/acme");
    await startApplication();

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ashley" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Rivera" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ashley@example.com" } });
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(screen.getByLabelText("ZIP code")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(screen.getByLabelText("Employment type")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Employment type"), { target: { value: "per_diem" } });
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(screen.getByText("Step 4 of 8 · Services")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(screen.getByLabelText("Monday")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(screen.getByLabelText("Maximum travel time (minutes)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() =>
      expect(screen.getByLabelText("I am willing to undergo a background check")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByLabelText("I am willing to undergo a background check"));
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => expect(screen.getByText("Step 8 of 8 · Review")).toBeInTheDocument());
    expect(screen.getByText("Per Diem")).toBeInTheDocument();

    // Review renders sections in a fixed order: Personal, Address,
    // Employment, Services, Availability, Transportation, Requirements -
    // so the third "Edit" button belongs to Employment preferences.
    fireEvent.click(screen.getAllByText("Edit")[2]!);

    await waitFor(() => expect(screen.getByLabelText("Employment type")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Employment type"), { target: { value: "contractor" } });
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(screen.getByText("Step 4 of 8 · Services")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(screen.getByLabelText("Monday")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(screen.getByLabelText("Maximum travel time (minutes)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() =>
      expect(screen.getByLabelText("I am willing to undergo a background check")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => expect(screen.getByText("Step 8 of 8 · Review")).toBeInTheDocument());
    expect(screen.getByText("Contractor")).toBeInTheDocument();
  });

  it("offers to continue a saved draft on the welcome screen after leaving mid-application", async () => {
    mockRpcByFn();
    const { unmount } = renderAt("/apply/acme");
    await startApplication();

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ashley" } });

    await waitFor(() => expect(window.localStorage.getItem("carelik-apply-draft:acme")).not.toBeNull());
    unmount();

    renderAt("/apply/acme");
    await waitFor(() => expect(screen.getByText("Continue application")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Continue application"));

    await waitFor(() => expect(screen.getByLabelText("First name")).toHaveValue("Ashley"));
  });

  it("shows the organization's logo instead of its name when one is set", async () => {
    mockRpcByFn([], { logo_url: "https://example.com/acme-logo.png" });

    renderAt("/apply/acme");

    await waitFor(() => expect(screen.getByAltText("Acme Home Care")).toBeInTheDocument());
    expect(screen.getByAltText("Acme Home Care")).toHaveAttribute("src", "https://example.com/acme-logo.png");
    expect(screen.queryByText("Acme Home Care", { selector: "p" })).not.toBeInTheDocument();
  });

  it("scopes --color-accent to the organization's accent color when set", async () => {
    mockRpcByFn([], { accent_color: "#ff6600" });

    const { container } = renderAt("/apply/acme");

    await waitFor(() => expect(screen.getByText("Start Application")).toBeInTheDocument());
    expect(container.firstChild).toHaveStyle({ "--color-accent": "#ff6600" });
  });

  it("shows the Powered by CareLik footer by default on the welcome screen", async () => {
    mockRpcByFn();

    renderAt("/apply/acme");

    await waitFor(() => expect(screen.getByText("Start Application")).toBeInTheDocument());
    expect(screen.getByText("Powered by CareLik")).toBeInTheDocument();
  });

  it("hides the Powered by CareLik footer when the organization has turned it off", async () => {
    mockRpcByFn([], { show_powered_by: false });

    renderAt("/apply/acme");

    await waitFor(() => expect(screen.getByText("Start Application")).toBeInTheDocument());
    expect(screen.queryByText("Powered by CareLik")).not.toBeInTheDocument();
  });
});
