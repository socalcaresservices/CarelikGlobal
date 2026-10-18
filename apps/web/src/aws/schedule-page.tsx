import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, Card, QuickActionMenu } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { caregiverName, useCaregivers } from "./care-team-admin";
import { clientName, useClients, useServices } from "./client-admin";
import { formatDuration } from "@/lib/service-verification";
import { useAgencyClock } from "./agency-clock";
import { RecurringSeriesForm, RejectedDates, RescheduleForm, SeriesList } from "./recurring-schedule";
import { PickupRequestsPanel } from "./pickup-requests";
import { ReconcileShiftsPanel } from "./reconcile-shifts";
import { useShiftsToReconcile } from "./reconcile-data";
import { ShortHelp } from "./help-text";
import { useIsNarrow } from "@/lib/use-is-narrow";
import type { RejectedDate } from "./recurring-format";
import { AssignmentChecks } from "./readiness/assignment-checks";
import { HourLimitsPanel, MakeupForm } from "./scheduling-extras";
import { useClientAuthorizations } from "./client-admin";
import { useAssignments } from "./assignments-data";
import { applyFilters, DISPLAY_BADGE, DISPLAY_LABEL, NO_FILTERS, stateOfShift, stepAnchor, viewRange, type CalendarView, type ShiftFilters } from "./schedule-model";
import { FilterBar, MonthGrid, ReplacementSuggestions, SchedulingOverview, ViewTabs } from "./schedule-views";

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
  serviceId?: string | null;
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
  /** 0047: assigned under a one-shift Administrator availability override (the original result was No Match). */
  availabilityOverride?: boolean;
  availabilityOverrideReason?: string | null;
  /** 0053: the missed shift this one makes up for. */
  makeupForShiftId?: string | null;
  /** 0075: what happened to the shift (verification pending, partial, missed, not delivered ...), decided once by the database. */
  displayState?: string | null;
  visitStatus?: string | null;
  visitWorkedMinutes?: number | null;
  scheduledMinutes?: number | null;
  reconciliationOutcome?: string | null;
}
interface CoverageEvent { eventType: "called_out" | "reassigned"; createdAt: string; reason: string | null; originalCaregiverName: string | null; replacementCaregiverName: string | null; recordedBy: string }
interface MyShift { shiftId: string; startsAt: string; endsAt: string; clientCode: string; serviceName: string | null; coverageState: string; canCallOut: boolean }

const STATE_LABEL: Record<CoverageState, string> = { covered: "Covered", needs_coverage: "Needs coverage", completed: "Completed", cancelled: "Cancelled", no_show: "No-show" };
const STATE_BADGE: Record<CoverageState, string> = {
  covered: "bg-emerald-100 text-emerald-900", needs_coverage: "bg-red-100 text-red-900 font-bold",
  completed: "bg-slate-200 text-slate-800", cancelled: "bg-slate-200 text-slate-700", no_show: "bg-amber-100 text-amber-900",
};
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

