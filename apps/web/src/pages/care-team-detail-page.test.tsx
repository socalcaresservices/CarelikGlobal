import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function mockFromByTable(record: unknown, recordServiceIds: string[] = []) {
  const singleMock = vi.fn().mockResolvedValue({ data: record, error: null });
  const isMock = vi.fn(() => ({ single: singleMock }));
  const orMock = vi.fn(() => ({ is: isMock }));
  const recordEqMock = vi.fn(() => ({ or: orMock }));
  const recordSelectMock = vi.fn(() => ({ eq: recordEqMock }));
  const updateEqMock = vi.fn().mockResolvedValue({ error: null });
  const updateMock = vi.fn(() => ({ eq: vi.fn(() => ({ eq: updateEqMock })) }));

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
    if (table === "skills") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              order: vi.fn().mockResolvedValue({
                data: [
                  { id: "skill-1", name: "dementia", is_active: true },
                  { id: "skill-2", name: "hoyer lift", is_active: true },
                  { id: "skill-3", name: "retired skill", is_active: false },
                ],
                error: null,
              }),
            })),
          })),
        })),
      } as never;
    }
    if (table === "services") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              order: vi.fn().mockResolvedValue({
                data: [
                  { id: "service-respite", name: "Respite", is_active: true },
                  { id: "service-pc", name: "Personal Care", is_active: true },
                  { id: "service-old", name: "Retired Service", is_active: false },
                ],
                error: null,
              }),
            })),
          })),
        })),
      } as never;
    }
    if (table === "caregiver_record_services") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ data: recordServiceIds.map((service_id) => ({ service_id })), error: null }),
          })),
        })),
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

  it("records skills for a caregiver without a login from the skill catalog and saves them to caregiver_records", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const { updateMock } = mockFromByTable(baseRecord({ linked_user_id: null, skills: ["dementia"] }));
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Edit workforce profile")).toBeInTheDocument());
    // Existing skill shows on the profile and as a removable chip.
    const skillsLabel = screen.getAllByText("Skills").find((el) => el.tagName === "DT")!;
    expect(skillsLabel.nextElementSibling?.textContent).toBe("dementia");
    expect(screen.getByRole("button", { name: "Remove dementia" })).toBeInTheDocument();
    // Only ACTIVE catalog skills are offered.
    const box = screen.getByRole("combobox", { name: "Skills" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "lift" } });
    const option = await screen.findByRole("option", { name: /hoyer lift/ });
    fireEvent.mouseDown(option);
    fireEvent.change(box, { target: { value: "retired" } });
    expect(screen.queryByRole("option", { name: /retired skill/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ skills: ["dementia", "hoyer lift"] }))
    );
  });

  it("records services supported and preferred cities, and saves services through the RPC", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const { updateMock } = mockFromByTable(baseRecord({ linked_user_id: null, preferred_cities: ["Riverside"] }), ["service-respite"]);
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "Remove Respite" })).toBeInTheDocument());
    const servicesLabel = screen.getAllByText("Services supported").find((el) => el.tagName === "DT")!;
    expect(servicesLabel.nextElementSibling?.textContent).toBe("Respite");
    const citiesLabel = screen.getAllByText("Preferred cities").find((el) => el.tagName === "DT")!;
    expect(citiesLabel.nextElementSibling?.textContent).toBe("Riverside");
    // Only ACTIVE services are offered.
    const box = screen.getByRole("combobox", { name: "Services supported" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "retired" } });
    expect(screen.queryByRole("option", { name: /Retired Service/ })).toBeNull();
    fireEvent.change(box, { target: { value: "personal" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Personal Care/ }));
    fireEvent.change(screen.getByLabelText("Preferred cities (comma separated)"), { target: { value: "Riverside, Corona " } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("replace_caregiver_record_services", {
        target_organization_id: ORG_ID,
        target_caregiver_record_id: RECORD_ID,
        service_ids: ["service-respite", "service-pc"],
      })
    );
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ preferred_cities: ["Riverside", "Corona"] }));
  });

  it("omits preferred_cities from the save when the database has no such column yet", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    const { updateMock } = mockFromByTable(baseRecord({ linked_user_id: null }));
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByText("Edit workforce profile")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    expect(updateMock).toHaveBeenCalledWith(expect.not.objectContaining({ preferred_cities: expect.anything() }));
  });

  it("accepts an overnight availability window, says it ends the next day, and saves it", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(baseRecord({ linked_user_id: null }));
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    // "+ Add time" only appears once the saved windows have loaded, so an
    // added window can no longer be overwritten by the initial load.
    fireEvent.click((await screen.findAllByRole("button", { name: "+ Add time" }))[0]!);
    const [start, end] = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="time"]'));
    fireEvent.change(start!, { target: { value: "22:00" } });
    fireEvent.change(end!, { target: { value: "06:00" } });
    expect(screen.getByText("Overnight: ends the next day.")).toBeInTheDocument();
    fireEvent.change(end!, { target: { value: "22:00" } });
    expect(screen.getByText("Start and end can't be the same.")).toBeInTheDocument();
    fireEvent.change(end!, { target: { value: "06:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("replace_caregiver_record_availability", expect.objectContaining({
        availability_slots: [expect.objectContaining({ day_of_week: "monday", start_time: "22:00", end_time: "06:00" })],
      }))
    );
  });

  it("does not offer '+ Add time' until the saved availability has loaded", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockFromByTable(baseRecord({ linked_user_id: null }));
    const base = mockedFrom.getMockImplementation()!;
    let release: (value: { data: unknown[]; error: null }) => void = () => {};
    const pending = new Promise<{ data: unknown[]; error: null }>((resolve) => { release = resolve; });
    mockedFrom.mockImplementation(((table: string) =>
      table === "caregiver_record_availability"
        ? ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => pending) })) })) } as never)
        : base(table as never)) as never);
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "Save availability" })).toBeInTheDocument());
    expect(screen.queryAllByRole("button", { name: "+ Add time" })).toHaveLength(0);
    act(() => release({ data: [], error: null }));
    expect((await screen.findAllByRole("button", { name: "+ Add time" })).length).toBe(7);
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

