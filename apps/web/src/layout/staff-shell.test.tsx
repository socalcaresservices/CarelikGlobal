import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { StaffShell } from "./staff-shell";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: vi.fn() }));

const mockedUseAuth = vi.mocked(useAuth);
const mockedUseOrganization = vi.mocked(useOrganization);

function renderShell() {
  return render(
    <MemoryRouter>
      <StaffShell>
        <div>page content</div>
      </StaffShell>
    </MemoryRouter>
  );
}

describe("StaffShell", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows only the caregiver-relevant nav destinations", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "caregiver@acme.test" }, signOut: vi.fn() } as never);
    mockedUseOrganization.mockReturnValue({
      activeOrganization: { displayName: "Acme Care", logoUrl: null, primaryColor: null },
      loading: false
    } as never);

    renderShell();

    // Each label appears twice - once in the desktop sidebar, once in
    // the mobile bottom tab bar - both are real, simultaneously-rendered
    // navigation, not duplicated content.
    expect(screen.getAllByText("Home")).toHaveLength(2);
    expect(screen.getAllByText("My Schedule")).toHaveLength(2);
    expect(screen.getAllByText("Schedule a visit")).toHaveLength(2);
    expect(screen.getAllByText("Clock in / Verify visit")).toHaveLength(2);

    // None of the agency-administration surfaces a caregiver shouldn't
    // see appear anywhere in this shell's own chrome.
    expect(screen.queryByText("Clients")).not.toBeInTheDocument();
    expect(screen.queryByText("Applicants")).not.toBeInTheDocument();
    expect(screen.queryByText("Authorizations")).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Access")).not.toBeInTheDocument();
  });

  it("renders the active organization's name in the header", () => {
    mockedUseAuth.mockReturnValue({ user: { email: "caregiver@acme.test" }, signOut: vi.fn() } as never);
    mockedUseOrganization.mockReturnValue({
      activeOrganization: { displayName: "Acme Care", logoUrl: null, primaryColor: null },
      loading: false
    } as never);

    renderShell();

    // Appears twice - once as the sidebar's own header, once in the top
    // bar's greeting - both real, simultaneously-rendered chrome.
    expect(screen.getAllByText(/Acme Care/).length).toBeGreaterThan(0);
    expect(screen.getByText("page content")).toBeInTheDocument();
  });
});