const hours = (minutes: number) => `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;

function useRefreshSchedule() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["aws-shifts"] });
}

function AddShiftForm({ onDone, initialClientId = "" }: { onDone: (text: string) => void; initialClientId?: string }) {
  const api = useAwsApi();
  const refresh = useRefreshSchedule();
  const { today } = useAgencyClock();
  const { activeOrganizationId } = useOrganization();
  const clients = useClients();
  const services = useServices();
  const caregivers = useCaregivers();
  const [form, setForm] = useState({ clientId: initialClientId, serviceId: "", caregiverRecordId: "", date: today, startTime: "09:00", endTime: "12:00" });
  const [prefilled, setPrefilled] = useState<string[]>([]);
  const auths = useClientAuthorizations(form.clientId || undefined);
  const assigned = useAssignments({ clientId: form.clientId || undefined });
  // Prefill from the client's record (B3-R3): the services the client is authorized for, the one service when there is only one, and the caregiver when exactly one is assigned to it.
  const authorizedServices = useMemo(() => [...new Set((auths.data ?? []).filter((a) => a.isCurrent && a.periodEnd >= today).map((a) => a.serviceId))], [auths.data, today]);
  useEffect(() => {
    if (!form.clientId) return;
    const filled: string[] = [];
    let serviceId = form.serviceId, caregiverRecordId = form.caregiverRecordId;
    if (!serviceId && authorizedServices.length === 1) { serviceId = authorizedServices[0]!; filled.push("service"); }
    const candidates = [...new Set((assigned.data ?? []).filter((a) => a.state === "current" && a.caregiverRecordId && (!serviceId || a.serviceId === serviceId)).map((a) => a.caregiverRecordId!))];
    if (serviceId && !caregiverRecordId && candidates.length === 1) { caregiverRecordId = candidates[0]!; filled.push("caregiver"); }
    if (filled.length === 0) return;
    setForm((f) => ({ ...f, serviceId: f.serviceId || serviceId, caregiverRecordId: f.caregiverRecordId || caregiverRecordId }));
    setPrefilled((p) => [...new Set([...p, ...filled])]);
  }, [form.clientId, form.serviceId, form.caregiverRecordId, authorizedServices, assigned.data]);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [ready, setReady] = useState<boolean | null>(null);
  const key = useRef(newIdempotencyKey());
  const set = (k: keyof typeof form, v: string) => { setForm((f) => ({ ...f, [k]: v })); key.current = newIdempotencyKey(); };
  // A refusal for lack of authorized time is the outcome of the whole form, not an extra error beside the caregiver checks.
  const authRefusal = state.error && /not enough authorized time/i.test(state.error) ? state.error : null;
  const refusal = authRefusal ? <>Not scheduled: not enough authorized time this month. Shorten the shift or ask for an authorization change.<span className="mt-0.5 block text-xs font-normal text-red-900">{authRefusal}</span></> : undefined;
  async function submit() {
    if (!form.clientId) return setState({ busy: false, error: "Client missing. Choose the client." });
    if (!form.serviceId) return setState({ busy: false, error: "Service missing. Choose the service." });
    if (!form.date || !form.startTime || !form.endTime) return setState({ busy: false, error: "Time missing. Enter the date, start and end time." });
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
      setState({ busy: false, error: message(cause, "The shift was not scheduled. Check the details and try again.") });
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
          {(services.data ?? []).filter((s) => s.isActive && (authorizedServices.length === 0 || authorizedServices.includes(s.serviceId))).map((s) => <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.code})</option>)}
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
      {form.caregiverRecordId && form.serviceId ? (
        <div className="sm:col-span-2">
          <AssignmentChecks onReady={setReady} outcome={refusal} note="Authorized time is confirmed when you schedule." input={{ caregiverRecordId: form.caregiverRecordId, serviceId: form.serviceId, ...(form.clientId ? { clientId: form.clientId } : {}), date: form.date, startTime: form.startTime, endTime: form.endTime }} />
        </div>
      ) : (
        <>
          {refusal ? <div role="alert" data-testid="assignment-outcome" className="text-sm font-semibold text-red-800 sm:col-span-2">{refusal}</div> : <p className="text-xs text-slate-600 sm:col-span-2">Authorized time is confirmed when you schedule.</p>}
        </>
      )}
      {prefilled.length > 0 ? <p data-testid="prefill-note" className="text-xs text-slate-700 sm:col-span-2">Filled in from the client&apos;s record: {prefilled.join(" and ")}. Change anything you need to.</p> : null}
      <ShortHelp className="text-xs text-slate-600 sm:col-span-2" details="An end time earlier than the start means the next day. The hours are reserved against the client's current authorization and refused if not enough time is left this month.">Times are the agency&apos;s local time.</ShortHelp>
      {state.error && !authRefusal ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      <div className="sm:col-span-2"><Button type="submit" className="min-h-11" disabled={state.busy || (!!form.caregiverRecordId && ready === false)}>{state.busy ? "Scheduling…" : "Schedule shift"}</Button></div>
    </form>
  );
}

type Action = "callout" | "assign" | "cancel" | "history" | "reschedule" | "makeup" | null;

function ShiftActions({ s, action, onClose, onDone }: { s: Shift; action: Exclude<Action, null | "reschedule" | "makeup">; onClose: () => void; onDone: (text: string) => void }) {
  const api = useAwsApi();
  const refresh = useRefreshSchedule();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const caregivers = useCaregivers();
  const [reason, setReason] = useState("");
  const [pick, setPick] = useState("");
  const [ready, setReady] = useState<boolean | null>(null);
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
    if ((action === "callout" || action === "cancel" || (action === "assign" && covered)) && reason.trim().length < 3) return setState({ busy: false, error: "Reason missing. Give a reason." });
    if (action === "assign" && !pick) return setState({ busy: false, error: "Caregiver missing. Choose the caregiver." });
    setState({ busy: true, error: null });
    try {
      const path = `/v1/shifts/${encodeURIComponent(s.shiftId)}/${action === "assign" ? "caregiver" : action}`;
      const payload = action === "assign"
        ? { organizationId: activeOrganizationId, caregiverRecordId: pick, reason: reason.trim() || null }
        : { organizationId: activeOrganizationId, reason: reason.trim() };
      const r = await api.post<{ releasedMinutes?: number }>(path, payload, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      onDone(action === "callout" ? "Call-out recorded. The shift now needs coverage; its hours stay reserved."
        : action === "assign" ? "Caregiver assigned. The shift is covered."
        : `Shift cancelled. ${hours(r.releasedMinutes ?? 0)} returned to the authorization.`);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved. Check the details and try again.") });
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
      {action === "assign" && s.serviceId && (hasPermission("matching.read") || hasPermission("shifts.manage")) ? (
        <div className="sm:col-span-2"><ReplacementSuggestions shift={s} onChoose={(rec) => { setPick(rec); key.current = newIdempotencyKey(); }} /></div>
      ) : null}
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
      {action === "assign" && pick && s.serviceId ? (
        <div className="sm:col-span-2">
          <AssignmentChecks onReady={setReady} input={{ caregiverRecordId: pick, serviceId: s.serviceId, clientId: s.clientId, startsAt: s.startsAt, endsAt: s.endsAt, context: "reschedule", excludeShiftId: s.shiftId }} />
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
        <Button type="submit" className="min-h-11" variant={action === "cancel" ? "secondary" : "primary"} disabled={state.busy || (action === "assign" && !!pick && ready === false)}>
          {action === "callout" ? "Record call-out" : action === "cancel" ? "Cancel shift" : "Assign caregiver"}
        </Button>
        <button type="button" className="text-sm underline" onClick={onClose}>Close</button>
      </div>
    </form>
  );
}

type MenuItem = { label: string; action: Exclude<Action, null>; danger?: boolean };
const COLS = 6;

/** One shift: desktop = a row of a compact table, phone = a compact row that opens. One primary action inline; the rest are in "More actions". */
function ShiftRow({ s, canManage, onDone, highlight = false, autoAssign = false }: { s: Shift; canManage: boolean; onDone: (text: string) => void; highlight?: boolean; autoAssign?: boolean }) {
  const [action, setAction] = useState<Action>(null);
  const [expanded, setExpanded] = useState(stateOfShift(s) === "needs_coverage" || highlight);
  const narrow = useIsNarrow();
  const rowRef = useRef<HTMLElement>(null);
  useEffect(() => { if (highlight) rowRef.current?.scrollIntoView?.({ block: "center" }); }, [highlight]);
  const { time, when } = useAgencyClock();
  const open = s.coverageState === "covered" || s.coverageState === "needs_coverage";
  const editable = canManage && open && !s.fromCareRequest && !s.hasVisit && new Date(s.endsAt).getTime() > Date.now();
  const calledOut = s.coverageState === "needs_coverage" && !!s.caregiverRecordId;
  const future = new Date(s.startsAt).getTime() > Date.now();
  useEffect(() => { if (highlight && autoAssign && editable) setAction((a) => a ?? "assign"); }, [highlight, autoAssign, editable]);
  const primary: MenuItem | null = editable ? (s.coverageState === "needs_coverage" ? { label: "Assign caregiver", action: "assign" } : { label: "Record call-out", action: "callout" }) : null;
  const items: MenuItem[] = [
    ...(editable && s.coverageState === "covered" ? [{ label: "Change caregiver", action: "assign" as const }] : []),
    ...(editable && future ? [{ label: s.seriesId ? "Change this date only" : "Change time", action: "reschedule" as const }] : []),
    ...(editable ? [{ label: s.seriesId ? "Cancel this date" : "Cancel shift", action: "cancel" as const, danger: true }] : []),
    ...(canManage && !s.makeupForShiftId && (s.coverageState === "cancelled" || s.coverageState === "completed") ? [{ label: "Schedule make-up", action: "makeup" as const }] : []),
    { label: "History", action: "history" },
  ];
  const pick = (a: Exclude<Action, null>) => setAction(action === a && (a === "history" || a === "makeup") ? null : a);
  const stateKey = stateOfShift(s);
  const chip = <span data-testid="shift-state" className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${DISPLAY_BADGE[stateKey] ?? STATE_BADGE[s.coverageState]}`}>{DISPLAY_LABEL[stateKey] ?? STATE_LABEL[s.coverageState]}</span>;
  const clientText = `${s.clientName ?? "Name not set"} (${s.clientCode})`;
  const who = s.caregiverRecordId
    ? <>{calledOut ? "Called out: " : ""}<Link className="underline" to={`/care-team/${s.caregiverRecordId}`}>{s.caregiverName} ({s.caregiverCode})</Link>{!s.hasSignIn ? " — no sign-in yet" : ""}</>
    : <span className="font-semibold text-red-800">Open: no caregiver</span>;
  const rowActions = (
    <div className="flex items-center justify-end gap-1">
      {primary && !action ? <Button type="button" size="sm" variant={primary.action === "assign" ? "primary" : "secondary"} className="min-h-11 md:min-h-8" onClick={() => pick(primary.action)}>{primary.label}</Button> : null}
      {items.length === 1 && !primary ? <button type="button" className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-og-link underline underline-offset-2 md:min-h-8" onClick={() => pick(items[0]!.action)}>{items[0]!.label}</button> : (
        <QuickActionMenu label="More actions" className="[&>button]:min-h-11 [&>button]:min-w-11 md:[&>button]:min-h-8 md:[&>button]:min-w-8">
          {items.map((i) => <button key={i.action} type="button" className={`block min-h-11 w-full px-3 text-left hover:bg-slate-50 md:min-h-10 ${i.danger ? "text-red-800" : "text-slate-900"}`} onClick={() => pick(i.action)}>{i.label}</button>)}
        </QuickActionMenu>
      )}
    </div>
  );
  const notes = (
    <>
      {calledOut && s.lastCalloutReason ? <p className="text-red-800">Reason: {s.lastCalloutReason}</p> : null}
      {s.availabilityOverride ? <p className="font-medium text-amber-900">Assigned with Admin override (availability was No Match){s.availabilityOverrideReason ? `: ${s.availabilityOverrideReason}` : ""}</p> : null}
      {s.makeupForShiftId ? <p className="font-medium text-violet-900">Make-up visit for missed time</p> : null}
      {s.seriesId ? <p className="text-slate-600">Repeats on a schedule. Changes here affect this date only; change the series under Manage repeating shifts.</p> : null}
      {s.fromCareRequest ? <p className="text-slate-600">From a Care Request; manage it on the <Link className="underline" to="/care-requests">Care Requests</Link> page.</p> : null}
    </>
  );
  const hasNotes = (calledOut && !!s.lastCalloutReason) || !!s.availabilityOverride || !!s.makeupForShiftId || !!s.seriesId || s.fromCareRequest;
  const forms = action === "reschedule" ? (
    <RescheduleForm shiftId={s.shiftId} localDate={s.localDate} startsAt={s.startsAt} endsAt={s.endsAt} onClose={() => setAction(null)} onDone={(t) => { setAction(null); onDone(t); }} />
  ) : action === "makeup" ? (
    <MakeupForm shiftId={s.shiftId} caregiverRecordId={s.caregiverRecordId} defaultDate={s.localDate} onClose={() => setAction(null)} onDone={(t) => { setAction(null); onDone(t); }} />
  ) : action ? <ShiftActions s={s} action={action} onClose={() => setAction(null)} onDone={(t) => { setAction(null); onDone(t); }} /> : null;
  const tone = highlight ? "bg-sky-50 outline outline-2 outline-slate-900" : "";

  if (narrow) {
    return (
      <li ref={rowRef as RefObject<HTMLLIElement>} id={`shift-${s.shiftId}`} data-highlight={highlight ? "true" : undefined} className={`rounded-lg border bg-og-card ${tone} ${stateOfShift(s) === "needs_coverage" ? "border-red-300" : "border-slate-200"}`}>
        <details open={expanded || action !== null} onToggle={(e) => setExpanded(e.currentTarget.open)}>
          <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-3 py-1">
            <span className="min-w-0 text-sm"><span className="font-semibold text-slate-950">{when(s.startsAt)}</span> · {s.clientName ?? s.clientCode}</span>
            {chip}
          </summary>
          <div className="space-y-1 px-3 pb-3 text-sm text-slate-800">
            <p>{time(s.startsAt)}–{time(s.endsAt)} · <Link className="underline" to={`/clients/${s.clientId}`}>{clientText}</Link></p>
            <p>{s.serviceName ?? "Service"} · {who}</p>
            {hasNotes ? <div className="space-y-0.5 text-xs">{notes}</div> : null}
            {rowActions}
            {forms}
          </div>
        </details>
      </li>
    );
  }
  return (
    <tbody ref={rowRef as RefObject<HTMLTableSectionElement>} id={`shift-${s.shiftId}`} data-highlight={highlight ? "true" : undefined} className={stateOfShift(s) === "needs_coverage" ? "bg-red-50/40" : ""}>
      <tr className={`border-t border-slate-200 align-top ${tone}`}>
        <td className="whitespace-nowrap py-1.5 pl-2 pr-3 font-semibold text-slate-950">{time(s.startsAt)}–{time(s.endsAt)}</td>
        <td className="py-1.5 pr-3"><Link className="underline" to={`/clients/${s.clientId}`}>{clientText}</Link></td>
        <td className="py-1.5 pr-3 text-slate-800">{s.serviceName ?? "Service"}</td>
        <td className="py-1.5 pr-3 text-slate-800">{who}</td>
        <td className="py-1.5 pr-3">{chip}</td>
        <td className="py-1 pr-2 text-right">{rowActions}</td>
      </tr>
      {hasNotes ? <tr><td colSpan={COLS} className="space-y-0.5 pb-1.5 pl-2 text-xs">{notes}</td></tr> : null}
      {forms ? <tr><td colSpan={COLS} className="pb-2 pl-2 pr-2">{forms}</td></tr> : null}
    </tbody>
  );
}

