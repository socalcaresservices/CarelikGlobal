// Calendar views, shift states and filters for the schedule (Board 3 requirements 1, 2, 5 and 15). Pure functions: the rules the screens share.
import { nameWithCode } from "./name-label";
import type { Shift } from "./schedule-page";

export type CalendarView = "day" | "week" | "month";
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
export const monthEnd = (d: string) => { const [y, m] = d.split("-").map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10); };
export const addMonths = (d: string, n: number) => { const [y, m] = d.split("-").map(Number) as [number, number]; return new Date(Date.UTC(y, m - 1 + n, 1, 12)).toISOString().slice(0, 10); };

/** The dates the server is asked for. The month view asks for the whole month; the grid pads the weeks around it with no data. */
export function viewRange(view: CalendarView, anchor: string): { from: string; to: string } {
  if (view === "day") return { from: anchor, to: anchor };
  if (view === "week") return { from: anchor, to: addDays(anchor, 6) };
  return { from: monthStart(anchor), to: monthEnd(anchor) };
}
export function stepAnchor(view: CalendarView, anchor: string, direction: 1 | -1): string {
  return view === "day" ? addDays(anchor, direction) : view === "week" ? addDays(anchor, 7 * direction) : addMonths(anchor, direction);
}

export const DISPLAY_LABEL: Record<string, string> = {
  covered: "Covered", needs_coverage: "Unfilled", in_progress: "In progress", verification_pending: "Verification pending", in_review: "In review", partial: "Partial visit",
  completed: "Completed", missed: "Missed: no visit record", not_delivered: "Not delivered", delivered_not_verified: "Delivered: not verified", awaiting_record: "Awaiting a decision",
  cancelled: "Cancelled", no_show: "No-show",
};
export const DISPLAY_BADGE: Record<string, string> = {
  covered: "bg-emerald-100 text-emerald-900", needs_coverage: "bg-red-100 text-red-900 font-bold", in_progress: "bg-sky-100 text-sky-900", verification_pending: "bg-slate-200 text-slate-800",
  in_review: "bg-amber-100 text-amber-900", partial: "bg-amber-100 text-amber-900", completed: "bg-slate-200 text-slate-800", missed: "bg-amber-100 text-amber-900 font-semibold",
  not_delivered: "bg-slate-200 text-slate-700", delivered_not_verified: "bg-amber-100 text-amber-900", awaiting_record: "bg-amber-100 text-amber-900", cancelled: "bg-slate-200 text-slate-700", no_show: "bg-amber-100 text-amber-900",
};
/** What the server decided (0075), or the older coverage state when an older response has no decision. */
export const stateOfShift = (s: Pick<Shift, "coverageState"> & { displayState?: string | null }) => s.displayState ?? s.coverageState;

export interface ShiftFilters { caregiver: string; client: string; service: string; state: string }
export const NO_FILTERS: ShiftFilters = { caregiver: "", client: "", service: "", state: "" };
export const hasFilters = (f: ShiftFilters) => Object.values(f).some(Boolean);
export function applyFilters(shifts: Shift[], f: ShiftFilters): Shift[] {
  return shifts.filter((s) => (!f.caregiver || (f.caregiver === "open" ? !s.caregiverRecordId : s.caregiverRecordId === f.caregiver)) && (!f.client || s.clientId === f.client)
    && (!f.service || s.serviceId === f.service) && (!f.state || stateOfShift(s) === f.state));
}
/** The choices a filter offers: only what is in the loaded shifts, so every choice matches something. */
export function filterOptions(shifts: Shift[]) {
  const pick = (id: (s: Shift) => string | null | undefined, label: (s: Shift) => string | null | undefined) => {
    const m = new Map<string, string>();
    for (const s of shifts) { const k = id(s); const l = label(s); if (k && l) m.set(k, l); }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  };
  return {
    caregivers: pick((s) => s.caregiverRecordId, (s) => (s.caregiverName ?? "Caregiver")),
    clients: pick((s) => s.clientId, (s) => (s.clientName ? nameWithCode(s.clientName, s.clientCode, s.duplicateName) : s.clientCode)),
    services: pick((s) => s.serviceId, (s) => s.serviceName),
    states: [...new Set(shifts.map(stateOfShift))].map((k) => [k, DISPLAY_LABEL[k] ?? k] as [string, string]).sort((a, b) => a[1].localeCompare(b[1])),
  };
}

/** The weeks of a month grid (Monday first); null for days outside the month. */
export function monthGrid(anchor: string): Array<Array<string | null>> {
  const first = monthStart(anchor), last = monthEnd(anchor);
  const lead = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = first; d <= last; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
