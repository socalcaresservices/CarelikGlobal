import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useIsPlatformOwner } from "@/lib/use-platform-owner";
import { RequirePlatformOwner } from "./require-platform-owner";

vi.mock("@/lib/use-platform-owner", () => ({ useIsPlatformOwner: vi.fn() }));

const mockedUseIsPlatformOwner = vi.mocked(useIsPlatformOwner);

function renderGuard() {
  return render(
    <RequirePlatformOwner>
      <div>platform content</div>
    </RequirePlatformOwner>
  );
}

describe("RequirePlatformOwner", () => {
  it("shows a loading state while platform_role is still resolving", () => {
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: false, loading: true });

    renderGuard();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("platform content")).not.toBeInTheDocument();
  });

  it("renders platform content for a platform owner", () => {
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: true, loading: false });

    renderGuard();
    expect(screen.getByText("platform content")).toBeInTheDocument();
  });

  // An organization owner/admin has full run of their own tenant (including
  // permissions a platform owner also happens to hold) but that is a
  // completely different privilege scope from platform administration -
  // this must stay denied no matter how permissive their own org's role is.
  it("denies an organization admin", () => {
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: false, loading: false });

    renderGuard();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("platform content")).not.toBeInTheDocument();
  });

  it("denies a caregiver/staff member", () => {
    mockedUseIsPlatformOwner.mockReturnValue({ isPlatformOwner: false, loading: false });

    renderGuard();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("platform content")).not.toBeInTheDocument();
  });
});