/** A list of shifts: a compact table on desktop, compact rows on a phone. */
function ShiftList({ shifts, canManage, onDone, focusShift, autoAssign, withDate = false, label }: { shifts: Shift[]; canManage: boolean; onDone: (text: string) => void; focusShift: string | null; autoAssign: boolean; withDate?: boolean; label: string }) {
  const narrow = useIsNarrow();
  const rows = shifts.map((s) => <ShiftRow key={s.shiftId} s={s} canManage={canManage} onDone={onDone} highlight={s.shiftId === focusShift} autoAssign={s.shiftId === focusShift && autoAssign} />);
  if (narrow) return <ul aria-label={label} className="space-y-1.5">{rows}</ul>;
  return (
    <table aria-label={label} className="w-full border-collapse text-left text-sm">
      <thead className="text-xs font-semibold uppercase tracking-wide text-slate-600">
        <tr><th scope="col" className="py-1 pl-2 pr-3">{withDate ? "When" : "Time"}</th><th scope="col" className="py-1 pr-3">Client</th><th scope="col" className="py-1 pr-3">Service</th><th scope="col" className="py-1 pr-3">Caregiver</th><th scope="col" className="py-1 pr-3">Status</th><th scope="col" className="py-1 pr-2 text-right"><span className="sr-only">Actions</span></th></tr>
      </thead>
      {rows}
    </table>
  );
}

