import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { formatDateOnly } from "@/lib/service-verification";
import { useAwsApi } from "../aws-workspace";
import { useGuardedMutate } from "./use-guarded";
import { useAvailability } from "./queries";
import { DAY_NAMES, REQUEST_STATUS_BADGE, REQUEST_STATUS_LABEL, actionError, rangeLabel, weeklySummary, type HoursRange } from "./format";
import { AuditList } from "../ui/audit-list";
import { InfoTip } from "../ui/info-tip";

export interface AvailabilityRequestRow {
  requestId: string;
  kind: "weekly" | "date";
  status: string;
  source?: string;
  reason: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  windows: HoursRange[];
  requestedAt?: string;
  reviewNote?: string | null;
  reviewedAt?: string | null;
}

export interface AvailabilityState {
  caregiverRecordId: string;
  timezone: string;
  version: number;
  provided: boolean;
  asOf: string;
  weekly: HoursRange[];
  upcomingWeekly: { requestId: string; effectiveFrom: string; effectiveUntil: string | null; windows: HoursRange[] }[];
  exceptions: { date: string; hours: { source: string; unavailable: boolean; windows: HoursRange[] } }[];
  pending: AvailabilityRequestRow[];
  recent: AvailabilityRequestRow[];
}

const inputClass = "mt-1 block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm";
export const SENT_MESSAGE = "Request sent. Your current hours stay in place until approved.";

