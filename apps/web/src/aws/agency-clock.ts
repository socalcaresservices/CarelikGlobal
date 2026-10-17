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
