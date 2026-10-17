// F7 (docs/product/SCHEDULING_DASHBOARD_REVIEW_PACKAGE_2026-10-12.md): the month Home opens on must come from
// the AGENCY's time zone, never the browser clock. Monthly authorization figures follow the agency's calendar.
// The known defect is recorded with `it.fails` (remove `.fails` when Home uses the agency time zone). SYNTHETIC data only.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const monthsRequested: string[] = [];
vi.mock("./attention", async (orig) => ({ ...(await orig<typeof import("./attention")>()), useAttentionOverview: () => ({ data: undefined, isLoading: true, isError: false }) }));
vi.mock("./continuity-page", () => ({ ContinuityStatusCard: () => null }));
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

  // OBSERVED FAILURE: Home builds the month from `new Date()` in the browser, so it opens on 2026-11.
  it.fails("opens on the agency's current month (2026-10), not the browser's (2026-11)", () => {
    render(<MemoryRouter><AwsHomePage /></MemoryRouter>);
    expect((screen.getByLabelText("Month") as HTMLInputElement).value).toBe("2026-10");
    expect(monthsRequested.at(-1)).toBe("2026-10-01");
  });

  it("CONTROL (passes today): the browser-clock month is what Home uses", () => {
    render(<MemoryRouter><AwsHomePage /></MemoryRouter>);
    expect((screen.getByLabelText("Month") as HTMLInputElement).value).toBe("2026-11");
  });
});