/** The APPROVED hours, with the agency time zone. "Not provided" when nothing has ever been approved or entered. */
export function CurrentAvailability({ state }: { state: AvailabilityState }) {
  return (
    <div className="space-y-1.5 text-sm text-slate-800">
      <p className="text-xs text-slate-600">All times are in agency time ({state.timezone}).</p>
      {!state.provided ? (
        <p className="font-medium text-amber-900">Not provided</p>
      ) : (
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-0.5">
          {weeklySummary(state.weekly).map((d) => (
            <div key={d.weekday} className="contents">
              <dt className="font-medium text-slate-700">{d.name}</dt>
              <dd>{d.ranges.length ? d.ranges.join(", ") : <span className="text-slate-500">Not available</span>}</dd>
            </div>
          ))}
        </dl>
      )}
      {state.upcomingWeekly.map((u) => (
        <p key={u.requestId} className="text-slate-700">
          Approved change from {formatDateOnly(u.effectiveFrom)}{u.effectiveUntil ? ` to ${formatDateOnly(u.effectiveUntil)}` : ""}.
        </p>
      ))}
      {state.exceptions.length ? (
        <div>
          <p className="font-medium text-slate-700">Specific dates</p>
          <ul className="space-y-0.5">
            {state.exceptions.map((e) => (
              <li key={e.date}>{formatDateOnly(e.date)}: {e.hours.unavailable ? "Not available" : e.hours.windows.map(rangeLabel).join(", ")}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function RequestHistory({ rows, canWithdraw, onWithdraw, busyId }: { rows: AvailabilityRequestRow[]; canWithdraw?: boolean; onWithdraw?: (id: string) => void; busyId?: string | null }) {
  if (!rows.length) return <p className="text-sm text-slate-500">No requests yet.</p>;
  const title = (r: AvailabilityRequestRow) => `${r.kind === "weekly" ? "Weekly hours" : "Specific date"} · from ${formatDateOnly(r.effectiveFrom)}${r.kind === "weekly" && r.effectiveUntil ? ` to ${formatDateOnly(r.effectiveUntil)}` : ""}`;
  if (!canWithdraw) {
    // Decided requests are history: one compact row each (when, outcome, what), the reason and any decline note on expanding.
    return (
      <AuditList label="Availability decisions" maxHeightClass="max-h-48"
        rows={rows.map((r) => ({
          id: r.requestId, when: formatDateOnly(r.effectiveFrom), who: REQUEST_STATUS_LABEL[r.status] ?? r.status, summary: `${title(r)} · Reason: ${r.reason}`,
          detail: r.status === "declined" && r.reviewNote ? <p>Declined: {r.reviewNote}</p> : undefined,
        }))} />
    );
  }
  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li key={r.requestId} className="rounded-md border border-slate-200 px-2 py-1 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium text-slate-900">{title(r)}</p>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${REQUEST_STATUS_BADGE[r.status] ?? "bg-slate-100"}`}>{REQUEST_STATUS_LABEL[r.status] ?? r.status}</span>
          </div>
          <p className="text-xs text-slate-700">Reason: {r.reason}</p>
          {r.status === "declined" && r.reviewNote ? <p className="text-xs text-slate-800">Declined: {r.reviewNote}</p> : null}
          {r.status === "pending" ? (
            <Button type="button" variant="secondary" className="mt-1" disabled={busyId === r.requestId} onClick={() => onWithdraw?.(r.requestId)}>
              {busyId === r.requestId ? "Withdrawing…" : "Withdraw request"}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

type DayState = { on: boolean; ranges: { start: string; end: string }[] };
const emptyWeek = (): DayState[] => DAY_NAMES.map(() => ({ on: false, ranges: [{ start: "08:00", end: "17:00" }] }));
function weekFrom(windows: HoursRange[]): DayState[] {
  const week = emptyWeek();
  for (const w of windows) {
    if (w.weekday === null || w.weekday === undefined) continue;
    const d = week[w.weekday]!;
    if (!d.on) { d.on = true; d.ranges = []; }
    d.ranges.push({ start: w.start_local.slice(0, 5), end: w.end_local.slice(0, 5) });
  }
  return week;
}

/**
 * Request a change to availability. A reason and a start date are required; a temporary change needs an end
 * date. Nothing changes until an administrator approves, and the form keeps what was typed after an error.
 * With mode="administrator" the same form records a direct edit (a reason is still required and it is audited).
 */
export function AvailabilityRequestForm({ state, mode = "caregiver" }: { state: AvailabilityState; mode?: "caregiver" | "administrator" }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [kind, setKind] = useState<"weekly" | "date">("weekly");
  const [week, setWeek] = useState<DayState[]>(() => weekFrom(state.weekly));
  const [from, setFrom] = useState(state.asOf);
  const [temporary, setTemporary] = useState(false);
  const [until, setUntil] = useState("");
  const [onDate, setOnDate] = useState(state.asOf);
  const [unavailable, setUnavailable] = useState(false);
  const [dayRanges, setDayRanges] = useState([{ start: "09:00", end: "17:00" }]);
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());
  const touch = () => { key.current = newIdempotencyKey(); setSent(null); };
  const direct = mode === "administrator";

  const submit = useMutation({
    mutationFn: async () => {
      const windows = kind === "weekly"
        ? week.flatMap((d, weekday) => (d.on ? d.ranges.map((r) => ({ weekday, start_local: r.start, end_local: r.end })) : []))
        : unavailable ? [] : dayRanges.map((r) => ({ start_local: r.start, end_local: r.end }));
      const base = {
        organizationId: activeOrganizationId,
        kind,
        windows,
        effectiveFrom: kind === "weekly" ? from : onDate,
        effectiveUntil: kind === "weekly" && temporary ? until || null : null,
        reason: reason.trim(),
      };
      const options = { idempotencyKey: key.current };
      return direct
        ? api.post<{ result: { affectedShifts: unknown[] } }>(`/v1/caregivers/${encodeURIComponent(state.caregiverRecordId)}/availability`, base, options)
        : api.post<{ requestId: string }>("/v1/availability/requests", { ...base, baseVersion: state.version }, options);
    },
    onSuccess: (r) => {
      key.current = newIdempotencyKey();
      setReason("");
      const affected = direct ? (r as { result: { affectedShifts: unknown[] } }).result.affectedShifts.length : 0;
      setSent(direct ? `Availability saved.${affected ? ` ${affected} future shift${affected === 1 ? "" : "s"} now fall${affected === 1 ? "s" : ""} outside the approved hours and ${affected === 1 ? "is" : "are"} flagged for review.` : ""}` : SENT_MESSAGE);
      void qc.invalidateQueries({ queryKey: ["availability"] });
      void qc.invalidateQueries({ queryKey: ["availability-requests"] });
    },
  });

  const setDay = (i: number, patch: Partial<DayState>) => { touch(); setWeek((w) => w.map((d, j) => (j === i ? { ...d, ...patch } : d))); };
  const setRange = (i: number, r: number, patch: Partial<{ start: string; end: string }>) =>
    setDay(i, { ranges: week[i]!.ranges.map((x, j) => (j === r ? { ...x, ...patch } : x)) });
  const send = useGuardedMutate(submit);
  const disabled = submit.isPending || reason.trim().length < 3 || (kind === "weekly" && (!from || (temporary && !until) || !week.some((d) => d.on)));

  return (
    <form
      className="space-y-3"
      aria-label={direct ? "Edit availability" : "Request change"}
      onSubmit={(e) => { e.preventDefault(); if (!disabled) send(); }}
    >
      <div role="tablist" aria-label="What to change" className="flex gap-2">
        {([["weekly", "Weekly hours"], ["date", "Specific date"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => { touch(); setKind(k); }}
            className={`min-h-[44px] rounded-md border px-3 text-sm font-medium ${kind === k ? "border-og-accent bg-og-active text-og-accent" : "border-slate-300 bg-og-card text-slate-800"}`}>{label}</button>
        ))}
      </div>

      {kind === "weekly" ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-800">Days and times</legend>
          <InfoTip label="Help">This sets your whole week from the start date. Days left unticked are days you are not available.</InfoTip>
          {DAY_NAMES.map((name, i) => (
            <div key={name} className="rounded-lg border border-slate-200 p-2">
              <label className="flex min-h-[44px] items-center gap-2 text-sm font-medium text-slate-900">
                <input type="checkbox" checked={week[i]!.on} onChange={(e) => setDay(i, { on: e.target.checked })} className="h-5 w-5" />
                {name}
              </label>
              {week[i]!.on ? (
                <div className="mt-1 space-y-2 pl-7">
                  {week[i]!.ranges.map((r, j) => (
                    <div key={j} className="flex flex-wrap items-end gap-2">
                      <label className="text-sm">From<input type="time" value={r.start} onChange={(e) => setRange(i, j, { start: e.target.value })} className={inputClass} aria-label={`${name} range ${j + 1} from`} /></label>
                      <label className="text-sm">To<input type="time" value={r.end} onChange={(e) => setRange(i, j, { end: e.target.value })} className={inputClass} aria-label={`${name} range ${j + 1} to`} /></label>
                      {week[i]!.ranges.length > 1 ? <button type="button" className="min-h-[44px] text-sm underline" onClick={() => setDay(i, { ranges: week[i]!.ranges.filter((_, k) => k !== j) })}>Remove</button> : null}
                    </div>
                  ))}
                  <button type="button" className="min-h-[44px] text-sm font-medium text-og-accent underline" onClick={() => setDay(i, { ranges: [...week[i]!.ranges, { start: "13:00", end: "17:00" }] })}>Add another time range</button>
                </div>
              ) : null}
            </div>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-slate-800">Starts<input type="date" value={from} min={state.asOf} onChange={(e) => { touch(); setFrom(e.target.value); }} className={inputClass} /></label>
            <div>
              <label className="flex min-h-[44px] items-center gap-2 text-sm font-medium text-slate-800">
                <input type="checkbox" checked={temporary} onChange={(e) => { touch(); setTemporary(e.target.checked); }} className="h-5 w-5" />Temporary change
              </label>
              {temporary ? <label className="text-sm font-medium text-slate-800">Ends<input type="date" value={until} min={from} onChange={(e) => { touch(); setUntil(e.target.value); }} className={inputClass} /></label> : null}
            </div>
          </div>
        </fieldset>
      ) : (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-800">Specific date</legend>
          <p className="text-xs text-slate-600">The hours you give replace your usual hours for that one day.</p>
          <label className="text-sm font-medium text-slate-800">Date<input type="date" value={onDate} min={state.asOf} onChange={(e) => { touch(); setOnDate(e.target.value); }} className={inputClass} /></label>
          <label className="flex min-h-[44px] items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" checked={unavailable} onChange={(e) => { touch(); setUnavailable(e.target.checked); }} className="h-5 w-5" />Not available that day
          </label>
          {!unavailable ? dayRanges.map((r, j) => (
            <div key={j} className="flex flex-wrap items-end gap-2">
              <label className="text-sm">From<input type="time" value={r.start} onChange={(e) => { touch(); setDayRanges((x) => x.map((y, k) => (k === j ? { ...y, start: e.target.value } : y))); }} className={inputClass} aria-label={`Range ${j + 1} from`} /></label>
              <label className="text-sm">To<input type="time" value={r.end} onChange={(e) => { touch(); setDayRanges((x) => x.map((y, k) => (k === j ? { ...y, end: e.target.value } : y))); }} className={inputClass} aria-label={`Range ${j + 1} to`} /></label>
              {dayRanges.length > 1 ? <button type="button" className="min-h-[44px] text-sm underline" onClick={() => { touch(); setDayRanges((x) => x.filter((_, k) => k !== j)); }}>Remove</button> : null}
            </div>
          )) : null}
          {!unavailable ? <button type="button" className="min-h-[44px] text-sm font-medium text-og-accent underline" onClick={() => { touch(); setDayRanges((x) => [...x, { start: "13:00", end: "17:00" }]); }}>Add another time range</button> : null}
        </fieldset>
      )}

      <label className="block text-sm font-medium text-slate-800">Reason
        <textarea value={reason} onChange={(e) => { touch(); setReason(e.target.value); }} rows={3} maxLength={500} className={inputClass} />
      </label>
      {submit.isError ? <p role="alert" className="text-sm text-red-700">{actionError(submit.error, "The request could not be sent.")}</p> : null}
      {sent ? <p role="status" className="text-sm font-medium text-emerald-800">{sent}</p> : null}
      <Button type="submit" disabled={disabled}>{submit.isPending ? "Sending…" : direct ? "Save change" : "Submit request"}</Button>
    </form>
  );
}

/** The caregiver's own page section: approved hours, request status, and the form. */
export function MyAvailability() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const q = useAvailability();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (q.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (q.isError || !q.data) return <p role="alert" className="text-sm text-red-700">{actionError(q.error, "Your availability could not be loaded.")}</p>;
  const state = q.data;
  const withdraw = async (id: string) => {
    setBusy(id); setError(null);
    try {
      await api.post(`/v1/availability/requests/${encodeURIComponent(id)}/withdraw`, { organizationId: activeOrganizationId });
      await qc.invalidateQueries({ queryKey: ["availability"] });
    } catch (e) { setError(actionError(e, "The request could not be withdrawn.")); } finally { setBusy(null); }
  };
  return (
    <div className="space-y-3">
      <Card>
        <h2 className="text-sm font-semibold text-slate-950">Approved hours</h2>
        <div className="mt-2"><CurrentAvailability state={state} /></div>
      </Card>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-950">Pending changes</h2>
          <Button type="button" className="min-h-11" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Close" : "Request change"}</Button>
        </div>
        {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
        <div className="mt-2"><RequestHistory rows={state.pending} canWithdraw onWithdraw={withdraw} busyId={busy} /></div>
        {open ? <div className="mt-2 border-t border-slate-200 pt-2"><AvailabilityRequestForm state={state} /></div> : null}
      </Card>
      <Card>
        <h2 className="text-sm font-semibold text-slate-950">Recent decisions</h2>
        <div className="mt-2"><RequestHistory rows={state.recent} /></div>
      </Card>
    </div>
  );
}
