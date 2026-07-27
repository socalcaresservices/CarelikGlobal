import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ApplicantDetailPage } from "./applicant-detail-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const APPLICANT_ID = "22222222-2222-4222-8222-222222222222";

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

function applicantRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: APPLICANT_ID,
    first_name: "Ashley",
    last_name: "Rivera",
    email: "ashley@example.com",
    phone: "555-0100",
    status: "new",
    desired_weekly_hours: 30,
    min_weekly_hours: 20,
    max_weekly_hours: 40,
    min_shift_hours: 4,
    max_shift_hours: 8,
    preferred_cities: ["Corona"],
    max_travel_minutes: 30,
    transportation_method: "own car",
    willing_to_transport_clients: true,
    languages: ["English", "Spanish"],
    notes: null,
    hired_caregiver_user_id: null,
    created_at: new Date().toISOString(),
    ...overrides
  };
}

function mockFromByTable(applicant: unknown, availability: unknown[] = []) {
  const applicantSingleMock = vi.fn().mockResolvedValue({ data: applicant, error: null });
  const applicantEqMock = vi.fn(() => ({ single: applicantSingleMock }));
  const applicantSelectMock = vi.fn(() => ({ eq: applicantEqMock }));
  const applicantUpdateEqMock = vi.fn().mockResolvedValue({ error: null });
  const applicantUpdateMock = vi.fn(() => ({ eq: applicantUpdateEqMock }));

  const availabilityEqMock = vi.fn().mockResolvedValue({ data: availability, error: null });
  const availabilitySelectMock = vi.fn(() => ({ eq: availabilityEqMock }));

  mockedFrom.mockImplementation((table: string) => {
    if (table === "job_applicants") {
      return { select: applicantSelectMock, update: applicantUpdateMock } as never;
    }
    if (table === "job_applicant_availability") {
      return { select: availabilitySelectMock } as never;
    }
    return {} as never;
  });

  return { applicantUpdateMock, applicantUpdateEqMock };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/applicants/${APPLICANT_ID}`]}>
        <Routes>
          <Route path="/applicants/:id" element={<ApplicantDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ApplicantDetailPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the applicant's details and weekly availability", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(applicantRecord(), [
      { day_of_week: "monday", start_time: "09:00:00", end_time: "17:00:00", preference: "preferred" }
    ]);
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Ashley Rivera")).toBeInTheDocument());
    expect(screen.getByText("ashley@example.com · 555-0100")).toBeInTheDocument();
    expect(screen.getByText("Monday")).toBeInTheDocument();
    expect(screen.getByText("09:00–17:00")).toBeInTheDocument();
    expect(screen.getByText("Preferred")).toBeInTheDocument();
  });

  it("offers the convert action once an applicant is hireable, and hides it once already converted", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(applicantRecord());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: "user-1", display_name: "Ashley Rivera", status: "active" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Select a member…")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Convert to caregiver" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Convert to caregiver" })).toBeDisabled();
  });

  it("shows a converted message once hired_caregiver_user_id is set", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(applicantRecord({ status: "hired", hired_caregiver_user_id: "user-1" }));
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText("Already converted - their availability and desired hours were copied to their caregiver profile.")
      ).toBeInTheDocument()
    );
  });

  it("hides everything without applicants.read", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization(() => false));

    renderPage();

    expect(screen.getByText("Not available")).toBeInTheDocument();
  });
});
