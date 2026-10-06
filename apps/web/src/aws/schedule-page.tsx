import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { caregiverName, useCaregivers } from "./care-team-admin";
import { clientName, useClients, useServices } from "./client-admin";
import { formatClockTime, formatWeekdayDate, formatWeekdayDateTime } from "@/lib/service-verification";
import { RecurringSeriesForm, RescheduleForm, SeriesList } from "./recurring-schedule";

/**
 * Schedule (0026): staff-scheduled shifts, call-outs, replacements and
 * coverage history; caregivers' own upcoming shifts. Every rule (agency,
 * permission, authorization time, overlaps, who may call out) is enforced
 * again by the server; these screens only make it clear.
 */
type CoverageState = "covered" | "needs_coverage" | "completed" | "cancelled" | "no_show";
export interface Shift {
  shiftId: string;
  startsAt: string;
  endsAt: string;
  localDate: string;
  coverageState: CoverageState;
  clientId: string;
  clientCode: string;
  clientName: string | null;
  serviceName: string | null;
  serviceCode: string | null;
  caregiverRecordId: string | null;
  caregiverCode: string | null;
  caregiverName: string | null;
  hasSignIn: boolean;
  reservedMinutes: number | null;
  fromCareRequest: boolean;
  hasVisit: boolean;
  lastCalloutReason: string | null;
  /** 0034: the weekly series this occurrence belongs to, if any. */
  seriesId?: string | null;
}
interface CoverageEvent { eventType: "called_out" | "reassigned"; createdAt: string; reason: string | null; originalCaregiverName: string | null; replacementCaregiverName: string | null; recordedBy: string }
interface MyShift { shiftId: string; startsAt: string; endsAt: string; clientCode: string; serviceName: string | null; coverageState: string; canCallOut: boolean }

const STATE_LABEL: Record<CoverageState, string> = { covered: "Covered", needs_coverage: "NEEDS COVERAGE", completed: "Completed", cancelled: "Cancelled", no_show: "No-show" };
const STATE_BADGE: Record<CoverageState, string> = {
  covered: "bg-emerald-100 text-emerald-900", needs_coverage: "bg-red-100 text-red-900 font-bold",
  completed: "bg-slate-200 text-slate-800", cancelled: "bg-slate-200 text-slate-700", no_show: "bg-amber-100 text-amber-900",
};
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

