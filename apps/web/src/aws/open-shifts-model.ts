import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useAgencyClock } from "./agency-clock";

/** One opening on the caregiver board: service city and time only. The reference is opaque; there is no client information in this payload (0086). */
export interface BoardShift { shiftRef: string; serviceCity: string | null; startsAt: string; endsAt: string; timezone: string; myRequestStatus: "requested" | null; totalCount: number | string }
export interface MyOpenShiftRequest { shiftRef: string; outcome: "requested" | "confirmed" | "filled" | "changed" | "withdrawn" | "declined" | "closed"; serviceCity: string | null; startsAt: string; endsAt: string; requestedAt: string }
export interface OpeningLanding { shiftRef: string; state: "available" | "requested" | "confirmed" | "filled" | "changed" | "unavailable"; serviceCity: string | null; startsAt: string | null; endsAt: string | null }

/** "Fri, Nov 27 1:30 PM – 5:00 PM", and both dates when the shift crosses midnight in the agency's time zone. */
export function useWindowLabel() {
  const { tz, when, time } = useAgencyClock();
  const day = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
  return (startsAt: string, endsAt: string) => (day(startsAt) === day(endsAt) ? `${when(startsAt)} – ${time(endsAt)}` : `${when(startsAt)} – ${when(endsAt)}`);
}

export const OUTCOME_LABEL: Record<MyOpenShiftRequest["outcome"], { text: string; tone: string }> = {
  requested: { text: "Requested", tone: "bg-amber-100 text-amber-900" },
  confirmed: { text: "Confirmed", tone: "bg-emerald-100 text-emerald-900" },
  filled: { text: "Filled", tone: "bg-slate-100 text-slate-800" },
  changed: { text: "Changed. Request it again", tone: "bg-sky-100 text-sky-900" },
  withdrawn: { text: "Withdrawn", tone: "bg-slate-100 text-slate-800" },
  declined: { text: "Not chosen", tone: "bg-slate-100 text-slate-800" },
  closed: { text: "No longer available", tone: "bg-slate-100 text-slate-800" },
};

export function useOpenShiftBoard() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["aws-open-shift-board", activeOrganizationId],
    queryFn: async () => (await api.get<{ shifts: BoardShift[] }>("/v1/open-shift-board", { organizationId: activeOrganizationId, limit: "100" })).shifts,
    enabled: !!activeOrganizationId,
  });
}

