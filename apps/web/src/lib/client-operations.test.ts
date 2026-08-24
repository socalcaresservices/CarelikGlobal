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
});
