import { describe, expect, it } from "vitest";
import {
  getEffectiveLimit,
  getEffectivePriceCents,
  getTrialDaysRemaining,
  getUsageStatus,
  isReadOnlyStatus
} from "./billing";

describe("getUsageStatus", () => {
  it("treats a null limit as unlimited", () => {
    expect(getUsageStatus(1000, null)).toBe("normal");
  });

  it("returns normal below 80%", () => {
    expect(getUsageStatus(15, 20)).toBe("normal");
  });

  it("returns warning_80 at 80%", () => {
    expect(getUsageStatus(16, 20)).toBe("warning_80");
  });

  it("returns warning_90 at 90%", () => {
    expect(getUsageStatus(18, 20)).toBe("warning_90");
  });

  it("returns at_limit at and beyond the cap", () => {
    expect(getUsageStatus(20, 20)).toBe("at_limit");
    expect(getUsageStatus(21, 20)).toBe("at_limit");
  });
});

describe("getEffectiveLimit", () => {
  it("falls back to the plan limit when there is no override", () => {
    expect(getEffectiveLimit(20, null, null)).toBe(20);
  });

  it("uses the override when it has no expiration", () => {
    expect(getEffectiveLimit(20, 25, null)).toBe(25);
  });

  it("uses the override while it hasn't expired", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(getEffectiveLimit(20, 25, future)).toBe(25);
  });

  it("falls back to the plan limit once the override has expired", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(getEffectiveLimit(20, 25, past)).toBe(20);
  });
});

describe("getEffectivePriceCents", () => {
  it("returns zero for a complimentary subscription regardless of price", () => {
    expect(getEffectivePriceCents(2900, 1500, true)).toBe(0);
  });

  it("uses the custom price when set", () => {
    expect(getEffectivePriceCents(2900, 1500, false)).toBe(1500);
  });

  it("falls back to the plan price otherwise", () => {
    expect(getEffectivePriceCents(2900, null, false)).toBe(2900);
  });
});

describe("getTrialDaysRemaining", () => {
  it("returns null when there is no trial end date", () => {
    expect(getTrialDaysRemaining(null)).toBeNull();
  });

  it("rounds up to whole days remaining", () => {
    const now = new Date("2026-08-09T00:00:00Z");
    const endsAt = new Date("2026-08-10T01:00:00Z").toISOString();
    expect(getTrialDaysRemaining(endsAt, now)).toBe(2);
  });

  it("never returns a negative number once expired", () => {
    const now = new Date("2026-08-09T00:00:00Z");
    const endsAt = new Date("2026-08-01T00:00:00Z").toISOString();
    expect(getTrialDaysRemaining(endsAt, now)).toBe(0);
  });
});

describe("isReadOnlyStatus", () => {
  it("flags trial_expired, suspended, and canceled as read-only", () => {
    expect(isReadOnlyStatus("trial_expired")).toBe(true);
    expect(isReadOnlyStatus("suspended")).toBe(true);
    expect(isReadOnlyStatus("canceled")).toBe(true);
  });

  it("does not flag trialing, active, or past_due", () => {
    expect(isReadOnlyStatus("trialing")).toBe(false);
    expect(isReadOnlyStatus("active")).toBe(false);
    expect(isReadOnlyStatus("past_due")).toBe(false);
  });
});
