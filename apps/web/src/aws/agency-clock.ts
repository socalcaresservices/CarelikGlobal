import { formatClockTime, formatWeekdayDate, formatWeekdayDateTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";

/** The agency's own "today" (its time zone, not the browser's) and the time formatters the schedule and Home share. */
export function useAgencyClock() {
  const { activeOrganization } = useOrganization();
  const tz = (activeOrganization as { timezone?: string } | null)?.timezone || "America/Los_Angeles";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const time = (iso: string) => formatClockTime(iso);
  const dayLabel = (d: string) => formatWeekdayDate(d);
  const when = (iso: string) => formatWeekdayDateTime(iso);
  return { tz, today, time, dayLabel, when };
}

/** The calendar month (YYYY-MM) it is right now in the agency's time zone. Monthly authorization figures follow the agency's calendar, never the browser's. */
export function agencyMonth(tz: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}`;
}
