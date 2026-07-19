import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { CredentialsPage } from "./credentials-page";

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

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CredentialsPage />
    </QueryClientProvider>
  );
}

describe("CredentialsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("hides the add form and shows an own-credentials note without credentials.read", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn(() => false)
    });
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderPage();

    expect(screen.getByText("Showing only your own credentials.")).toBeInTheDocument();
    expect(screen.queryByText("Add a credential")).not.toBeInTheDocument();
  });

  it("lists credentials with a status badge", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn(() => true)
    });
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_caregiver_credentials") {
        return Promise.resolve({
          data: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              caregiver_user_id: CAREGIVER_ID,
              caregiver_name: "Sam Caregiver",
              credential_type: "CPR Certification",
              issued_date: "2026-01-01",
              expires_at: "2020-01-01",
              notes: null
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Sam Caregiver")).toBeInTheDocument());
    expect(screen.getByText("CPR Certification")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("adds a new credential", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn(() => true)
    });
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_organization_members") {
        return Promise.resolve({
          data: [{ user_id: CAREGIVER_ID, display_name: "Sam Caregiver", status: "active" }],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockedFrom.mockReturnValue({ insert: insertMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Add a credential")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Sam Caregiver" })).toBeInTheDocument()
    );

    fireEvent.change(screen.getByLabelText("Caregiver"), { target: { value: CAREGIVER_ID } });
    fireEvent.change(screen.getByLabelText("Credential"), { target: { value: "TB Test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add credential" }));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG_ID,
          caregiver_user_id: CAREGIVER_ID,
          credential_type: "TB Test"
        })
      )
    );
  });

  it("soft-deletes a credential via Remove", async () => {
    mockedUseOrganization.mockReturnValue({
      ...baseOrganization(),
      hasPermission: vi.fn(() => true)
    });
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "list_caregiver_credentials") {
        return Promise.resolve({
          data: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              caregiver_user_id: CAREGIVER_ID,
              caregiver_name: "Sam Caregiver",
              credential_type: "CPR Certification",
              issued_date: null,
              expires_at: null,
              notes: null
            }
          ],
          error: null
        }) as never;
      }
      return Promise.resolve({ data: [], error: null }) as never;
    });
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    mockedFrom.mockReturnValue({ update: updateMock } as never);

    renderPage();
    await waitFor(() => expect(screen.getByText("Remove")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }))
    );
    expect(eqMock).toHaveBeenCalledWith("id", "55555555-5555-4555-8555-555555555555");
  });
});
