import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAttentionCounts, useAwsApi } from "./aws-workspace";
import { useAgencyClock } from "./agency-clock";
import { useHomeIssues } from "./home-data";
import { DISPLAY_LABEL, filterOptions, monthGrid, NO_FILTERS, stateOfShift, type CalendarView, type ShiftFilters } from "./schedule-model";
import type { Shift } from "./schedule-page";
import { ShortHelp } from "./help-text";
import { useCaregivers } from "./care-team-admin";
import { nameWithCode } from "./name-label";
import { eligibleReplacements, type Candidate, type Matches } from "./replacement-model";

export function ViewTabs({ view, onChange }: { view: CalendarView; onChange: (v: CalendarView) => void }) {
  return (
    <div role="group" aria-label="Calendar view" className="inline-flex overflow-hidden rounded-lg border border-slate-300">
      {(["day", "week", "month"] as const).map((v) => (
        <button key={v} type="button" aria-pressed={view === v} onClick={() => onChange(v)} className={`min-h-[44px] px-4 text-sm font-semibold md:min-h-[40px] ${view === v ? "bg-og-accent text-og-on-accent" : "bg-og-card text-slate-900 hover:bg-slate-50"}`}>
          {v === "day" ? "Day" : v === "week" ? "Week" : "Month"}
        </button>
      ))}
    </div>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** One month: a button per day showing how many visits and how many need a caregiver. Choosing a day opens it. Days outside the month are empty. */
export function MonthGrid({ anchor, shifts, onPickDay }: { anchor: string; shifts: Shift[]; onPickDay: (d: string) => void }) {
  const byDay = new Map<string, Shift[]>();
  for (const s of shifts) byDay.set(s.localDate, [...(byDay.get(s.localDate) ?? []), s]);
  return (
    <div role="grid" aria-label="Month" data-testid="month-grid" className="overflow-hidden rounded-lg border border-slate-200 bg-og-card">
      <div role="row" className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-semibold text-slate-700">
        {WEEKDAYS.map((d) => <div key={d} role="columnheader" className="py-1">{d}</div>)}
      </div>
      {monthGrid(anchor).map((week, i) => (
        <div role="row" key={i} className="grid grid-cols-7">
          {week.map((d, j) => {
            if (!d) return <div role="gridcell" key={j} className="min-h-[56px] border-b border-r border-slate-100 bg-slate-50/50" />;
            const list = byDay.get(d) ?? [];
            const open = list.filter((s) => stateOfShift(s) === "needs_coverage").length;
            const label = `${d}: ${list.length} visit${list.length === 1 ? "" : "s"}${open ? `, ${open} need${open === 1 ? "s" : ""} coverage` : ""}`;
            return (
              <div role="gridcell" key={j} className="border-b border-r border-slate-100">
                <button type="button" aria-label={label} onClick={() => onPickDay(d)} className="flex min-h-[56px] w-full flex-col items-start gap-0.5 p-1 text-left hover:bg-slate-50">
                  <span className="text-xs font-semibold text-slate-900">{Number(d.slice(8))}</span>
                  {list.length > 0 ? <span className="text-xs text-slate-700">{list.length}</span> : null}
                  {open > 0 ? <span className="text-xs font-bold text-red-700"><span aria-hidden="true">● </span>{open}</span> : null}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The scheduling overview: today, what is uncovered or urgent, one link to everything that needs action. Counts come from the same server list as Home. */
export function SchedulingOverview() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const { today } = useAgencyClock();
  const issues = useHomeIssues();
  const counts = useAttentionCounts(); // the Scheduling badge's own number (server count)
  const todays = useQuery({
    queryKey: ["aws-shifts", activeOrganizationId, today, today],
    queryFn: async () => (await api.get<{ shifts: Shift[] }>("/v1/shifts", { organizationId: activeOrganizationId, from: today, to: today })).shifts,
    enabled: !!activeOrganizationId,
  });
  const list = (todays.data ?? []).filter((s) => stateOfShift(s) !== "cancelled");
  const uncoveredToday = list.filter((s) => stateOfShift(s) === "needs_coverage").length;
  const rows = issues.data?.issues ?? [];
  const urgent = rows.filter((i) => i.severity !== "routine");
  const num = "font-og-mono font-semibold tabular-nums";
  return (
    <section aria-label="Scheduling overview" data-testid="scheduling-overview" className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-slate-200 bg-og-card px-3 py-2 text-sm">
      <p><span className="text-slate-600">Today </span><span className={`${num} text-slate-950`}>{todays.isError ? "—" : list.length}</span><span className="text-slate-600"> visits</span></p>
      <p><span className="text-slate-600">Today, no caregiver </span><span className={`${num} ${uncoveredToday ? "text-red-700" : "text-slate-950"}`}>{todays.isError ? "—" : uncoveredToday}</span></p>
      {counts.data?.scheduling ? <p data-testid="scheduling-now"><span className="text-slate-600">Need action now (start within 48 hours or started) </span><span className={`${num} ${counts.data.scheduling.critical ? "text-red-700" : "text-slate-950"}`}>{counts.data.scheduling.count}</span></p> : null}
      <p><span className="text-slate-600">Urgent exceptions </span><span className={`${num} text-slate-950`}>{issues.isError ? "—" : urgent.length}</span> <Link className="ml-1 inline-flex min-h-11 items-center font-semibold underline md:min-h-8" to="/action-needed">See all</Link></p>
      {todays.isError || issues.isError ? <p role="status" className="basis-full text-red-700">Some figures could not be loaded. They show — and are not zero.</p> : null}
    </section>
  );
}

export function FilterBar({ shifts, filters, onChange }: { shifts: Shift[]; filters: ShiftFilters; onChange: (f: ShiftFilters) => void }) {
  const [open, setOpen] = useState(false);
  const active = Object.values(filters).filter(Boolean).length;
  const o = open ? filterOptions(shifts) : null;
  const sel = (label: string, key: keyof ShiftFilters, opts: Array<[string, string]>, extra?: Array<[string, string]>) => (
    <label className="text-xs font-medium text-slate-600">{label}
      <select value={filters[key]} onChange={(e) => onChange({ ...filters, [key]: e.target.value })} className="mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-og-card px-2 py-1 text-sm text-slate-900 md:min-h-9">
        <option value="">All</option>{[...(extra ?? []), ...opts].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
  return (
    <div className={open ? "basis-full space-y-2" : "space-y-2"} data-testid="shift-filters">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex min-h-[44px] items-center text-sm font-semibold text-slate-900 underline md:min-h-[32px]">{open ? "Hide filters" : active ? `Filters (${active} on)` : "Filters"}</button>
        {active > 0 ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => onChange(NO_FILTERS)}>Clear filters</Button> : null}
      </div>
      {o ? (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {sel("Caregiver", "caregiver", o.caregivers, [["open", "No caregiver"]])}
          {sel("Client", "client", o.clients)}
          {sel("Service", "service", o.services)}
          {sel("Status", "state", o.states)}
        </div>
      ) : null}
    </div>
  );
}

/** Who could cover this shift, from the agency's matching rule (the same one Care Requests use). The office chooses; nothing is assigned here. */
export function ReplacementSuggestions({ shift, onChoose }: { shift: Shift; onChoose: (caregiverRecordId: string) => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [why, setWhy] = useState<string | null>(null);
  const roster = useCaregivers();
  const q = useQuery({
    queryKey: ["shift-matches", activeOrganizationId, shift.shiftId, shift.startsAt, shift.endsAt],
    enabled: !!activeOrganizationId && !!shift.serviceId,
    queryFn: async () => (await api.post<{ matches: Matches }>("/v1/matching/candidates", { organizationId: activeOrganizationId, serviceId: shift.serviceId, clientId: shift.clientId, intervals: [{ startsAt: shift.startsAt, endsAt: shift.endsAt }] })).matches,
  });
  if (q.isLoading) return <p role="status" className="text-sm text-slate-500">Looking for caregivers who could cover this…</p>;
  if (q.isError || !q.data) return <p role="alert" className="text-sm text-slate-700" data-testid="suggestions-error">Suggestions could not be loaded. You can still choose a caregiver below.</p>;
  const eligible = eligibleReplacements(q.data, shift.caregiverRecordId);
  const shown = eligible.slice(0, 5);
  const dup = new Set((roster.data ?? []).filter((c) => c.duplicateName).map((c) => c.caregiverRecordId));
  const more = shown.map((c) => `${c.name}: ${c.assignedToClient ? "already works with this client; " : ""}${c.score.complete ? `score ${c.score.total}` : "score incomplete"}`).join(" · ");
  return (
    <div className="space-y-1 rounded-lg border border-slate-200 bg-og-card p-2" data-testid="replacement-suggestions">
      <p className="text-sm font-semibold text-slate-900">Suggested</p>
      {shown.length > 0 ? <ShortHelp className="text-xs text-slate-600" details={`Eligible caregivers only, in the order of the agency's matching rule (${q.data.ruleVersion}, ${q.data.ruleStatus}). ${more}`}>Best match first.</ShortHelp> : null}
      {eligible.length === 0 ? <p className="text-sm text-slate-700" data-testid="no-eligible">No eligible caregiver was found for this time. The shift stays flagged until one is assigned.</p> : (
        <ul className="space-y-1">
          {shown.map((c: Candidate, n) => (
            <li key={c.caregiverRecordId} className="flex flex-wrap items-center gap-x-3 text-sm" data-testid="suggestion">
              <span className="font-og-mono text-xs text-slate-500">{n + 1}</span>
              <span className="font-semibold text-slate-900">{nameWithCode(c.name, c.caregiverCode, dup.has(c.caregiverRecordId))}</span>
              <button type="button" className="min-h-[44px] text-sm font-semibold underline md:min-h-[32px]" aria-expanded={why === c.caregiverRecordId} onClick={() => setWhy(why === c.caregiverRecordId ? null : c.caregiverRecordId)}>Why</button>
              <Button type="button" variant="secondary" className="min-h-11" aria-label={`Select ${c.name}`} onClick={() => onChoose(c.caregiverRecordId)}>Select</Button>
              {why === c.caregiverRecordId ? <ul className="basis-full list-disc pl-8 text-xs text-slate-700">{c.score.components.map((k) => <li key={k.name}>{k.name}: {k.status === "scored" ? `${k.points} of ${k.weight}` : k.status}: {k.reason}</li>)}</ul> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { DISPLAY_LABEL };
