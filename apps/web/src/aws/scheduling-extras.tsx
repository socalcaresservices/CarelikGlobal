import { InfoTip } from "./ui/info-tip";
// Scheduling (0053): make-up visits for lost time, and caregiver hour limits with the week's load. Every rule is enforced
// again by the server (same month as the missed visit, never more than the time still owed, the same authorization,
// readiness and conflict checks as any other shift); these forms only make the result clear.
import { nameWithCode } from "./name-label";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@carelik/ui";
import { formatDuration, formatWeekdayDate } from "@/lib/service-verification";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { caregiverName, useCaregivers } from "./care-team-admin";
import { Hint } from "./hint";

const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/** Schedule time to replace a cancelled, called-out or short shift. */
export function MakeupForm({ shiftId, caregiverRecordId, defaultDate, onClose, onDone }: {
  shiftId: string; caregiverRecordId: string | null; defaultDate: string; onClose: () => void; onDone: (text: string) => void;
}) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const caregivers = useCaregivers();
  const [form, setForm] = useState({ date: defaultDate, startTime: "09:00", endTime: "10:00", caregiverRecordId: caregiverRecordId ?? "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const id = `mk-${shiftId.slice(0, 8)}`;
  const change = (patch: Partial<typeof form>) => { setForm((f) => ({ ...f, ...patch })); key.current = newIdempotencyKey(); };
  async function submit() {
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ makeup: { reservedMinutes: number; remainingMinutes: number | string; unmadeMinutesAfter: number } }>(
        `/v1/shifts/${encodeURIComponent(shiftId)}/makeup`,
        { organizationId: activeOrganizationId, localDate: form.date, startTime: form.startTime, endTime: form.endTime, caregiverRecordId: form.caregiverRecordId || null },
        { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await queryClient.invalidateQueries({ queryKey: ["aws-shifts"] });
      onDone(`Make-up scheduled: ${formatDuration(r.makeup.reservedMinutes)} reserved; ${formatDuration(Number(r.makeup.remainingMinutes))} of authorized time left that month. ${
        r.makeup.unmadeMinutesAfter > 0 ? `${formatDuration(r.makeup.unmadeMinutesAfter)} of the missed time is still not made up.` : "The missed time is fully made up."}`);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved.") });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-2 grid gap-2 rounded-lg bg-slate-50 p-2 sm:grid-cols-2">
      <Hint details="It uses the month's authorized hours like any other shift." className="sm:col-span-2">Same month as the missed visit, and no longer than the time still owed.</Hint>
      <div><label htmlFor={`${id}-d`} className="block text-xs font-medium text-slate-600">Date</label><input id={`${id}-d`} type="date" value={form.date} onChange={(e) => change({ date: e.target.value })} className={inputClass} /></div>
      <div>
        <label htmlFor={`${id}-c`} className="block text-xs font-medium text-slate-600">Caregiver</label>
        <select id={`${id}-c`} value={form.caregiverRecordId} onChange={(e) => change({ caregiverRecordId: e.target.value })} className={inputClass}>
          <option value="">Open shift — fill later</option>
          {(caregivers.data ?? []).filter((c) => c.status === "ready" || c.status === "active").map((c) => <option key={c.caregiverRecordId} value={c.caregiverRecordId}>{nameWithCode(caregiverName(c), c.caregiverCode, c.duplicateName)}</option>)}
        </select>
      </div>
      <div><label htmlFor={`${id}-s`} className="block text-xs font-medium text-slate-600">Start time</label><input id={`${id}-s`} type="time" value={form.startTime} onChange={(e) => change({ startTime: e.target.value })} className={inputClass} /></div>
      <div><label htmlFor={`${id}-e`} className="block text-xs font-medium text-slate-600">End time</label><input id={`${id}-e`} type="time" value={form.endTime} onChange={(e) => change({ endTime: e.target.value })} className={inputClass} /></div>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={state.busy}>Schedule make-up</Button><button type="button" className="text-sm underline" onClick={onClose}>Close</button></div>
    </form>
  );
}

interface LimitRow { caregiverRecordId: string | null; caregiverName: string | null; maxDailyMinutes: number | null; maxWeeklyMinutes: number | null; mode: "report" | "block" }
interface LoadRow {
  caregiverRecordId: string; caregiverName: string; weekStart: string; scheduledMinutes: number | string; busiestDay: string; busiestDayMinutes: number | string;
  maxDailyMinutes: number | null; maxWeeklyMinutes: number | null; mode: "report" | "block" | null; overDaily: boolean; overWeekly: boolean;
}
const hoursText = (minutes: number | null) => (minutes === null ? "—" : formatDuration(minutes));

/** Hour limits (agency default and per caregiver) and each caregiver's scheduled hours for the week shown. */
export function HourLimitsPanel({ from, to, canManage }: { from: string; to: string; canManage: boolean }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const caregivers = useCaregivers();
  const limits = useQuery({
    queryKey: ["aws-hour-limits", activeOrganizationId],
    queryFn: async () => (await api.get<{ limits: LimitRow[] }>("/v1/hour-limits", { organizationId: activeOrganizationId })).limits,
    enabled: !!activeOrganizationId,
  });
  const policy = useQuery({
    queryKey: ["aws-work-hour-policy", activeOrganizationId],
    queryFn: async () => (await api.get<{ policy: { applies: boolean; maxDailyMinutes?: number; maxWeeklyMinutes?: number } }>("/v1/work-hour-policy", { organizationId: activeOrganizationId })).policy,
    enabled: !!activeOrganizationId,
  });
  const load = useQuery({
    queryKey: ["aws-caregiver-load", activeOrganizationId, from, to],
    queryFn: async () => (await api.get<{ load: LoadRow[] }>("/v1/caregiver-load", { organizationId: activeOrganizationId, from, to })).load,
    enabled: !!activeOrganizationId,
  });
  const [form, setForm] = useState({ caregiverRecordId: "", dailyHours: "", weeklyHours: "", mode: "report" as "report" | "block", reason: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: boolean }>({ busy: false, error: null, saved: false });
  const toMinutes = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 60));
  async function save(remove = false) {
    const daily = remove ? null : toMinutes(form.dailyHours);
    const weekly = remove ? null : toMinutes(form.weeklyHours);
    if (!remove && daily === null && weekly === null) return setState({ busy: false, error: "No limit entered. Enter hours a day, hours a week, or both.", saved: false });
    if ([daily, weekly].some((m) => m !== null && (!Number.isFinite(m) || m < 60))) return setState({ busy: false, error: "Limit too low. Enter whole hours, at least 1.", saved: false });
    if (form.reason.trim().length < 3) return setState({ busy: false, error: "Reason missing. Give the reason for this limit.", saved: false });
    setState({ busy: true, error: null, saved: false });
    try {
      await api.post("/v1/hour-limits", { organizationId: activeOrganizationId, caregiverRecordId: form.caregiverRecordId || null, maxDailyMinutes: daily, maxWeeklyMinutes: weekly, mode: form.mode, reason: form.reason.trim() });
      await queryClient.invalidateQueries({ queryKey: ["aws-hour-limits"] });
      await queryClient.invalidateQueries({ queryKey: ["aws-caregiver-load"] });
      setForm((f) => ({ ...f, dailyHours: "", weeklyHours: "", reason: "" }));
      setState({ busy: false, error: null, saved: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved."), saved: false });
    }
  }
  return (
    <div className="space-y-3">
      <section aria-label="Hours scheduled this week">
        <h3 className="text-sm font-semibold text-slate-900">Scheduled hours by week</h3><InfoTip label="About scheduled hours">These totals use planned shifts. Clocked hours are in visit reports.</InfoTip>
        {load.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {load.isError ? <p role="alert" className="text-sm text-red-700">{(load.error as Error).message}</p> : null}
        {load.data && load.data.length === 0 ? <p className="text-sm text-slate-600">No caregiver is scheduled this week.</p> : null}
        {load.data?.some((row) => row.overDaily || row.overWeekly) ? <p className="text-sm text-amber-900">Review existing overages in Shifts and reassign or reschedule as needed. Changing a limit does not move shifts already scheduled.</p> : null}
        <ul className="space-y-1">
          {(load.data ?? []).map((r) => (
            <li key={`${r.caregiverRecordId}-${r.weekStart}`} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-slate-200 bg-og-card px-3 py-2 text-sm">
              <span className="font-medium text-slate-900">{r.caregiverName}</span>
              <span className="tabular-nums text-slate-800">
                {formatDuration(Number(r.scheduledMinutes))} this week{r.maxWeeklyMinutes ? ` of ${formatDuration(r.maxWeeklyMinutes)}` : ""} · busiest day {formatWeekdayDate(r.busiestDay, "short")} {formatDuration(Number(r.busiestDayMinutes))}{r.maxDailyMinutes ? ` of ${formatDuration(r.maxDailyMinutes)}` : ""}
              </span>
              <span className="w-full text-xs text-slate-600">Daily limit {r.maxDailyMinutes ? formatDuration(r.maxDailyMinutes) : "none"} · Weekly limit {r.maxWeeklyMinutes ? formatDuration(r.maxWeeklyMinutes) : "none"} · {r.mode === "block" ? "Stops scheduling" : r.mode === "report" ? "Warns only" : "No limit set"}</span>
              {r.overDaily || r.overWeekly ? (
                <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${r.mode === "block" ? "bg-red-100 text-red-900" : "bg-amber-100 text-amber-900"}`}>
                  Over the {r.overDaily && r.overWeekly ? "daily and weekly" : r.overDaily ? "daily" : "weekly"} limit{r.mode === "report" ? " (warning only)" : ""}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Hour limits">
        <h3 className="text-sm font-semibold text-slate-900">Limits</h3>
        {policy.data?.applies ? (
          <div data-testid="work-hour-policy" className="mb-2 rounded-lg border border-slate-300 bg-og-card px-3 py-2 text-sm text-slate-900">
            <p className="font-semibold">Agency limit: {formatDuration(policy.data.maxDailyMinutes ?? 0)} a day and {formatDuration(policy.data.maxWeeklyMinutes ?? 0)} a week.</p>
            <Hint details="A stricter limit below still applies on top of it." show>It is always enforced and cannot be overridden or loosened here.</Hint>
          </div>
        ) : null}
        {limits.data && limits.data.length === 0 && !policy.data?.applies ? <p className="text-sm text-slate-600">No limits set. Caregivers can be scheduled for any number of hours.</p> : null}
        <ul className="space-y-1">
          {(limits.data ?? []).map((l) => (
            <li key={l.caregiverRecordId ?? "default"} className="rounded-lg border border-slate-200 bg-og-card px-3 py-2 text-sm">
              <span className="font-medium text-slate-900">{l.caregiverName ?? "Everyone (agency default)"}</span>
              {" · "}{hoursText(l.maxDailyMinutes)} a day · {hoursText(l.maxWeeklyMinutes)} a week · {l.mode === "block" ? "stops scheduling" : "warns only"}
            </li>
          ))}
        </ul>
        {canManage ? (
          <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-2 grid gap-2 rounded-lg bg-slate-50 p-2 sm:grid-cols-2">
            <div>
              <label htmlFor="hl-cg" className="block text-xs font-medium text-slate-600">Applies to</label>
              <select id="hl-cg" value={form.caregiverRecordId} onChange={(e) => setForm({ ...form, caregiverRecordId: e.target.value })} className={inputClass}>
                <option value="">Everyone (agency default)</option>
                {(caregivers.data ?? []).filter((c) => c.status !== "inactive").map((c) => <option key={c.caregiverRecordId} value={c.caregiverRecordId}>{nameWithCode(caregiverName(c), c.caregiverCode, c.duplicateName)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="hl-mode" className="block text-xs font-medium text-slate-600">When over the limit</label>
              <select id="hl-mode" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as "report" | "block" })} className={inputClass}>
                <option value="report">Warn only</option><option value="block">Stop the assignment</option>
              </select>
            </div>
            <div><label htmlFor="hl-day" className="block text-xs font-medium text-slate-600">Hours a day (optional)</label><input id="hl-day" inputMode="decimal" value={form.dailyHours} onChange={(e) => setForm({ ...form, dailyHours: e.target.value })} className={inputClass} /></div>
            <div><label htmlFor="hl-week" className="block text-xs font-medium text-slate-600">Hours a week (optional)</label><input id="hl-week" inputMode="decimal" value={form.weeklyHours} onChange={(e) => setForm({ ...form, weeklyHours: e.target.value })} className={inputClass} /></div>
            <div className="sm:col-span-2"><label htmlFor="hl-reason" className="block text-xs font-medium text-slate-600">Reason</label><input id="hl-reason" value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={inputClass} /></div>
            {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
            {state.saved ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">Saved.</p> : null}
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit" disabled={state.busy}>Save limit</Button>
              <Button type="button" variant="secondary" disabled={state.busy} onClick={() => void save(true)}>Remove this limit</Button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
