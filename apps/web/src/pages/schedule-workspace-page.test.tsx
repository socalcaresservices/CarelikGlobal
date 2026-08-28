import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { ScheduleWorkspacePage } from "./schedule-workspace-page";

vi.mock("@/providers/organization-provider", () => ({
  useOrganization: vi.fn(),
}));
vi.mock("./schedule-page", () => ({
  SchedulePage: () => <div>schedule content</div>,
}));

const mockedUseOrganization = vi.mocked(useOrganization);

describe("ScheduleWorkspacePage", () => {
  it("shows the sendable Visit Verification link above Schedule for visit managers", () => {
    mockedUseOrganization.mockReturnValue({
      hasPermission: vi.fn((permission: string) => permission === "visits.manage"),
    } as never);

    render(<ScheduleWorkspacePage />);

    expect(screen.getByText("Visit Verification Link")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy visit link" })).toBeInTheDocument();
    expect(screen.getByText("schedule content")).toBeInTheDocument();
  });

  it("keeps the staff share link hidden from users who cannot manage visits", () => {
    mockedUseOrganization.mockReturnValue({
      hasPermission: vi.fn(() => false),
    } as never);

    render(<ScheduleWorkspacePage />);

    expect(screen.queryByText("Visit Verification Link")).not.toBeInTheDocument();
    expect(screen.getByText("schedule content")).toBeInTheDocument();
  });
});
