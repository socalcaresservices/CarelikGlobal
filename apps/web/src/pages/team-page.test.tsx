import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { TeamPage } from "./team-page";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedUseOrganization = vi.mocked(useOrganization);
const mockedRpc = vi.mocked(supabase.rpc);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CAREGIVER_ID = "44444444-4444-4444-8444-444444444444";

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
    hasPermission: vi.fn(),
    loading: false
  };
}

function mockRpc({ members = [], hours = [] }: { members?: unknown[]; hours?: unknown[] }) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "list_organization_members") return Promise.resolve({ data: members, error: null }) as never;
    if (fn === "get_caregiver_hours") return Promise.resolve({ data: hours, error: null }) as never;
    return Promise.resolve({ data: [], error: null }) as never;
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <TeamPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("TeamPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message without membership.read", () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => false) });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("lists caregivers with their role, hours, and status", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      members: [
        {
          membership_id: "m1",
          user_id: CAREGIVER_ID,
          display_name: "Sam Caregiver",
          role: "staff",
          status: "active"
        }
      ],
      hours: [{ caregiver_user_id: CAREGIVER_ID, target_hours_per_week: 20, scheduled_hours: 15 }]
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());
    expect(screen.getByText("staff")).toBeInTheDocument();
    expect(screen.getByText("15h / 20h")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();

    const link = screen.getByText("Sam Caregiver").closest("a");
    expect(link).toHaveAttribute("href", `/team/${CAREGIVER_ID}`);
  });

  it("shows a dash for hours when there's no matching hours row", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      members: [
        {
          membership_id: "m1",
          user_id: CAREGIVER_ID,
          display_name: "Sam Caregiver",
          role: "staff",
          status: "active"
        }
      ],
      hours: []
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("filters by search", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({
      members: [
        { membership_id: "m1", user_id: CAREGIVER_ID, display_name: "Sam Caregiver", role: "staff", status: "active" },
        { membership_id: "m2", user_id: "55555555-5555-4555-8555-555555555555", display_name: "Alex Aide", role: "staff", status: "active" }
      ],
      hours: []
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Search team"), { target: { value: "alex" } });

    expect(screen.queryByText("Sam Caregiver")).not.toBeInTheDocument();
    expect(screen.getByText("Alex Aide")).toBeInTheDocument();
  });

  it("shows an empty state when there are no caregivers", async () => {
    mockedUseOrganization.mockReturnValue({ ...baseOrganization(), hasPermission: vi.fn(() => true) });
    mockRpc({ members: [], hours: [] });

    renderPage();
    await waitFor(() => expect(screen.getByText("No team members yet.")).toBeInTheDocument());
  });
});