/** Staff schedule: a day, a week (the default) or a month. Two counted groups come first: upcoming shifts that need coverage, and past shifts that need review. Links from Action needed arrive with ?shift=, ?at=, ?client=, ?coverage=1, ?pickups=1 or ?reconcile=1. */
export function SchedulePage() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { today, dayLabel, tz } = useAgencyClock();
  const [params] = useSearchParams();
  const focusShift = params.get("shift");
  const at = params.get("at");
  const atDate = at && !Number.isNaN(Date.parse(at)) ? new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(at)) : null;
  const [view, setView] = useState<CalendarView>("week");
  const [from, setFrom] = useState(atDate ?? today);
  const [onlyOpen, setOnlyOpen] = useState(params.get("coverage") === "1");
  const [filters, setFilters] = useState<ShiftFilters>({ ...NO_FILTERS, client: params.get("client") ?? "" });
  const [adding, setAdding] = useState(false);
  const canAdd = hasPermission("shifts.manage");
  useEffect(() => { if (params.get("add") === "1" && canAdd) setAdding(true); }, [params, canAdd]);
  useEffect(() => { for (const id of ["pickups", "reconcile"]) if (params.get(id) === "1") document.getElementById(id)?.scrollIntoView?.({ block: "start" }); }, [params]);
  const [repeating, setRepeating] = useState(false);
  const [showSeries, setShowSeries] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejectedDates, setRejectedDates] = useState<RejectedDate[]>([]);
  const showNotice = (t: string, rejected: RejectedDate[] = []) => { setNotice(t); setRejectedDates(rejected); };
  const canManage = hasPermission("shifts.manage");
  const { from: rangeFrom, to } = viewRange(view, from);
  const shifts = useQuery({
    queryKey: ["aws-shifts", activeOrganizationId, rangeFrom, to],
    queryFn: async () => (await api.get<{ shifts: Shift[] }>("/v1/shifts", { organizationId: activeOrganizationId, from: rangeFrom, to })).shifts,
    enabled: !!activeOrganizationId && (canManage || hasPermission("visits.manage")),
  });
  const past = useShiftsToReconcile();
  const filtered = useMemo(() => applyFilters(shifts.data ?? [], filters), [shifts.data, filters]);
  // Upcoming shifts without a caregiver, by start time. They are listed once, in the first group; the day lists below hold everything else.
  // "Needs coverage" is the SERVER's decision (display state, 0075): a shift that has not ended and has nobody to work it. A running shift is included (it is Critical);
  // an ended shift is never included (it is a past shift to review). The browser clock is not used.
  const uncovered = useMemo(() => filtered.filter((s) => stateOfShift(s) === "needs_coverage").sort((a, b) => a.startsAt.localeCompare(b.startsAt)), [filtered]);
  const byDay = useMemo(() => {
    const out = new Map<string, Shift[]>();
    for (const s of filtered) {
      if (uncovered.includes(s)) continue;
      if (onlyOpen && stateOfShift(s) !== "needs_coverage") continue;
      out.set(s.localDate, [...(out.get(s.localDate) ?? []), s]);
    }
    return out;
  }, [filtered, onlyOpen, uncovered]);
  if (!canManage && !hasPermission("visits.manage")) return <p className="text-sm text-slate-600">You do not have access to the schedule.</p>;
  const unit = view === "day" ? "day" : view === "week" ? "week" : "month";
  const link = "inline-flex min-h-11 items-center px-1 text-sm font-medium text-og-link underline underline-offset-2 md:min-h-8";
  const pastCount = past.data?.length ?? 0;
  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold text-slate-950">Scheduling</h1>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-x-3">
            <Button type="button" className="min-h-11" onClick={() => { setAdding((x) => !x); setRepeating(false); setNotice(null); }} aria-expanded={adding}>{adding ? "Close" : "Add shift"}</Button>
            <button type="button" className={link} onClick={() => { setRepeating((x) => !x); setAdding(false); setNotice(null); }} aria-expanded={repeating}>{repeating ? "Close" : "Repeat visits"}</button>
            <button type="button" className={link} onClick={() => setShowSeries((x) => !x)} aria-expanded={showSeries}>Manage repeating shifts</button>
            <button type="button" className={link} onClick={() => setShowLimits((x) => !x)} aria-expanded={showLimits}>Hours and limits</button>
          </div>
        ) : null}
      </div>
      <SchedulingOverview />
      {adding ? <Card className="p-3"><AddShiftForm initialClientId={params.get("client") ?? ""} onDone={(t) => { setAdding(false); setNotice(t); }} /></Card> : null}
      {repeating ? <Card className="p-3"><h2 className="text-base font-semibold text-slate-950">Repeat visits</h2><RecurringSeriesForm today={today} onDone={(t, rej) => { setRepeating(false); showNotice(t, rej); }} /></Card> : null}
      {showSeries && canManage ? <Card className="space-y-2 p-3"><h2 className="text-base font-semibold text-slate-950">Manage repeating shifts</h2><SeriesList today={today} onDone={showNotice} /></Card> : null}
      {showLimits ? <Card className="p-3"><h2 className="mb-2 text-base font-semibold text-slate-950">Hours and limits</h2><HourLimitsPanel from={rangeFrom} to={to} canManage={canManage} /></Card> : null}
      {notice ? <p role="status" className="text-sm text-emerald-800">{notice}</p> : null}
      <RejectedDates items={rejectedDates} />
      {canManage ? <div id="pickups"><PickupRequestsPanel onDone={showNotice} /></div> : null}
      <section aria-labelledby="upcoming-heading" className="space-y-2">
        <h2 id="upcoming-heading" className="text-base font-semibold text-slate-950">Upcoming: need coverage ({uncovered.length})</h2>
        {shifts.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {shifts.isError ? <p role="alert" className="text-sm text-red-700">Shifts could not be loaded. {(shifts.error as Error).message}</p> : null}
        {shifts.data && uncovered.length === 0 ? <p className="text-sm text-slate-600">Every upcoming shift this {unit} has a caregiver.</p> : null}
        {uncovered.length > 0 ? <ShiftList label="Upcoming shifts that need coverage" shifts={uncovered} canManage={canManage} onDone={setNotice} focusShift={focusShift} autoAssign={params.get("coverage") === "1"} withDate /> : null}
      </section>
      {canManage ? (
        <section id="reconcile" aria-labelledby="past-heading" className="space-y-2">
          <h2 id="past-heading" className="text-base font-semibold text-slate-950">Past: need review {past.data ? `(${pastCount})` : ""}</h2>
          {past.isError ? <p role="status" className="text-sm text-red-700">Past shifts could not be loaded. Refresh the page.</p> : null}
          {past.data && pastCount === 0 ? <p className="text-sm text-slate-600">No past shift is waiting for a visit record.</p> : null}
          <ReconcileShiftsPanel onDone={showNotice} />
        </section>
      ) : null}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <ViewTabs view={view} onChange={(v) => { setView(v); if (v === "week") setFrom((f) => (view === "month" ? (f.slice(0, 7) === today.slice(0, 7) ? today : `${f.slice(0, 7)}-01`) : f)); }} />
        <Button type="button" variant="secondary" className="min-h-11 md:min-h-9" onClick={() => setFrom(stepAnchor(view, from, -1))}>← Previous {unit}</Button>
        <div><label htmlFor="sh-from" className="block text-xs font-medium text-slate-700">{view === "day" ? "Day" : view === "week" ? "Week starting" : "Month"}</label>{view === "month"
          ? <input id="sh-from" type="month" value={from.slice(0, 7)} onChange={(e) => e.target.value && setFrom(`${e.target.value}-01`)} className="mt-0.5 block min-h-11 rounded-lg border border-slate-200 px-3 text-base md:min-h-9 md:text-sm" />
          : <input id="sh-from" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="mt-0.5 block min-h-11 rounded-lg border border-slate-200 px-3 text-base md:min-h-9 md:text-sm" />}</div>
        <Button type="button" variant="secondary" className="min-h-11 md:min-h-9" onClick={() => setFrom(stepAnchor(view, from, 1))}>Next {unit} →</Button>
        <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800 md:min-h-9"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Needs coverage only</label>
        <FilterBar shifts={shifts.data ?? []} filters={filters} onChange={setFilters} />
      </div>
      {view === "month" && shifts.data ? <MonthGrid anchor={from} shifts={filtered.filter((s) => !onlyOpen || stateOfShift(s) === "needs_coverage")} onPickDay={(d) => { setView("day"); setFrom(d); }} /> : null}
      {view !== "month" && shifts.data && byDay.size === 0 ? <p className="text-sm text-slate-600">{onlyOpen ? `No other shift needs coverage this ${unit}.` : Object.values(filters).some(Boolean) ? "No other shifts match these filters." : uncovered.length > 0 ? `No other shifts this ${unit}.` : `No shifts this ${unit}.`}</p> : null}
      {view !== "month" ? [...byDay.entries()].map(([d, list]) => (
        <section key={d} aria-label={dayLabel(d)}>
          <h2 className="mb-1 text-sm font-semibold text-slate-800">{dayLabel(d)}</h2>
          <ShiftList label={`Shifts on ${dayLabel(d)}`} shifts={list} canManage={canManage} onDone={setNotice} focusShift={focusShift} autoAssign={params.get("coverage") === "1"} />
        </section>
      )) : null}
    </div>
  );
}

