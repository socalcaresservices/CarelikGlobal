import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { inviteMember } from "@/lib/invitations";
import { CareTeamDetailPage } from "./care-team-detail-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));
vi.mock("@/lib/invitations", () => ({ inviteMember: vi.fn() }));

vi.mock("@/components/documents-card", () => ({ DocumentsCard: () => null }));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);
const mockedInviteMember = vi.mocked(inviteMember);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
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

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: RECORD_ID,
    applicant_id: null,
    linked_user_id: null,
    caregiver_code: "CG-222222",
    first_name: "Sam",
    last_name: "Caregiver",
    preferred_name: null,
    email: "sam@example.com",
    phone: null,
    alternate_phone: null,
    address_street: null,
    address_line2: null,
    address_city: null,
    address_state: null,
    address_zip: null,
    employment_type: null,
    available_start_date: null,
    desired_weekly_hours: null,
    min_weekly_hours: null,
    max_weekly_hours: null,
    min_shift_hours: null,
    max_shift_hours: null,
    max_travel_minutes: null,
    languages: [],
    status: "active",
    onboarding_status: null,
    onboarding_scheduled_at: null,
    onboarding_method: null,
    onboarding_location: null,
    onboarding_instructions: null,
    background_check_status: null,
    compliance_status: null,
    position: null,
    ...overrides
  };
}

function mockFromByTable(record: unknown) {
  const singleMock = vi.fn().mockResolvedValue({ data: record, error: null });
  const isMock = vi.fn(() => ({ single: singleMock }));
  const orMock = vi.fn(() => ({ is: isMock }));
  const recordEqMock = vi.fn(() => ({ or: orMock }));
  const recordSelectMock = vi.fn(() => ({ eq: recordEqMock }));
  const updateEqMock = vi.fn().mockResolvedValue({ error: null });
  const updateMock = vi.fn(() => ({ eq: updateEqMock }));

  const lookupChain = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }));

  mockedFrom.mockImplementation((table: string) => {
    if (table === "caregiver_records") return { select: recordSelectMock, update: updateMock } as never;
    if (table === "caregiver_record_availability") return { select: lookupChain } as never;
    if (table === "caregiver_record_credentials") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({ is: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) })) }))
          }))
        }))
      } as never;
    }
    return { select: lookupChain } as never;
  });

  return { updateMock, updateEqMock };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/team/${RECORD_ID}`]}>
        <Routes>
          <Route path="/team/:id" element={<CareTeamDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("CareTeamDetailPage visits and assignments", () => {
  it("shows only this record's visits, filtered from the org-wide shift list", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(baseRecord());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_shifts") {
        return Promise.resolve({
          data: [
            {
              id: "shift-1",
              client_name: "Jordan Rivera",
              caregiver_record_id: RECORD_ID,
              starts_at: "2026-08-20T09:00:00Z",
              ends_at: "2026-08-20T11:00:00Z",
              status: "completed"
            },
            {
              id: "shift-2",
              client_name: "Someone Else's Client",
              caregiver_record_id: "a-different-record-id",
              starts_at: "2026-08-20T09:00:00Z",
              ends_at: "2026-08-20T11:00:00Z",
              status: "completed"
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    expect(screen.queryByText("Someone Else's Client")).not.toBeInTheDocument();
  });

  it("explains assignments require a linked login when the record has none", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(baseRecord({ linked_user_id: null }));
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Send or link this caregiver's login above, then assign each client and service from the client's Caregivers tab.")).toBeInTheDocument()
    );
  });

  it("invites and links a caregiver login from the Care Team record", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(baseRecord({ linked_user_id: null }));
    mockedInviteMember.mockResolvedValue({
      userId: USER_ID,
      email: "sam@example.com",
      organizationId: ORG_ID,
      role: "caregiver",
      status: "invited"
    });
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Send login invite & link" }));

    await waitFor(() => expect(mockedInviteMember).toHaveBeenCalledWith({
      email: "sam@example.com",
      organizationId: ORG_ID,
      role: "caregiver"
    }));
    expect(mockedRpc).toHaveBeenCalledWith("link_caregiver_record_to_user", {
      target_organization_id: ORG_ID,
      target_caregiver_record_id: RECORD_ID,
      target_user_id: USER_ID
    });
    expect(await screen.findByText("Invite sent and caregiver login linked.")).toBeInTheDocument();
  });

  it("shows the Position carried over from a transferred candidate", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(baseRecord({ position: "Coordinator" }));
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getAllByText("Position").length).toBeGreaterThan(0));
    const positionLabel = screen.getAllByText("Position").find((el) => el.tagName === "DT")!;
    expect(positionLabel.nextElementSibling?.textContent).toBe("Coordinator");
  });

  it("edits Position, including a custom Other value, and saves it to caregiver_records", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const { updateMock } = mockFromByTable(baseRecord({ position: null }));
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Edit workforce profile")).toBeInTheDocument());
    const positionSelect = screen.getByLabelText("Position");
    fireEvent.change(positionSelect, { target: { value: "Other" } });
    fireEvent.change(screen.getByLabelText("Specify position"), { target: { value: "Overnight Companion" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ position: "Overnight Companion" }))
    );
  });

  it("shows only this record's assignments once linked to a login", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(baseRecord({ linked_user_id: USER_ID }));
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_caregiver_assignments") {
        return Promise.resolve({
          data: [
            {
              id: "assignment-1",
              caregiver_user_id: USER_ID,
              client_name: "Jordan Rivera",
              service_name: "Personal care",
              is_active: true,
              effective_start: "2026-01-01",
              effective_end: null
            },
            {
              id: "assignment-2",
              caregiver_user_id: "some-other-user",
              client_name: "Someone Else's Client",
              service_name: "Respite",
              is_active: true,
              effective_start: "2026-01-01",
              effective_end: null
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Jordan Rivera")).toBeInTheDocument());
    expect(screen.queryByText("Someone Else's Client")).not.toBeInTheDocument();
  });
});

