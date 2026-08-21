import { describe, expect, it } from "vitest";
import {
  MAX_RECURRING_OCCURRENCES,
  formatDateRangeSummary,
  formatWeekdaySummary,
  generateRecurringDates,
  parseLocalDate
} from "./recurring-shifts";

describe("generateRecurringDates", () => {
  it("generates Mon/Wed/Fri occurrences within the range", () => {
    // 2026-08-24 is a Monday.
    const dates = generateRecurringDates("2026-08-24", "2026-09-04", new Set([1, 3, 5]));
    expect(dates).toEqual([
      "2026-08-24", // Mon
      "2026-08-26", // Wed
      "2026-08-28", // Fri
      "2026-08-31", // Mon
      "2026-09-02", // Wed
      "2026-09-04" // Fri
    ]);
  });

  it("includes both boundary dates when they match a selected weekday", () => {
    const dates = generateRecurringDates("2026-08-24", "2026-08-24", new Set([1]));
    expect(dates).toEqual(["2026-08-24"]);
  });

  it("excludes the start date when its weekday isn't selected", () => {
    // 2026-08-24 is a Monday; only Wednesdays are selected.
    const dates = generateRecurringDates("2026-08-24", "2026-08-26", new Set([3]));
    expect(dates).toEqual(["2026-08-26"]);
  });

  it("returns an empty list when the end date is before the start date", () => {
    expect(generateRecurringDates("2026-09-01", "2026-08-01", new Set([1]))).toEqual([]);
  });

  it("returns an empty list when no weekdays are selected", () => {
    expect(generateRecurringDates("2026-08-24", "2026-09-04", new Set())).toEqual([]);
  });

  it("can exceed MAX_RECURRING_OCCURRENCES - the caller enforces the cap, not the generator", () => {
    // Every day for a year, unfiltered - well over 52.
    const dates = generateRecurringDates("2026-01-01", "2026-12-31", new Set([0, 1, 2, 3, 4, 5, 6]));
    expect(dates.length).toBeGreaterThan(MAX_RECURRING_OCCURRENCES);
  });

  it("does not skip or duplicate a date across a US DST transition", () => {
    // 2026-11-01 is a Sunday - the US falls back to standard time that day.
    const dates = generateRecurringDates("2026-10-25", "2026-11-08", new Set([0]));
    expect(dates).toEqual(["2026-10-25", "2026-11-01", "2026-11-08"]);
  });
});

describe("parseLocalDate", () => {
  it("parses as local midnight, not UTC midnight", () => {
    const date = parseLocalDate("2026-08-24");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(7);
    expect(date.getDate()).toBe(24);
    expect(date.getHours()).toBe(0);
  });
});

describe("formatWeekdaySummary", () => {
  it("orders selected weekdays by week order, not selection order", () => {
    expect(formatWeekdaySummary(new Set([5, 1, 3]))).toBe("Mon/Wed/Fri");
  });

  it("returns an empty string when nothing is selected", () => {
    expect(formatWeekdaySummary(new Set())).toBe("");
  });
});

describe("formatDateRangeSummary", () => {
  it("formats a range as first–last", () => {
    const dates = generateRecurringDates("2026-08-24", "2026-09-04", new Set([1, 3, 5]));
    expect(formatDateRangeSummary(dates)).toBe("Aug 24–Sep 4");
  });

  it("returns an empty string for no dates", () => {
    expect(formatDateRangeSummary([])).toBe("");
  });
});
