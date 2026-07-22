import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { CaregiverHoursCard } from "./caregiver-hours";

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
    hasPermission: vi.fn(() => true),
    loading: false
  };
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CaregiverHoursCard />
    </QueryClientProvider>
  );
}

describe("CaregiverHoursCard", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows 'No target set' when a caregiver has no target", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [
        {
          caregiver_user_id: CAREGIVER_ID,
          caregiver_name: "Sam Caregiver",
          target_hours_per_week: null,
          scheduled_hours: 12
        }
      ],
      error: null
    } as never);

    renderCard();

    await waitFor(() => expect(screen.getByText("No target set")).toBeInTheDocument());
  });

  it("flags a caregiver over their target", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [
        {
          caregiver_user_id: CAREGIVER_ID,
          caregiver_name: "Sam Caregiver",
          target_hours_per_week: 20,
          scheduled_hours: 25
        }
      ],
      error: null
    } as never);

    renderCard();

    await waitFor(() => expect(screen.getByText("Over limit")).toBeInTheDocument());
    expect(screen.getByText("25h")).toBeInTheDocument();
  });

  it("shows normal usage for a caregiver well under target", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({
      data: [
        {
          caregiver_user_id: CAREGIVER_ID,
          caregiver_name: "Sam Caregiver",
          target_hours_per_week: 20,
          scheduled_hours: 15
        }
      ],
      error: null
    } as never);

    renderCard();

    await waitFor(() => expect(screen.getByText("Normal usage")).toBeInTheDocument());
  });

  it("saves a new target via set_caregiver_weekly_target", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "get_caregiver_hours") {
        return Promise.resolve({
          data: [
            {
              caregiver_user_id: CAREGIVER_ID,
              caregiver_name: "Sam Caregiver",
              target_hours_per_week: null,
              scheduled_hours: 10
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: null, error: null }) as never;
    });

    renderCard();
    await waitFor(() =>
      expect(screen.getByLabelText("Target hours for Sam Caregiver")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByLabelText("Target hours for Sam Caregiver"), { target: { value: "25" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("set_caregiver_weekly_target", {
        target_organization_id: ORG_ID,
        target_user_id: CAREGIVER_ID,
        target_hours: 25
      })
    );
  });

  it("hides the card entirely when there is no caregiver data", async () => {
    mockedUseOrganization.mockReturnValue(baseOrganization());
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    const { container } = renderCard();

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
