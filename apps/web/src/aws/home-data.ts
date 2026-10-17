import { useEffect, useState } from "react";
import type { Shift } from "./schedule-page";

/** The current time, re-read every `ms` so "in progress" and "last updated" do not freeze on a page left open. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** Visits still to come or running now, soonest first. Finished and cancelled shifts are on the schedule, not here. */
export function todaysVisits(shifts: Shift[], now: number): Shift[] {
  return shifts
    .filter((s) => (s.coverageState === "covered" || s.coverageState === "needs_coverage") && Date.parse(s.endsAt) > now)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.shiftId < b.shiftId ? -1 : 1));
}
