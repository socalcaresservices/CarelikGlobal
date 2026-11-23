// The office schedule lists the ACTIVE schedule by default: cancelled shifts and finished shifts from before today are in History, not deleted.
import { describe, expect, it } from "vitest";
import { ACTIVE_FILTERS, NO_FILTERS, applyFilters, hasFilters, isHistoryShift } from "./schedule-model";
import type { Shift } from "./schedule-page";

const TODAY = "2026-12-01";
const mk = (id: string, localDate: string, coverageState: string, displayState?: string): Shift => ({ shiftId: id, localDate, coverageState, displayState: displayState ?? null, startsAt: `${localDate}T17:00:00Z`, endsAt: `${localDate}T19:00:00Z`, clientId: "c1", clientCode: "CL-1", serviceId: "s1", caregiverRecordId: "g1" } as unknown as Shift);
const shifts = [
  mk("nov-cancelled", "2026-11-10", "cancelled"),
  mk("nov-completed", "2026-11-11", "completed", "completed"),
  mk("nov-partial", "2026-11-12", "completed", "partial"),
  mk("nov-noshow", "2026-11-13", "no_show"),
  mk("nov-review", "2026-11-14", "completed", "in_review"),
  mk("nov-missed", "2026-11-15", "scheduled", "missed"),
  mk("nov-notverified", "2026-11-16", "scheduled", "delivered_not_verified"),
  mk("today-completed", "2026-12-01", "completed", "completed"),
  mk("future-cancelled", "2026-12-20", "cancelled"),
  mk("future-booked", "2026-12-21", "covered", "covered"),
  mk("future-open", "2026-12-22", "needs_coverage", "needs_coverage"),
];
const ids = (f: typeof ACTIVE_FILTERS) => applyFilters(shifts, f, TODAY).map((s) => s.shiftId);

describe("active schedule and history", () => {
  it("Active hides cancelled shifts (any date) and finished shifts dated before today; it keeps everything that still needs someone", () => {
    expect(ids(ACTIVE_FILTERS)).toEqual(["nov-review", "nov-missed", "nov-notverified", "today-completed", "future-booked", "future-open"]);
  });
  it("History is exactly the complement, and Everything is all of them: nothing is lost between the views", () => {
    const hist = ids({ ...ACTIVE_FILTERS, show: "history" });
    expect(hist).toEqual(["nov-cancelled", "nov-completed", "nov-partial", "nov-noshow", "future-cancelled"]);
    expect(ids({ ...ACTIVE_FILTERS, show: "all" })).toHaveLength(shifts.length);
    expect([...ids(ACTIVE_FILTERS), ...hist].sort()).toEqual(shifts.map((s) => s.shiftId).sort());
  });
  it("the other filters still combine with the view", () => {
    expect(ids({ ...ACTIVE_FILTERS, state: "missed" })).toEqual(["nov-missed"]);
    expect(ids({ ...ACTIVE_FILTERS, show: "history", state: "cancelled" })).toEqual(["nov-cancelled", "future-cancelled"]);
  });
  it("without a date only cancelled shifts are history (older callers keep working), and NO_FILTERS is unchanged", () => {
    expect(applyFilters(shifts, ACTIVE_FILTERS).map((s) => s.shiftId)).not.toContain("nov-cancelled");
    expect(applyFilters(shifts, ACTIVE_FILTERS)).toContainEqual(expect.objectContaining({ shiftId: "nov-completed" }));
    expect(applyFilters(shifts, NO_FILTERS)).toHaveLength(shifts.length);
    expect(isHistoryShift(shifts[1]!, TODAY)).toBe(true);
  });
  it("the Active schedule on its own is not counted as a filter being on", () => {
    expect(hasFilters(ACTIVE_FILTERS)).toBe(false);
    expect(hasFilters({ ...ACTIVE_FILTERS, show: "history" })).toBe(true);
    expect(hasFilters({ ...ACTIVE_FILTERS, client: "c1" })).toBe(true);
  });
});
