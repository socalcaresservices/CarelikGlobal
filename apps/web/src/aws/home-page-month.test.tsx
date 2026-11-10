// F7 (docs/product/SCHEDULING_DASHBOARD_REVIEW_PACKAGE_2026-10-12.md): the month Home opens on must come from
// the AGENCY's time zone, never the browser clock. Monthly authorization figures follow the agency's calendar.
// FIXED (2026-10-17): Home and the client balance month use the agency time zone (the defect was pinned with `it.fails`). SYNTHETIC data only.
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const monthsRequested: string[] = [];
vi.mock("./attention", async (orig) => ({ ...(await orig<typeof import("./attention")>()), useAttentionOverview: () => ({ data: undefined, isLoading: true, isError: false }) }));
vi.mock("./home-data", async (orig) => ({ ...(await orig<typeof import("./home-data")>()), useHomeIssues: () => ({ isError: false }) }));
vi.mock("./continuity-page", () => ({ ContinuityStatusCard: () => null }));
vi.mock("./home-extras", () => ({ QuickActions: () => null, TodaysVisits: () => null, RefreshStatus: () => null, TopIssues: () => null, CollapseButton: () => null }));
vi.mock("@/providers/organization-provider", () => ({
  useOrganization: () => ({
    hasPermission: () => false,
    role: "manager",
    activeOrganization: { timezone: "America/Los_Angeles" },
  }),
}));
vi.mock("./aws-workspace", async (orig) => ({
  ...(await orig<typeof import("./aws-workspace")>()),
  useUtilisation: (monthStart: string) => {
    monthsRequested.push(monthStart);
    return { data: [], isLoading: false, isError: false };
  },
}));

import { AwsHomePage } from "./home-page";

describe("Home month uses the agency time zone", () => {
  const realTz = process.env.TZ;
  beforeEach(() => {
    monthsRequested.length = 0;
    process.env.TZ = "UTC"; // the browser's clock
    // 2026-11-01 03:00 UTC is still 2026-10-31 20:00 in Los Angeles (PDT).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T03:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  it("opens on the agency's current month (2026-10), not the browser's (2026-11)", () => {
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><AwsHomePage /></MemoryRouter></QueryClientProvider>);
    expect((screen.getByLabelText("Month") as HTMLInputElement).value).toBe("2026-10");
    expect(monthsRequested.at(-1)).toBe("2026-10-01");
  });
});
