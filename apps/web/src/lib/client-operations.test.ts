import { describe, expect, it } from "vitest";
import {
  calculateServiceProgress,
  monthStartInTimeZone,
  type ClientOperationRow,
} from "./client-operations";

const baseRow: ClientOperationRow = {
  client_id: "client-1",
  client_name: "Jamie Smith",
  client_code: "CL-1",
  caregiver_display_code: "Oak Tree",
  client_status: "active",
  location: "Temecula, CA",
  service_id: "service-1",
  service_name: "Respite",
  max_monthly_hours: 80,
  authorization_period_end: "2026-12-31",
  delivered_minutes: 600,
  assigned_caregivers: ["Jordan Rivera"],
  requested_windows: [],
  top_match_name: "Jordan Rivera",
  top_match_score: 91,
  gap_reason: null,
  gap_notes: null,
  gap_resolved: false,
};

describe("client operations calculations", () => {
  it("uses the organization's local month", () => {
    expect(
      monthStartInTimeZone(
        new Date("2026-09-01T01:00:00.000Z"),
        "America/Los_Angeles",
      ),
    ).toBe("2026-08-01");
  });

  it("flags a service whose month-end pace will fall short", () => {
    const progress = calculateServiceProgress(
      baseRow,
      new Date("2026-08-24T19:00:00.000Z"),
    );
    expect(progress.deliveredHours).toBe(10);
    expect(progress.remainingHours).toBe(70);
    expect(progress.health).toBe("behind");
  });

  it("treats missing assignment as a staffing gap before forecasting", () => {
    expect(
      calculateServiceProgress(
        { ...baseRow, assigned_caregivers: [] },
        new Date("2026-08-24T19:00:00.000Z"),
      ).health,
    ).toBe("unassigned");
  });

  it("never invents remaining hours without an authorization", () => {
    const progress = calculateServiceProgress({
      ...baseRow,
      max_monthly_hours: null,
    });
    expect(progress.remainingHours).toBeNull();
    expect(progress.projectedHours).toBeNull();
    expect(progress.health).toBe("no-authorization");
  });

  it("projects from the schedule, not a straight line, when the breakdown is available", () => {
    // Day 2 of the month: 4 h worked, 76 h still scheduled. A straight-line
    // pace (4 h / 2 days x 30) would forecast 60 h and call this 'behind'.
    const progress = calculateServiceProgress(
      {
        ...baseRow,
        delivered_minutes: 240,
        worked_minutes: 240,
        requested_minutes: 80 * 60,
        scheduled_minutes: 80 * 60,
        upcoming_scheduled_minutes: 76 * 60,
        confirmed_minutes: 180,
        billable_minutes: 180,
        remaining_minutes: 0,
        projected_minutes: 80 * 60,
      },
      new Date("2026-09-02T19:00:00.000Z"),
    );
    expect(progress.projectionBasis).toBe("plan");
    expect(progress.projectedHours).toBe(80);
    expect(progress.remainingHours).toBe(0);
    expect(progress.health).toBe("on-track");
    expect(progress.breakdown).toEqual({
      requestedHours: 80,
      scheduledHours: 80,
      upcomingHours: 76,
      confirmedHours: 3,
      billableHours: 3,
    });
  });

  it("reports a plan that exceeds the authorization as negative remaining", () => {
    const progress = calculateServiceProgress(
      { ...baseRow, worked_minutes: 600, scheduled_minutes: 5400, upcoming_scheduled_minutes: 4800, remaining_minutes: -600, projected_minutes: 5400 },
      new Date("2026-08-10T19:00:00.000Z"),
    );
    expect(progress.remainingHours).toBe(-10);
    expect(progress.projectedHours).toBe(90);
  });

  it("flags 'behind' when the scheduled plan falls short of the authorization", () => {
    const progress = calculateServiceProgress(
      { ...baseRow, worked_minutes: 600, scheduled_minutes: 1800, upcoming_scheduled_minutes: 1200, remaining_minutes: 2400, projected_minutes: 1800 },
      new Date("2026-08-24T19:00:00.000Z"),
    );
    expect(progress.projectedHours).toBe(30);
    expect(progress.health).toBe("behind");
  });
});
