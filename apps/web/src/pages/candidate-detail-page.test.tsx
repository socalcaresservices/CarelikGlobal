import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { CandidateDetailPage } from "./candidate-detail-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));
vi.mock("@/components/documents-card", () => ({ DocumentsCard: () => null }));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

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

function baseCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: CANDIDATE_ID,
    first_name: "Pat",
    last_name: "WalkIn",
    preferred_name: null,
    email: null,
    phone: "555-111-2222",
    address_street: null,
    address_line2: null,
    address_city: null,
    address_state: null,
    address_zip: null,
    pipeline_stage: "application_received",
    source: "manual",
    position_applied_for: "Coordinator",
    applied_at: "2026-08-20T00:00:00.000Z",
    employment_type: null,
    available_start_date: null,
    desired_weekly_hours: null,
    min_shift_hours: null,
    max_shift_hours: null,
    max_travel_minutes: null,
    transportation_method: null,
    reliable_transportation: null,
    valid_drivers_license: null,
    auto_insurance: null,
    languages: [],
    notes: null,
    ...overrides
  };
}

function mockFromByTable(candidate: unknown) {
  const singleMock = vi.fn().mockResolvedValue({ data: candidate, error: null });
  const eqMock2 = vi.fn(() => ({ single: singleMock }));
  const eqMock1 = vi.fn(() => ({ eq: eqMock2 }));
  const candidateSelectMock = vi.fn(() => ({ eq: eqMock1 }));

  const emptyListChain = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }));

  mockedFrom.mockImplementation((table: string) => {
    if (table === "job_applicants") return { select: candidateSelectMock } as never;
    if (table === "job_applicant_availability") return { select: emptyListChain } as never;
    if (table === "candidate_credentials") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({ is: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) })) }))
          }))
        }))
      } as never;
    }
    if (table === "candidate_onboarding") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })) }))
        }))
      } as never;
    }
    if (table === "candidate_stage_history") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ eq: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) })) }))
        }))
      } as never;
    }
    if (table === "candidate_portal_tokens") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ eq: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) })) }))
        }))
      } as never;
    }
    return { select: emptyListChain } as never;
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/candidates/${CANDIDATE_ID}`]}>
        <Routes>
          <Route path="/candidates/:id" element={<CandidateDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CandidateDetailPage", () => {
  afterEach(() => vi.clearAllMocks());

  it("opens for a phone-only candidate and shows the Position it was created with", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedUseAuth.mockReturnValue({ user: { id: USER_ID } } as never);
    mockFromByTable(baseCandidate());
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Pat WalkIn")).toBeInTheDocument());
    expect(screen.getByText("No email · 555-111-2222")).toBeInTheDocument();
    expect(screen.getByText("Coordinator")).toBeInTheDocument();
  });

  it("transfers a candidate to Care Team, preserving Position through the RPC and navigating to the new record", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedUseAuth.mockReturnValue({ user: { id: USER_ID } } as never);
    mockFromByTable(baseCandidate());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "transfer_candidate_to_care_team") {
        return Promise.resolve({ data: "new-workforce-record-id", error: null }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Create workforce record")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Create workforce record"));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("transfer_candidate_to_care_team", {
        target_organization_id: ORG_ID,
        target_applicant_id: CANDIDATE_ID
      })
    );
  });
});
