// A day/time window whose end is earlier than its start ends the NEXT day
// (overnight), matching supabase/migrations/20260826030000_overnight_availability.sql.
// Equal start and end is not a window.
export type WindowKind = "same_day" | "overnight" | "invalid";

export function windowKind(start: string, end: string): WindowKind {
  if (!start || !end) return "invalid";
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  if (s === e) return "invalid";
  return e > s ? "same_day" : "overnight";
}

export function windowHint(start: string, end: string): string | null {
  const kind = windowKind(start, end);
  if (kind === "overnight") return "Overnight: ends the next day.";
  if (kind === "invalid" && start && end) return "Start and end can't be the same.";
  return null;
}