function useAgencyClock() {
  const { activeOrganization } = useOrganization();
  const tz = (activeOrganization as { timezone?: string } | null)?.timezone || "America/Los_Angeles";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const time = (iso: string) => formatClockTime(iso);
  const dayLabel = (d: string) => formatWeekdayDate(d);
  const when = (iso: string) => formatWeekdayDateTime(iso);
  return { tz, today, time, dayLabel, when };
}
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const hours = (minutes: number) => `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;

function useRefreshSchedule() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["aws-shifts"] });
}

function AddShiftForm({ onDone }: { onDone: (text: string) => void }) {
  const api = useAwsApi();
  const refresh = useRefreshSchedule();
  const { today } = useAgencyClock();
  const { activeOrganizationId } = useOrganization();
  const clients = useClients();
  const services = useServices();
  const caregivers = useCaregivers();
  const [form, setForm] = useState({ clientId: "", serviceId: "", caregiverRecordId: "", date: today, startTime: "09:00", endTime: "12:00" });
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const set = (k: keyof typeof form, v: string) => { setForm((f) => ({ ...f, [k]: v })); key.current = newIdempotencyKey(); };
  async function submit() {
    if (!form.clientId) return setState({ busy: false, error: "Choose the client." });
    if (!form.serviceId) return setState({ busy: false, error: "Choose the service." });
    if (!form.date || !form.startTime || !form.endTime) return setState({ busy: false, error: "Enter the date, start and end time." });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ shift: { reservedMinutes: number; remainingMinutes: number | string } }>("/v1/shifts", {
        organizationId: activeOrganizationId, clientId: form.clientId, serviceId: form.serviceId, date: form.date,
        startTime: form.startTime, endTime: form.endTime, caregiverRecordId: form.caregiverRecordId || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null });
      onDone(`Shift scheduled${form.caregiverRecordId ? "" : " as OPEN (no caregiver yet)"}. ${hours(r.shift.reservedMinutes)} reserved; ${hours(Number(r.shift.remainingMinutes))} of authorized time left this month.`);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The shift was not scheduled.") });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label htmlFor="sh-client" className="block text-sm font-medium text-slate-700">Client</label>
        <select id="sh-client" value={form.clientId} onChange={(e) => set("clientId", e.target.value)} className={inputClass}>
          <option value="">Choose a client</option>
          {(clients.data ?? []).filter((c) => c.status === "active").map((c) => <option key={c.clientId} value={c.clientId}>{clientName(c) ?? "Name not set"} ({c.clientCode})</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="sh-service" className="block text-sm font-medium text-slate-700">Service</label>
        <select id="sh-service" value={form.serviceId} onChange={(e) => set("serviceId", e.target.value)} className={inputClass}>
          <option value="">Choose a service</option>
          {(services.data ?? []).filter((s) => s.isActive).map((s) => <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.code})</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="sh-caregiver" className="block text-sm font-medium text-slate-700">Caregiver (optional)</label>
        <select id="sh-caregiver" value={form.caregiverRecordId} onChange={(e) => set("caregiverRecordId", e.target.value)} className={inputClass}>
          <option value="">Open shift — fill later</option>
          {(caregivers.data ?? []).filter((c) => c.status === "ready" || c.status === "active").map((c) => (
            <option key={c.caregiverRecordId} value={c.caregiverRecordId}>{caregiverName(c)} ({c.caregiverCode}){c.hasSignIn ? "" : " — no sign-in yet"}</option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2 grid grid-cols-3 gap-2">
        <div><label htmlFor="sh-date" className="block text-sm font-medium text-slate-700">Date</label><input id="sh-date" type="date" value={form.date} min={today} onChange={(e) => set("date", e.target.value)} className={inputClass} /></div>
        <div><label htmlFor="sh-start" className="block text-sm font-medium text-slate-700">Start time</label><input id="sh-start" type="time" value={form.startTime} onChange={(e) => set("startTime", e.target.value)} className={inputClass} /></div>
        <div><label htmlFor="sh-end" className="block text-sm font-medium text-slate-700">End time</label><input id="sh-end" type="time" value={form.endTime} onChange={(e) => set("endTime", e.target.value)} className={inputClass} /></div>
      </div>
      <p className="text-xs text-slate-600 sm:col-span-2">Times are the agency's local time. An end time earlier than the start means the next day. The hours are reserved against the client's current authorization and refused if not enough time is left this month.</p>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      <div className="sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Scheduling…" : "Schedule shift"}</Button></div>
    </form>
  );
}

type Action = "callout" | "assign" | "cancel" | "history" | "reschedule" | null;

function ShiftActions({ s, action, onClose, onDone }: { s: Shift; action: Exclude<Action, null | "reschedule">; onClose: () => void; onDone: (text: string) => void }) {
  const api = useAwsApi();
  const refresh = useRefreshSchedule();
  const { activeOrganizationId } = useOrganization();
  const caregivers = useCaregivers();
  const [reason, setReason] = useState("");
  const [pick, setPick] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const history = useQuery({
    queryKey: ["aws-shifts", "coverage", s.shiftId],
    queryFn: async () => (await api.get<{ events: CoverageEvent[] }>(`/v1/shifts/${encodeURIComponent(s.shiftId)}/coverage`, { organizationId: activeOrganizationId })).events,
    enabled: action === "history",
  });
  const { when } = useAgencyClock();
  const id = `${action}-${s.shiftId.slice(0, 8)}`;
  const covered = s.coverageState === "covered";
  async function submit() {
    if ((action === "callout" || action === "cancel" || (action === "assign" && covered)) && reason.trim().length < 3) return setState({ busy: false, error: "Give a reason." });
    if (action === "assign" && !pick) return setState({ busy: false, error: "Choose the caregiver." });
    setState({ busy: true, error: null });
    try {
      const path = `/v1/shifts/${encodeURIComponent(s.shiftId)}/${action === "assign" ? "caregiver" : action}`;
      const payload = action === "assign"
        ? { organizationId: activeOrganizationId, caregiverRecordId: pick, reason: reason.trim() || null }
        : { organizationId: activeOrganizationId, reason: reason.trim() };
      const r = await api.post<{ releasedMinutes?: number }>(path, payload, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      onDone(action === "callout" ? "Call-out recorded. The shift now NEEDS COVERAGE; its hours stay reserved."
        : action === "assign" ? "Caregiver assigned. The shift is covered."
        : `Shift cancelled. ${hours(r.releasedMinutes ?? 0)} returned to the authorization.`);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved.") });
    }
  }
  if (action === "history") {
    return (
      <div className="mt-2 rounded-lg bg-slate-50 p-2 text-sm text-slate-800">
        {history.isLoading ? <p className="text-slate-500">Loading…</p> : null}
        {history.isError ? <p role="alert" className="text-red-700">{(history.error as Error).message}</p> : null}
        {history.data && history.data.length === 0 ? <p className="text-slate-600">No call-outs or replacements.</p> : null}
        <ul className="space-y-1">
          {(history.data ?? []).map((e, i) => (
            <li key={i}>{when(e.createdAt)}: {e.eventType === "called_out"
              ? `${e.originalCaregiverName ?? "Caregiver"} called out (${e.recordedBy})${e.reason ? ` — ${e.reason}` : ""}`
              : `${e.replacementCaregiverName ?? "Caregiver"} assigned${e.originalCaregiverName ? ` in place of ${e.originalCaregiverName}` : ""}${e.reason ? ` — ${e.reason}` : ""}`}</li>
          ))}
        </ul>
        <button type="button" className="mt-1 text-sm underline" onClick={onClose}>Close</button>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-2 grid gap-2 rounded-lg bg-slate-50 p-2 sm:grid-cols-2">
      {action === "assign" ? (
        <div className="sm:col-span-2">
          <label htmlFor={`${id}-cg`} className="block text-xs font-medium text-slate-600">Caregiver</label>
          <select id={`${id}-cg`} value={pick} onChange={(e) => { setPick(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass}>
            <option value="">Choose a caregiver</option>
            {(caregivers.data ?? []).filter((c) => (c.status === "ready" || c.status === "active") && c.caregiverRecordId !== s.caregiverRecordId).map((c) => (
              <option key={c.caregiverRecordId} value={c.caregiverRecordId}>{caregiverName(c)} ({c.caregiverCode})</option>
            ))}
          </select>
        </div>
      ) : null}
      {action !== "assign" || covered ? (
        <div className="sm:col-span-2">
          <label htmlFor={`${id}-reason`} className="block text-xs font-medium text-slate-600">{action === "callout" ? "Reason for the call-out" : action === "cancel" ? "Reason for cancelling" : "Reason for changing the caregiver"}</label>
          <input id={`${id}-reason`} value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} />
        </div>
      ) : null}
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant={action === "cancel" ? "secondary" : "primary"} disabled={state.busy}>
          {action === "callout" ? "Record call-out" : action === "cancel" ? "Cancel shift" : "Assign caregiver"}
        </Button>
        <button type="button" className="text-sm underline" onClick={onClose}>Close</button>
      </div>
    </form>
  );
}

function ShiftRow({ s, canManage, onDone }: { s: Shift; canManage: boolean; onDone: (text: string) => void }) {
  const [action, setAction] = useState<Action>(null);
  const { time } = useAgencyClock();
  const open = s.coverageState === "covered" || s.coverageState === "needs_coverage";
  const editable = canManage && open && !s.fromCareRequest && !s.hasVisit && new Date(s.endsAt).getTime() > Date.now();
  const calledOut = s.coverageState === "needs_coverage" && !!s.caregiverRecordId;
  return (
    <li className={`rounded-xl border bg-white p-3 ${s.coverageState === "needs_coverage" ? "border-red-300" : "border-slate-200"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-950">{time(s.startsAt)}–{time(s.endsAt)} · <Link className="underline" to={`/clients/${s.clientId}`}>{s.clientName ?? "Name not set"} ({s.clientCode})</Link></p>
        <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_BADGE[s.coverageState]}`}>{STATE_LABEL[s.coverageState]}</span>
      </div>
      <p className="mt-1 text-sm text-slate-800">
        {s.serviceName ?? "Service"}{s.reservedMinutes ? ` · ${hours(s.reservedMinutes)} reserved` : ""} · {s.caregiverRecordId
          ? <>{calledOut ? "Called out: " : ""}<Link className="underline" to={`/care-team/${s.caregiverRecordId}`}>{s.caregiverName} ({s.caregiverCode})</Link>{!s.hasSignIn ? " — no sign-in yet" : ""}</>
          : <span className="font-semibold text-red-800">OPEN — no caregiver</span>}
      </p>
      {calledOut && s.lastCalloutReason ? <p className="mt-1 text-sm text-red-800">Reason: {s.lastCalloutReason}</p> : null}
      {s.seriesId ? <p className="mt-1 text-xs text-slate-600">Repeats weekly — changes here affect this date only; change the series under Manage repeating shifts.</p> : null}
      {s.fromCareRequest ? <p className="mt-1 text-xs text-slate-600">From a Care Request; manage it on the <Link className="underline" to="/care-requests">Care Requests</Link> page.</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {editable && s.coverageState === "covered" ? <button type="button" className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 hover:bg-slate-50" onClick={() => setAction("callout")}>Record call-out</button> : null}
        {editable ? <button type="button" className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 hover:bg-slate-50" onClick={() => setAction("assign")}>{s.coverageState === "needs_coverage" ? "Assign caregiver" : "Change caregiver"}</button> : null}
        {editable && new Date(s.startsAt).getTime() > Date.now() ? <button type="button" className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 hover:bg-slate-50" onClick={() => setAction("reschedule")}>{s.seriesId ? "Change this date only" : "Change time"}</button> : null}
        {editable ? <button type="button" className="inline-flex min-h-[40px] items-center rounded-lg border border-red-700 bg-white px-3 text-sm font-medium text-red-800 hover:bg-red-50" onClick={() => setAction("cancel")}>{s.seriesId ? "Cancel this date" : "Cancel shift"}</button> : null}
        <button type="button" className="inline-flex min-h-[40px] items-center rounded-lg px-2 text-sm font-medium text-og-link underline underline-offset-2 hover:bg-slate-50" onClick={() => setAction(action === "history" ? null : "history")}>History</button>
      </div>
      {action === "reschedule" ? (
        <RescheduleForm shiftId={s.shiftId} localDate={s.localDate} startsAt={s.startsAt} endsAt={s.endsAt} onClose={() => setAction(null)} onDone={(t) => { setAction(null); onDone(t); }} />
      ) : action ? <ShiftActions s={s} action={action} onClose={() => setAction(null)} onDone={(t) => { setAction(null); onDone(t); }} /> : null}
    </li>
  );
}

/** Staff schedule: one week at a time, shifts needing coverage first in each day. */
export function SchedulePage() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { today, dayLabel } = useAgencyClock();
  const [from, setFrom] = useState(today);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [repeating, setRepeating] = useState(false);
  const [showSeries, setShowSeries] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = hasPermission("shifts.manage");
  const to = addDays(from, 6);
  const shifts = useQuery({
    queryKey: ["aws-shifts", activeOrganizationId, from, to],
    queryFn: async () => (await api.get<{ shifts: Shift[] }>("/v1/shifts", { organizationId: activeOrganizationId, from, to })).shifts,
    enabled: !!activeOrganizationId && (canManage || hasPermission("visits.manage")),
  });
  const byDay = useMemo(() => {
    const out = new Map<string, Shift[]>();
    for (const s of shifts.data ?? []) {
      if (onlyOpen && s.coverageState !== "needs_coverage") continue;
      out.set(s.localDate, [...(out.get(s.localDate) ?? []), s]);
    }
    return out;
  }, [shifts.data, onlyOpen]);
  if (!canManage && !hasPermission("visits.manage")) return <p className="text-sm text-slate-600">You do not have access to the schedule.</p>;
  const needs = (shifts.data ?? []).filter((s) => s.coverageState === "needs_coverage").length;
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-950">Schedule</h1>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => { setAdding((x) => !x); setRepeating(false); setNotice(null); }} aria-expanded={adding}>{adding ? "Close" : "Add shift"}</Button>
            <Button type="button" variant="secondary" onClick={() => { setRepeating((x) => !x); setAdding(false); setNotice(null); }} aria-expanded={repeating}>{repeating ? "Close" : "Repeat weekly"}</Button>
            <Button type="button" variant="secondary" onClick={() => setShowSeries((x) => !x)} aria-expanded={showSeries}>Manage repeating shifts</Button>
          </div>
        ) : null}
      </div>
      {needs > 0 ? <p className="text-base font-bold uppercase text-red-700">{needs} shift{needs === 1 ? "" : "s"} need{needs === 1 ? "s" : ""} coverage this week</p> : null}
      {adding ? <Card className="p-3"><AddShiftForm onDone={(t) => { setAdding(false); setNotice(t); }} /></Card> : null}
      {repeating ? <Card className="p-3"><h2 className="text-base font-semibold text-slate-950">Repeat weekly</h2><RecurringSeriesForm today={today} onDone={(t) => { setRepeating(false); setNotice(t); }} /></Card> : null}
      {showSeries && canManage ? <Card className="space-y-2 p-3"><h2 className="text-base font-semibold text-slate-950">Manage repeating shifts</h2><SeriesList today={today} onDone={setNotice} /></Card> : null}
      {notice ? <p role="status" className="text-sm text-emerald-800">{notice}</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <Button type="button" variant="secondary" onClick={() => setFrom(addDays(from, -7))}>← Previous week</Button>
        <div><label htmlFor="sh-from" className="block text-sm font-medium text-slate-700">Week starting</label><input id="sh-from" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className={inputClass} /></div>
        <Button type="button" variant="secondary" onClick={() => setFrom(addDays(from, 7))}>Next week →</Button>
        <label className="flex items-center gap-2 text-sm text-slate-800"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Needs coverage only</label>
      </div>
      {shifts.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {shifts.isError ? <p role="alert" className="text-sm text-red-700">{(shifts.error as Error).message}</p> : null}
      {shifts.data && byDay.size === 0 ? <p className="text-sm text-slate-600">{onlyOpen ? "Every shift this week is covered." : "No shifts this week."}</p> : null}
      {[...byDay.entries()].map(([d, list]) => (
        <section key={d}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-700">{dayLabel(d)}</h2>
          <ul className="space-y-2">{list.map((s) => <ShiftRow key={s.shiftId} s={s} canManage={canManage} onDone={setNotice} />)}</ul>
        </section>
      ))}
    </div>
  );
}

/** Caregiver: upcoming shifts (next 14 days) and "I can't make it". */
export function MyShiftsPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const { when, time } = useAgencyClock();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  const shifts = useQuery({
    queryKey: ["aws-my-shifts", activeOrganizationId],
    queryFn: async () => (await api.get<{ shifts: MyShift[] }>("/v1/my-shifts", { organizationId: activeOrganizationId })).shifts,
    enabled: !!activeOrganizationId,
  });
  async function callOut(id: string) {
    if (reason.trim().length < 3) return setState({ busy: false, error: "Tell the office why you can't come.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      await api.post(`/v1/my-shifts/${encodeURIComponent(id)}/callout`, { organizationId: activeOrganizationId, reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await queryClient.invalidateQueries({ queryKey: ["aws-my-shifts"] });
      setOpen(null); setReason("");
      setState({ busy: false, error: null, done: "Sent. The office has been told you can't make this shift." });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not sent. Call the office."), done: null });
    }
  }
  return (
    <div className="max-w-xl space-y-3">
      <h1 className="text-xl font-semibold text-slate-950">My shifts</h1>
      {state.done ? <p role="status" className="text-sm text-emerald-800">{state.done}</p> : null}
      {shifts.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {shifts.isError ? <p role="alert" className="text-sm text-red-700">{(shifts.error as Error).message}</p> : null}
      {shifts.data && shifts.data.length === 0 ? <p className="text-sm text-slate-600">No shifts in the next two weeks.</p> : null}
      <ul className="space-y-2">
        {(shifts.data ?? []).map((s) => (
          <li key={s.shiftId} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="font-semibold text-slate-950">{when(s.startsAt)}–{time(s.endsAt)}</p>
            <p className="text-sm text-slate-800">Client {s.clientCode}{s.serviceName ? ` · ${s.serviceName}` : ""}</p>
            {s.coverageState === "called_out" ? <p className="mt-1 text-sm font-semibold text-amber-900">You called out. The office is finding cover.</p> : null}
            {s.canCallOut && open !== s.shiftId ? (
              <button type="button" className="mt-2 inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-900 hover:bg-slate-50" onClick={() => { setOpen(s.shiftId); setState({ busy: false, error: null, done: null }); }}>I can't make it</button>
            ) : null}
            {open === s.shiftId ? (
              <form onSubmit={(e) => { e.preventDefault(); void callOut(s.shiftId); }} className="mt-2 space-y-2">
                <label htmlFor={`co-${s.shiftId.slice(0, 8)}`} className="block text-sm font-medium text-slate-700">Why can't you come?</label>
                <input id={`co-${s.shiftId.slice(0, 8)}`} value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} />
                {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
                <div className="flex gap-3"><Button type="submit" disabled={state.busy}>Tell the office</Button><button type="button" className="text-sm underline" onClick={() => setOpen(null)}>Keep the shift</button></div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
