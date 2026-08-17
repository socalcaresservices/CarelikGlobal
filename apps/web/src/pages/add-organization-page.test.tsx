import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { inviteMember } from "@/lib/invitations";
import { uploadOrganizationLogo } from "@/lib/organization-branding";
import { AddOrganizationPage } from "./add-organization-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));
vi.mock("@/lib/invitations", () => ({ inviteMember: vi.fn() }));
vi.mock("@/lib/organization-branding", () => ({ uploadOrganizationLogo: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);
const mockedInviteMember = vi.mocked(inviteMember);
const mockedUploadLogo = vi.mocked(uploadOrganizationLogo);
const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const NEW_ORG_ID = "33333333-3333-4333-8333-333333333333";

function basePlatformOwner() {
  return {
    organizations: [],
    activeOrganization: null,
    activeOrganizationId: null,
    setActiveOrganizationId: vi.fn(),
    role: "platform_owner" as const,
    isPlatformOwner: true,
    hasPermission: vi.fn(() => true),
    loading: false
  };
}

function authUser() {
  return {
    user: { id: "platform-owner-user" } as never,
    session: {} as never,
    loading: false,
    signInWithGithub: vi.fn(),
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updatePassword: vi.fn(),
    signOut: vi.fn()
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AddOrganizationPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("AddOrganizationPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-available message for a non-platform-owner", () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue({ ...basePlatformOwner(), isPlatformOwner: false });

    renderPage();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("New organization")).not.toBeInTheDocument();
  });

  it("blocks moving past step 1 without a legal name and a valid slug", () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue(basePlatformOwner());

    renderPage();
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("Legal business name is required.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Legal business name"), { target: { value: "SoCal Care Services LLC" } });
    fireEvent.click(screen.getByText("Next"));
    expect(
      screen.getByText(
        "Slug must be lowercase letters, numbers, and hyphens (2-63 characters) - this becomes the organization's URL."
      )
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Slug (URL)"), { target: { value: "socal" } });
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("Step 2 of 7 · Address")).toBeInTheDocument();
  });

  function fillStep1() {
    fireEvent.change(screen.getByLabelText("Legal business name"), { target: { value: "SoCal Care Services LLC" } });
    fireEvent.change(screen.getByLabelText("Slug (URL)"), { target: { value: "socal" } });
    fireEvent.click(screen.getByText("Next"));
  }

  function goToReview() {
    fillStep1(); // organization -> address
    fireEvent.click(screen.getByText("Next")); // address -> contact
    fireEvent.click(screen.getByText("Next")); // contact -> branding
    fireEvent.click(screen.getByText("Next")); // branding -> services
    fireEvent.click(screen.getByText("Next")); // services -> administrator
  }

  it("requires at least one valid administrator email before reaching review", () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue(basePlatformOwner());

    renderPage();
    goToReview();
    expect(screen.getByText("Step 6 of 7 · Administrator")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("At least one administrator email is required to invite them.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText('Enter a valid email for "not-an-email".')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "admin@socalcares.com" } });
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("Step 7 of 7 · Review")).toBeInTheDocument();
  });

  it("supports adding and removing multiple administrator rows", () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue(basePlatformOwner());

    renderPage();
    goToReview();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@socalcares.com" } });
    fireEvent.click(screen.getByText("+ Add another administrator"));
    expect(screen.getAllByLabelText("Email")).toHaveLength(2);

    fireEvent.change(screen.getAllByLabelText("Email")[1]!, { target: { value: "coordinator@socalcares.com" } });
    fireEvent.change(screen.getAllByLabelText("Role")[1]!, { target: { value: "scheduler" } });

    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("Step 7 of 7 · Review")).toBeInTheDocument();
    expect(
      screen.getByText("owner@socalcares.com (organization owner), coordinator@socalcares.com (scheduler)")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Previous"));
    fireEvent.click(screen.getAllByText("Remove")[1]!);
    expect(screen.getAllByLabelText("Email")).toHaveLength(1);
  });

  it("creates the organization, invites every administrator (without name), and shows the success state", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    const setActiveOrganizationId = vi.fn();
    mockedUseOrganization.mockReturnValue({ ...basePlatformOwner(), setActiveOrganizationId });
    mockedRpc.mockResolvedValue({
      data: { id: NEW_ORG_ID, slug: "socal", display_name: "SoCal Care Services" },
      error: null
    } as never);
    mockedInviteMember.mockResolvedValue({
      userId: "invited-user",
      email: "admin@socalcares.com",
      organizationId: NEW_ORG_ID,
      role: "organization_owner",
      status: "invited"
    });

    renderPage();
    goToReview();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "admin@socalcares.com" } });
    fireEvent.click(screen.getByText("Next"));

    fireEvent.click(screen.getByText("Create organization"));

    await waitFor(() => expect(screen.getByText("SoCal Care Services is live")).toBeInTheDocument());

    expect(mockedRpc).toHaveBeenCalledWith(
      "create_organization",
      expect.objectContaining({
        slug: "socal",
        legal_name: "SoCal Care Services LLC",
        default_services: ["Respite", "Personal Assistance"]
      })
    );
    // Inviting each administrator deliberately omits firstName/lastName so
    // the edge function sends a real invite email instead of creating the
    // account immediately - see add-organization-page.tsx's comment.
    expect(mockedInviteMember).toHaveBeenCalledWith({
      email: "admin@socalcares.com",
      organizationId: NEW_ORG_ID,
      role: "organization_owner"
    });
    expect(mockedUploadLogo).not.toHaveBeenCalled();
    expect(screen.getByText(/carelik.com\/socal/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Switch to SoCal Care Services"));
    expect(setActiveOrganizationId).toHaveBeenCalledWith(NEW_ORG_ID);
  });

  it("uploads a staged logo file after creation and saves its URL on the organization", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue(basePlatformOwner());
    mockedRpc.mockResolvedValue({
      data: { id: NEW_ORG_ID, slug: "socal", display_name: "SoCal Care Services" },
      error: null
    } as never);
    mockedInviteMember.mockResolvedValue({
      userId: "invited-user",
      email: "admin@socalcares.com",
      organizationId: NEW_ORG_ID,
      role: "organization_owner",
      status: "invited"
    });
    mockedUploadLogo.mockResolvedValue("https://cdxxpdyobsqvqveabsda.supabase.co/storage/v1/object/public/organization-branding/logo.png");
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: eqMock }));
    mockedFrom.mockReturnValue({ update: updateMock } as never);

    renderPage();
    fillStep1();
    fireEvent.click(screen.getByText("Next")); // address -> contact
    fireEvent.click(screen.getByText("Next")); // contact -> branding

    const file = new File(["logo-bytes"], "logo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Logo"), { target: { files: [file] } });

    fireEvent.click(screen.getByText("Next")); // branding -> services
    fireEvent.click(screen.getByText("Next")); // services -> administrator
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "admin@socalcares.com" } });
    fireEvent.click(screen.getByText("Next")); // administrator -> review

    fireEvent.click(screen.getByText("Create organization"));

    await waitFor(() => expect(screen.getByText("SoCal Care Services is live")).toBeInTheDocument());

    expect(mockedUploadLogo).toHaveBeenCalledWith(NEW_ORG_ID, file);
    expect(updateMock).toHaveBeenCalledWith({
      logo_url: "https://cdxxpdyobsqvqveabsda.supabase.co/storage/v1/object/public/organization-branding/logo.png"
    });
    expect(eqMock).toHaveBeenCalledWith("id", NEW_ORG_ID);
  });

  it("keeps the organization but surfaces a warning when an administrator invite fails", async () => {
    mockedUseAuth.mockReturnValue(authUser());
    mockedUseOrganization.mockReturnValue(basePlatformOwner());
    mockedRpc.mockResolvedValue({
      data: { id: NEW_ORG_ID, slug: "socal", display_name: "SoCal Care Services" },
      error: null
    } as never);
    mockedInviteMember.mockRejectedValue(new Error("That email is already a member."));

    renderPage();
    goToReview();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "admin@socalcares.com" } });
    fireEvent.click(screen.getByText("Next"));
    fireEvent.click(screen.getByText("Create organization"));

    await waitFor(() => expect(screen.getByText("SoCal Care Services is live")).toBeInTheDocument());
    expect(
      screen.getByText(/inviting admin@socalcares\.com failed: That email is already a member\./)
    ).toBeInTheDocument();
  });
});