interface OpenShift { shiftId: string; startsAt: string; endsAt: string; minutes: number; clientCode: string; serviceName: string | null; coverageState: string; myRequestStatus?: "requested" | null }

/** Wave 1 (G09), changed by 0063: open shifts the caregiver is assigned to. Asking sends a request; the office confirms one caregiver. */
function OpenShiftsSection({ onPicked }: { onPicked: (text: string) => void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const { when, time } = useAgencyClock();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ shiftId: string; text: string } | null>(null);
  // One key per shift, so a double tap or a retry is the same request.
  const keys = useRef(new Map<string, string>());
  const open = useQuery({
    queryKey: ["aws-open-shifts", activeOrganizationId],
    queryFn: async () => (await api.get<{ shifts: OpenShift[] }>("/v1/open-shifts", { organizationId: activeOrganizationId })).shifts,
    enabled: !!activeOrganizationId,
  });
  async function pickUp(shiftId: string) {
    if (busyId) return;
    if (!keys.current.has(shiftId)) keys.current.set(shiftId, newIdempotencyKey());
    setBusyId(shiftId);
    setError(null);
    try {
      await api.post(`/v1/shifts/${encodeURIComponent(shiftId)}/pickup`, { organizationId: activeOrganizationId }, { idempotencyKey: keys.current.get(shiftId)! });
      keys.current.delete(shiftId);
      onPicked("Request sent. The office will confirm it. The shift is not yours until they do.");
    } catch (cause) {
      keys.current.delete(shiftId);
      setError({ shiftId, text: message(cause, "The request was not sent. Check your connection and try again.") });
    } finally {
      setBusyId(null);
      // Whatever happened, show the true state: someone else may have been confirmed.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["aws-open-shifts"] }),
        queryClient.invalidateQueries({ queryKey: ["aws-my-shifts"] }),
      ]);
    }
  }
  async function withdraw(shiftId: string) {
    if (busyId) return;
    setBusyId(shiftId);
    setError(null);
    try {
      await api.post(`/v1/shifts/${encodeURIComponent(shiftId)}/pickup/withdraw`, { organizationId: activeOrganizationId });
      onPicked("Request withdrawn.");
    } catch (cause) {
      setError({ shiftId, text: message(cause, "The request was not withdrawn. Try again.") });
    } finally {
      setBusyId(null);
      await queryClient.invalidateQueries({ queryKey: ["aws-open-shifts"] });
    }
  }
  if (open.isError) return <p role="alert" className="text-sm text-red-700">Open shifts could not be loaded. Refresh the page.</p>;
  if (!open.data || open.data.length === 0) return null;
  return (
    <section aria-labelledby="open-shifts-heading" className="space-y-2">
      <h2 id="open-shifts-heading" className="text-base font-semibold text-slate-950">Open shifts you can ask for</h2>
      <ShortHelp details="The office confirms one caregiver, and the shift appears in your list once it does.">Asking does not give you the shift.</ShortHelp>
      <ul className="space-y-1.5">
        {open.data.map((s) => (
          <li key={s.shiftId} className="rounded-lg border border-sky-200 bg-sky-50 p-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <p className="font-semibold text-slate-950">{when(s.startsAt)}–{time(s.endsAt)}</p>
                <p className="text-sm text-slate-800">Client {s.clientCode}{s.serviceName ? ` · ${s.serviceName}` : ""} · {formatDuration(s.minutes)}</p>
              </div>
              {s.myRequestStatus === "requested" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span data-testid="requested-badge" className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900">Requested — waiting for the office</span>
                  <Button type="button" variant="secondary" className="min-h-11" disabled={busyId !== null} loading={busyId === s.shiftId} onClick={() => void withdraw(s.shiftId)}>Withdraw request</Button>
                </div>
              ) : (
                <Button type="button" className="min-h-11" disabled={busyId !== null} loading={busyId === s.shiftId} onClick={() => void pickUp(s.shiftId)}>Request this shift</Button>
              )}
            </div>
            {error?.shiftId === s.shiftId ? <p role="alert" className="mt-1 text-sm text-red-700">{error.text}</p> : null}
          </li>
        ))}
      </ul>
    </section>
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
    if (reason.trim().length < 3) return setState({ busy: false, error: "Reason missing. Tell the office why you can't come.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      await api.post(`/v1/my-shifts/${encodeURIComponent(id)}/callout`, { organizationId: activeOrganizationId, reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await queryClient.invalidateQueries({ queryKey: ["aws-my-shifts"] });
      setOpen(null); setReason("");
      setState({ busy: false, error: null, done: "Sent. The office has been told you can't make this shift." });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not sent. Check your connection and try again, or call the office."), done: null });
    }
  }
  return (
    <div className="max-w-xl space-y-3">
      <h1 className="text-xl font-semibold text-slate-950">My shifts</h1>
      {state.done ? <p role="status" className="text-sm text-emerald-800">{state.done}</p> : null}
      <OpenShiftsSection onPicked={(text) => setState({ busy: false, error: null, done: text })} />
      {shifts.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {shifts.isError ? <p role="alert" className="text-sm text-red-700">{(shifts.error as Error).message}</p> : null}
      {shifts.data && shifts.data.length === 0 ? <p className="text-sm text-slate-600">No shifts in the next two weeks.</p> : null}
      <ul className="space-y-1.5">
        {(shifts.data ?? []).map((s) => (
          <li key={s.shiftId} className="rounded-lg border border-slate-200 bg-og-card p-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <p className="font-semibold text-slate-950">{when(s.startsAt)}–{time(s.endsAt)}</p>
                <p className="text-sm text-slate-800">Client {s.clientCode}{s.serviceName ? ` · ${s.serviceName}` : ""}</p>
              </div>
              {s.coverageState === "called_out" ? <p className="text-sm font-semibold text-amber-900">You called out. The office is finding cover.</p> : null}
              {s.canCallOut && open !== s.shiftId ? (
                <button type="button" className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-og-card px-4 text-sm font-medium text-slate-900 hover:bg-slate-50" onClick={() => { setOpen(s.shiftId); setState({ busy: false, error: null, done: null }); }}>I can't make it</button>
              ) : null}
            </div>
            {open === s.shiftId ? (
              <form onSubmit={(e) => { e.preventDefault(); void callOut(s.shiftId); }} className="mt-2 space-y-2">
                <label htmlFor={`co-${s.shiftId.slice(0, 8)}`} className="block text-sm font-medium text-slate-700">Why can't you come?</label>
                <input id={`co-${s.shiftId.slice(0, 8)}`} value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} />
                {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
                <div className="flex items-center gap-3"><Button type="submit" className="min-h-11" disabled={state.busy}>Tell the office</Button><button type="button" className="inline-flex min-h-11 items-center text-sm underline" onClick={() => setOpen(null)}>Keep the shift</button></div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
