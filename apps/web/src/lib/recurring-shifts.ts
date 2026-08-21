// Pure date generation for the Schedule page's "Repeats" option - kept
// separate from schedule-page.tsx so the weekday/range math (the part
// most likely to have an off-by-one or timezone bug) can be unit tested
// without rendering the page. No backend validation is duplicated here:
// this only decides *which calendar dates* to attempt, never whether a
// given date is actually schedulable - shifts_validate_authorization and
// shifts_validate_caregiver_overlap (both server-side triggers) remain
// the sole authority on that, per occurrence, when each row is inserted.

export const MAX_RECURRING_OCCURRENCES = 52;

export const WEEKDAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" }
];

const WEEKDAY_LABEL_BY_VALUE = new Map(WEEKDAY_OPTIONS.map((option) => [option.value, option.label]));

// Parses a YYYY-MM-DD string as a local-time calendar date (year/month/day
// passed straight to the Date constructor) rather than via `new
// Date("YYYY-MM-DD")`, which JS parses as UTC midnight - shifting to the
// previous calendar day in any timezone west of UTC. Every date in this
// module goes through this constructor so weekday math (.getDay()) always
// reflects the browser's local calendar, never a UTC-shifted one.
export function parseLocalDate(dateStr: string): Date {
  const parts = dateStr.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  return new Date(year, month - 1, day);
}

export function formatLocalDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Every calendar date from startDate to endDate (both YYYY-MM-DD, both
// inclusive) whose local weekday is in `weekdays` (0 = Sunday ... 6 =
// Saturday, matching Date.getDay()). Not capped here - MAX_RECURRING_OCCURRENCES
// is a submission-time check the caller applies to the result, so a bad
// range produces a clear "narrow this down" error instead of a silently
// truncated schedule.
export function generateRecurringDates(startDate: string, endDate: string, weekdays: Set<number>): string[] {
  if (weekdays.size === 0) return [];
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  if (end.getTime() < start.getTime()) return [];

  const dates: string[] = [];
  const cursor = new Date(start);
  // Belt-and-suspenders iteration cap (a year of daily dates) so a
  // malformed date pair can never spin this loop indefinitively - the
  // real, user-facing cap is MAX_RECURRING_OCCURRENCES, enforced by the
  // caller against this function's result.
  let guard = 0;
  while (cursor.getTime() <= end.getTime() && guard < 366) {
    if (weekdays.has(cursor.getDay())) {
      dates.push(formatLocalDate(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return dates;
}

// "Mon/Wed/Fri" - selected weekdays in week order (not selection order),
// for the create-shift preview line.
export function formatWeekdaySummary(weekdays: Set<number>): string {
  return WEEKDAY_OPTIONS.filter((option) => weekdays.has(option.value))
    .map((option) => option.label)
    .join("/");
}

export function formatDateRangeSummary(dates: string[]): string {
  if (dates.length === 0) return "";
  const first = parseLocalDate(dates[0]!);
  const last = parseLocalDate(dates[dates.length - 1]!);
  const fmt = (date: Date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return dates.length === 1 ? fmt(first) : `${fmt(first)}–${fmt(last)}`;
}

export function weekdayLabel(value: number): string {
  return WEEKDAY_LABEL_BY_VALUE.get(value) ?? "";
}
