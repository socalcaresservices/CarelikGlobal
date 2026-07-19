import { describe, expect, it } from "vitest";
import { getWeekEnd, getWeekStart } from "./week";

describe("getWeekStart", () => {
  it("returns the same Monday midnight when given a Monday", () => {
    const monday = new Date(2026, 6, 20, 15, 30); // Monday, July 20, 2026
    const result = getWeekStart(monday);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(20);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
  });

  it("returns the prior Monday when given a Sunday", () => {
    const sunday = new Date(2026, 6, 26, 10, 0); // Sunday, July 26, 2026
    const result = getWeekStart(sunday);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(20);
  });

  it("returns the same Monday for any weekday in between", () => {
    const thursday = new Date(2026, 6, 23, 8, 0); // Thursday, July 23, 2026
    const result = getWeekStart(thursday);
    expect(result.getDate()).toBe(20);
  });
});

describe("getWeekEnd", () => {
  it("is exactly 7 days after week start", () => {
    const start = getWeekStart(new Date(2026, 6, 20));
    const end = getWeekEnd(start);
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
