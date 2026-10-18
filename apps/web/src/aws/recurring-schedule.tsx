// Recurring shifts (0034): weekly series with a preview of every date and each
// month's authorized, used, reserved and available time before saving; series
// list with "change from a date" and "end from a date"; "change this date only"
// for one occurrence. Every check runs on the server again; nothing is
// shortened, moved or skipped unless the person explicitly chooses to skip the
// listed dates.
import { nameWithCode } from "./name-label";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Button } from "@carelik/ui";
import { formatDateOnly, formatDuration, formatWeekdayDate } from "@/lib/service-verification";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { buildPattern, describePattern, hhmm, monthLabel, OUTCOME_LABEL, patternText, PLAIN_PATTERN, summarizeOccurrences, WEEKDAY_SHORT, type Occurrence, type PatternForm, type SeriesRow, type RejectedDate } from "./recurring-format";

const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
import { caregiverName, useCaregivers } from "./care-team-admin";
import { clientName, useClients, useServices } from "./client-admin";
import { ShortHelp } from "./help-text";


function PreviewTable({ rows }: { rows: Occurrence[] }) {
  const months = useMemo(() => summarizeOccurrences(rows), [rows]);
  return (
    <div className="min-w-0 space-y-3">
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Hours by month">
        {months.map((m) => (
          <li key={`${m.monthStart}-${m.authorized}`} className="rounded-lg border border-slate-200 bg-og-card p-2 text-sm">
            <p className="font-semibold text-slate-900">{monthLabel(m.monthStart)}</p>
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
              <dt className="text-slate-500">Authorized</dt><dd className="tabular-nums">{m.authorized === null ? "No authorization" : formatDuration(m.authorized)}</dd>
              <dt className="text-slate-500">Used</dt><dd className="tabular-nums">{m.used === null ? "—" : formatDuration(m.used)}</dd>
              <dt className="text-slate-500">Already reserved</dt><dd className="tabular-nums">{m.reserved === null ? "—" : formatDuration(m.reserved)}</dd>
              <dt className="text-slate-500">This series</dt><dd className="tabular-nums">{m.fits} dates · {formatDuration(m.fitsMinutes)}</dd>
              <dt className="font-medium text-slate-700">Available after</dt><dd className="font-semibold tabular-nums">{m.availableAfter === null ? "—" : formatDuration(m.availableAfter)}</dd>
            </dl>
          </li>
        ))}
      </ul>
      <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2" aria-label="Dates">
        {rows.map((r) => (
          <li key={r.localDate} className={r.outcome === "ok" ? "text-slate-800" : "font-semibold text-red-800"}>
            {formatWeekdayDate(r.localDate, "short")} · {formatDuration(r.minutes)}{r.outcome === "ok" ? "" : ` — ${OUTCOME_LABEL[r.outcome]}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

type SeriesForm = { clientId: string; serviceId: string; caregiverRecordId: string; weekdays: number[]; startTime: string; endTime: string; startsOn: string; endsOn: string };

/** Create a series, or (with `series`) change an existing one from a date ("this and future"). */
export function RecurringSeriesForm({ today, series, onDone }: { today: string; series?: SeriesRow; onDone: (text: string, rejected?: RejectedDate[]) => void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const clients = useClients();
  const services = useServices();
  const caregivers = useCaregivers();
  const [form, setForm] = useState<SeriesForm>(() => series
    ? { clientId: series.clientId, serviceId: "", caregiverRecordId: series.caregiverRecordId ?? "", weekdays: series.weekdays, startTime: hhmm(series.startTime), endTime: hhmm(series.endTime), startsOn: today > series.startsOn ? today : series.startsOn, endsOn: series.endsOn ?? "" }
    : { clientId: "", serviceId: "", caregiverRecordId: "", weekdays: [], startTime: "09:00", endTime: "11:00", startsOn: today, endsOn: "" });
  const [reason, setReason] = useState("");
  const [rule, setRule] = useState<PatternForm>(() => {
    const p = series?.pattern;
    return p ? { everyWeeks: p.every_weeks ?? 1, weekOffset: 0, dates: p.nth?.length ? "only" : p.except_nth?.length ? "except" : "all", nth: p.nth ?? p.except_nth ?? [], excludeDates: p.exclude_dates ?? [] } : PLAIN_PATTERN;
  });
  const [skipDate, setSkipDate] = useState("");
  const [preview, setPreview] = useState<Occurrence[] | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const set = <K extends keyof SeriesForm>(k: K, v: SeriesForm[K]) => { setForm((f) => ({ ...f, [k]: v })); setPreview(null); key.current = newIdempotencyKey(); };
  const setRuleField = <K extends keyof PatternForm>(k: K, v: PatternForm[K]) => { setRule((r) => ({ ...r, [k]: v })); setPreview(null); key.current = newIdempotencyKey(); };
  /** An existing series keeps its own weeks unless the person changes "Repeats"; its anchor is not re-derived from the new date. */
  const pattern = () => (series?.pattern && rule.everyWeeks === (series.pattern.every_weeks ?? 1) && rule.weekOffset === 0 && rule.everyWeeks > 1
    ? buildPattern({ ...rule, weekOffset: 0 }, series.pattern.anchor ?? form.startsOn)
    : buildPattern(rule, form.startsOn));
  const flagged = (preview ?? []).filter((r) => r.outcome !== "ok");
  const serviceId = series ? null : form.serviceId;

  async function runPreview() {
    if (!series && (!form.clientId || !form.serviceId)) return setState({ busy: false, error: "Choose the client and the service." });
    if (form.weekdays.length === 0) return setState({ busy: false, error: "Choose at least one weekday." });
    if (series && reason.trim().length < 3) return setState({ busy: false, error: "Give the reason for the change." });
    setState({ busy: true, error: null });
    try {
      const params = {
        organizationId: activeOrganizationId, clientId: series ? series.clientId : form.clientId,
        serviceId: series ? series.serviceId : serviceId,
        caregiverRecordId: form.caregiverRecordId || null, weekdays: form.weekdays.join(","), startTime: form.startTime, endTime: form.endTime,
        startsOn: form.startsOn, endsOn: form.endsOn || null, pattern: pattern() ? JSON.stringify(pattern()) : null,
      };
      const r = await api.get<{ occurrences: Occurrence[] }>("/v1/shift-series/preview", params);
      setPreview(r.occurrences);
      setState({ busy: false, error: null });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The preview could not be made.") });
    }
  }

  async function save(onConflict: "save_valid" | "refuse") {
    setState({ busy: true, error: null });
    try {
      if (series) {
        const r = await api.post<{ result: { cancelled: number; created: number; skipped: number; kept: number; rejected?: RejectedDate[] } }>(
          `/v1/shift-series/${encodeURIComponent(series.seriesId)}/change`,
          { organizationId: activeOrganizationId, fromDate: form.startsOn, caregiverRecordId: form.caregiverRecordId || null, weekdays: form.weekdays,
            startTime: form.startTime, endTime: form.endTime, endsOn: form.endsOn || null, onConflict, reason: reason.trim(), pattern: pattern(), clearPattern: pattern() === null },
          { idempotencyKey: key.current });
        onDone(`Series changed from ${formatDateOnly(form.startsOn)}: ${r.result.cancelled} earlier-planned dates cancelled, ${r.result.created} scheduled${r.result.skipped ? `, ${r.result.skipped} not saved (listed below)` : ""}${r.result.kept ? `; ${r.result.kept} kept because a visit is linked or it has started` : ""}.`, r.result.rejected);
      } else {
        const r = await api.post<{ series: { seriesId: string | null; created: number; skipped: number; reservedMinutes: number; generatedThrough: string; rejected?: RejectedDate[] } }>("/v1/shift-series",
          { organizationId: activeOrganizationId, clientId: form.clientId, serviceId: form.serviceId, caregiverRecordId: form.caregiverRecordId || null,
            weekdays: form.weekdays, startTime: form.startTime, endTime: form.endTime, startsOn: form.startsOn, endsOn: form.endsOn || null, onConflict, pattern: pattern() },
          { idempotencyKey: key.current });
        onDone(r.series.created === 0
          ? `Nothing was saved: none of the ${r.series.skipped} dates fits (listed below).`
          : `Series created: ${r.series.created} shifts scheduled through ${formatDateOnly(r.series.generatedThrough)} (${formatDuration(r.series.reservedMinutes)} reserved)${r.series.skipped ? `; ${r.series.skipped} dates were not saved (listed below)` : ""}.`, r.series.rejected);
      }
      key.current = newIdempotencyKey();
      await queryClient.invalidateQueries({ queryKey: ["aws-shifts"] });
      await queryClient.invalidateQueries({ queryKey: ["aws-shift-series"] });
      setState({ busy: false, error: null });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved.") });
    }
  }

  const id = series ? `rs-${series.seriesId.slice(0, 8)}` : "rs-new";
  return (
    <form onSubmit={(e) => { e.preventDefault(); void runPreview(); }} className="mt-3 grid min-w-0 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 [&>*]:min-w-0">
      {series ? (
        <ShortHelp className="text-sm text-slate-800 sm:col-span-2" details="Dates before the change date stay as they are; visits already done are never changed.">{series.clientName ?? series.clientCode} · {series.serviceName}</ShortHelp>
      ) : (
        <>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-client`} className="block text-sm font-medium text-slate-700">Client</label>
            <select id={`${id}-client`} value={form.clientId} onChange={(e) => set("clientId", e.target.value)} className={inputClass}>
              <option value="">Choose a client</option>
              {(clients.data ?? []).filter((c) => c.status === "active").map((c) => <option key={c.clientId} value={c.clientId}>{nameWithCode(clientName(c), c.clientCode, c.duplicateName)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-service`} className="block text-sm font-medium text-slate-700">Service</label>
            <select id={`${id}-service`} value={form.serviceId} onChange={(e) => set("serviceId", e.target.value)} className={inputClass}>
              <option value="">Choose a service</option>
              {(services.data ?? []).filter((s) => s.isActive).map((s) => <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.code})</option>)}
            </select>
          </div>
        </>
      )}
      <div className={series ? "sm:col-span-2" : ""}>
        <label htmlFor={`${id}-cg`} className="block text-sm font-medium text-slate-700">Caregiver (optional)</label>
        <select id={`${id}-cg`} value={form.caregiverRecordId} onChange={(e) => set("caregiverRecordId", e.target.value)} className={inputClass}>
          <option value="">Open shifts — fill later</option>
          {(caregivers.data ?? []).filter((c) => c.status === "ready" || c.status === "active").map((c) => (
            <option key={c.caregiverRecordId} value={c.caregiverRecordId}>{nameWithCode(caregiverName(c), c.caregiverCode, c.duplicateName)}</option>
          ))}
        </select>
      </div>
      <fieldset className="sm:col-span-2">
        <legend className="text-sm font-medium text-slate-700">Repeats every</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {WEEKDAY_SHORT.map((label, d) => (
            <label key={label} className="flex min-h-[40px] items-center gap-1 rounded-lg border border-slate-200 bg-og-card px-2 text-sm">
              <input type="checkbox" className="h-5 w-5" checked={form.weekdays.includes(d)}
                onChange={(e) => set("weekdays", e.target.checked ? [...form.weekdays, d].sort() : form.weekdays.filter((x) => x !== d))} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
        <legend className="text-sm font-medium text-slate-700">Which weeks and dates</legend>
        <div>
          <label htmlFor={`${id}-weeks`} className="block text-xs font-medium text-slate-600">Weeks</label>
          <select id={`${id}-weeks`} value={rule.everyWeeks} onChange={(e) => setRuleField("everyWeeks", Number(e.target.value))} className={inputClass}>
            <option value={1}>Every week</option><option value={2}>Every other week</option><option value={3}>Every 3rd week</option><option value={4}>Every 4th week</option>
          </select>
        </div>
        {rule.everyWeeks > 1 ? (
          <div>
            <label htmlFor={`${id}-offset`} className="block text-xs font-medium text-slate-600">Start with</label>
            <select id={`${id}-offset`} value={rule.weekOffset} onChange={(e) => setRuleField("weekOffset", Number(e.target.value) as 0 | 1)} className={inputClass}>
              <option value={0}>The week of the first date</option><option value={1}>The following week</option>
            </select>
          </div>
        ) : null}
        <div>
          <label htmlFor={`${id}-dates`} className="block text-xs font-medium text-slate-600">Dates in the month</label>
          <select id={`${id}-dates`} value={rule.dates} onChange={(e) => setRuleField("dates", e.target.value as PatternForm["dates"])} className={inputClass}>
            <option value="all">Every matching day</option><option value="only">Only certain ones (1st, 2nd…)</option><option value="except">Every one except certain ones</option>
          </select>
        </div>
        {rule.dates !== "all" ? (
          <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Which of the month's matching days">
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n} className="flex min-h-[40px] items-center gap-1 rounded-lg border border-slate-200 bg-og-card px-2 text-sm">
                <input type="checkbox" className="h-5 w-5" checked={rule.nth.includes(n)} onChange={(e) => setRuleField("nth", e.target.checked ? [...rule.nth, n] : rule.nth.filter((x) => x !== n))} />
                {["1st", "2nd", "3rd", "4th", "5th"][n - 1]}
              </label>
            ))}
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <label htmlFor={`${id}-skip`} className="block text-xs font-medium text-slate-600">Skip a date (holiday)</label>
          <div className="flex gap-2">
            <input id={`${id}-skip`} type="date" value={skipDate} min={form.startsOn} onChange={(e) => setSkipDate(e.target.value)} className={inputClass} />
            <Button type="button" variant="secondary" disabled={!skipDate || rule.excludeDates.includes(skipDate)}
              onClick={() => { setRuleField("excludeDates", [...rule.excludeDates, skipDate]); setSkipDate(""); }}>Add</Button>
          </div>
          {rule.excludeDates.length ? (
            <ul className="mt-1 flex flex-wrap gap-2 text-sm" aria-label="Skipped dates">
              {rule.excludeDates.map((d) => (
                <li key={d} className="rounded-full bg-slate-100 px-2 py-0.5">
                  {formatDateOnly(d)} <button type="button" aria-label={`Remove ${formatDateOnly(d)}`} className="ml-1 font-semibold" onClick={() => setRuleField("excludeDates", rule.excludeDates.filter((x) => x !== d))}>×</button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2 sm:col-span-2">
        <div><label htmlFor={`${id}-start`} className="block text-sm font-medium text-slate-700">Start time</label><input id={`${id}-start`} type="time" value={form.startTime} onChange={(e) => set("startTime", e.target.value)} className={inputClass} /></div>
        <div><label htmlFor={`${id}-end`} className="block text-sm font-medium text-slate-700">End time</label><input id={`${id}-end`} type="time" value={form.endTime} onChange={(e) => set("endTime", e.target.value)} className={inputClass} /></div>
        <div><label htmlFor={`${id}-from`} className="block text-sm font-medium text-slate-700">{series ? "Change from" : "First date"}</label><input id={`${id}-from`} type="date" value={form.startsOn} min={today} onChange={(e) => set("startsOn", e.target.value)} className={inputClass} /></div>
        <div><label htmlFor={`${id}-to`} className="block text-sm font-medium text-slate-700">Last date (optional)</label><input id={`${id}-to`} type="date" value={form.endsOn} min={form.startsOn} onChange={(e) => set("endsOn", e.target.value)} className={inputClass} /></div>
      </div>
      {series ? (
        <div className="sm:col-span-2">
          <label htmlFor={`${id}-reason`} className="block text-sm font-medium text-slate-700">Reason for the change</label>
          <input id={`${id}-reason`} value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} />
        </div>
      ) : null}
      <ShortHelp className="text-xs text-slate-600 sm:col-span-2" details="Shifts are created through the end of the second month; add later months from the series list. Each month is checked against that month's authorized hours, counting time already used and reserved.">Times are the agency's local time.</ShortHelp>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      <div className="sm:col-span-2"><Button type="submit" variant="secondary" disabled={state.busy}>Preview dates and hours</Button></div>
      {preview ? (
        <div className="min-w-0 space-y-3 sm:col-span-2">
          <PreviewTable rows={preview} />
          {flagged.length > 0 ? (
            <div role="alert" className="text-sm text-red-800">
              <p className="font-semibold">{flagged.length} {flagged.length === 1 ? "date does" : "dates do"} not fit (listed in red). {preview.length - flagged.length > 0
                ? `Saving keeps the ${preview.length - flagged.length} that fit.`
                : "None fits, so nothing can be saved. Change the times, days or dates."}</p>
              {preview.length - flagged.length > 0 ? <ShortHelp className="text-xs text-slate-700" details="Every date that was not saved is listed with its reason. Nothing is shortened or moved.">Dates that do not fit are skipped, not changed.</ShortHelp> : null}
            </div>
          ) : (
            <p className="text-sm text-emerald-800">Every date fits.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={state.busy || preview.length - flagged.length === 0} onClick={() => void save("save_valid")}>
              {series ? "Save the change" : "Create series"}{flagged.length > 0 && preview.length - flagged.length > 0 ? `: save the ${preview.length - flagged.length} that fit` : ""}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

function SeriesItem({ s, today, onDone }: { s: SeriesRow; today: string; onDone: (text: string, rejected?: RejectedDate[]) => void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [mode, setMode] = useState<"change" | "end" | null>(null);
  const [from, setFrom] = useState(today > s.startsOn ? today : s.startsOn);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  async function post(path: string, body: Record<string, unknown>, done: (r: never) => string) {
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ result: never }>(path, { organizationId: activeOrganizationId, ...body }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await queryClient.invalidateQueries({ queryKey: ["aws-shifts"] });
      await queryClient.invalidateQueries({ queryKey: ["aws-shift-series"] });
      setState({ busy: false, error: null });
      setMode(null);
      onDone(done(r.result), (r.result as { rejected?: RejectedDate[] }).rejected);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved.") });
    }
  }
  const nextMonthEnd = (() => { const d = new Date(`${s.generatedThrough}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 2, 0); return d.toISOString().slice(0, 10); })();
  return (
    <li className="rounded-xl border border-slate-200 bg-og-card p-3 text-sm">
      <p className="font-semibold text-slate-950">{s.clientName ?? s.clientCode} · {s.serviceName}</p>
      <p className="text-slate-800">{patternText(s.weekdays, s.startTime, s.endTime)}{describePattern(s.pattern) ? ` · ${describePattern(s.pattern)}` : ""} · {s.caregiverName ?? "Open — no caregiver"}</p>
      <p className="text-xs text-slate-600">
        From {formatDateOnly(s.startsOn)}{s.endsOn ? ` to ${formatDateOnly(s.endsOn)}` : " (no end date)"} · scheduled through {formatDateOnly(s.generatedThrough)} · {s.upcomingOccurrences} upcoming
        {s.status === "ended" ? " · ended" : ""}
      </p>
      {s.skippedDates.length > 0 ? (
        <details className="mt-1 text-xs text-red-800">
          <summary className="inline-flex min-h-6 cursor-pointer items-center [@media(pointer:coarse)]:min-h-[44px]">{s.skippedDates.length} skipped {s.skippedDates.length === 1 ? "date" : "dates"}</summary>
          <ul>{s.skippedDates.map((k) => <li key={k.date}>{formatDateOnly(k.date)} — {OUTCOME_LABEL[k.reason as Occurrence["outcome"]] ?? k.reason}</li>)}</ul>
        </details>
      ) : null}
      {s.status === "active" ? (
        <div className="mt-2 flex flex-wrap gap-3 font-medium text-slate-800">
          <button type="button" className="underline" onClick={() => setMode(mode === "change" ? null : "change")}>Change from a date</button>
          <button type="button" className="underline" onClick={() => setMode(mode === "end" ? null : "end")}>End from a date</button>
          {!s.endsOn || s.endsOn > s.generatedThrough ? (
            <button type="button" className="underline" disabled={state.busy}
              onClick={() => void post(`/v1/shift-series/${encodeURIComponent(s.seriesId)}/extend`, { through: s.endsOn && s.endsOn < nextMonthEnd ? s.endsOn : nextMonthEnd, onConflict: "save_valid" },
                (r: { created: number; skipped?: number; generatedThrough: string }) => `${r.created} more shifts scheduled through ${formatDateOnly(r.generatedThrough)}${r.skipped ? `; ${r.skipped} dates were not saved (listed below)` : ""}.`)}>
              Schedule the next month
            </button>
          ) : null}
        </div>
      ) : null}
      {mode === "change" ? <RecurringSeriesForm today={today} series={s} onDone={(t, rej) => { setMode(null); onDone(t, rej); }} /> : null}
      {mode === "end" ? (
        <form onSubmit={(e) => { e.preventDefault();
          if (reason.trim().length < 3) return setState({ busy: false, error: "Give the reason." });
          void post(`/v1/shift-series/${encodeURIComponent(s.seriesId)}/end`, { fromDate: from, reason: reason.trim() },
            (r: { cancelled: number; releasedMinutes: number; kept: number }) => `Series ended from ${formatDateOnly(from)}: ${r.cancelled} shifts cancelled, ${formatDuration(r.releasedMinutes)} returned to the authorization${r.kept ? `; ${r.kept} kept (visit linked or started)` : ""}.`); }}
          className="mt-2 grid gap-2 rounded-lg bg-slate-50 p-2 sm:grid-cols-2">
          <div><label htmlFor={`end-${s.seriesId.slice(0, 8)}`} className="block text-xs font-medium text-slate-600">First date to stop</label><input id={`end-${s.seriesId.slice(0, 8)}`} type="date" value={from} min={today} onChange={(e) => setFrom(e.target.value)} className={inputClass} /></div>
          <div><label htmlFor={`endr-${s.seriesId.slice(0, 8)}`} className="block text-xs font-medium text-slate-600">Reason</label><input id={`endr-${s.seriesId.slice(0, 8)}`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={inputClass} /></div>
          <div className="sm:col-span-2"><Button type="submit" variant="secondary" disabled={state.busy}>End series from this date</Button></div>
        </form>
      ) : null}
      {state.error ? <p role="alert" className="mt-1 text-sm text-red-700">{state.error}</p> : null}
    </li>
  );
}

export function SeriesList({ today, onDone }: { today: string; onDone: (text: string, rejected?: RejectedDate[]) => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const series = useQuery({
    queryKey: ["aws-shift-series", activeOrganizationId],
    queryFn: async () => (await api.get<{ series: SeriesRow[] }>("/v1/shift-series", { organizationId: activeOrganizationId })).series,
    enabled: !!activeOrganizationId,
  });
  if (series.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (series.isError) return <p role="alert" className="text-sm text-red-700">{(series.error as Error).message}</p>;
  const active = (series.data ?? []).filter((s) => s.status === "active");
  if (active.length === 0) return <p className="text-sm text-slate-600">No recurring series yet.</p>;
  return <ul className="space-y-2">{active.map((s) => <SeriesItem key={s.seriesId} s={s} today={today} onDone={onDone} />)}</ul>;
}

/** One occurrence only: new date/time; the reservation moves with it (server-checked). */
export function RescheduleForm({ shiftId, localDate, startsAt, endsAt, onClose, onDone }: {
  shiftId: string; localDate: string; startsAt: string; endsAt: string; onClose: () => void; onDone: (text: string) => void;
}) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, activeOrganization } = useOrganization();
  const tz = (activeOrganization as { timezone?: string } | null)?.timezone || "America/Los_Angeles";
  const local = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const [form, setForm] = useState({ date: localDate, startTime: local(startsAt), endTime: local(endsAt), reason: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const id = `rsh-${shiftId.slice(0, 8)}`;
  async function submit() {
    if (form.reason.trim().length < 3) return setState({ busy: false, error: "Give the reason." });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ shift: { reservedMinutes: number; remainingMinutes: number | string } }>(`/v1/shifts/${encodeURIComponent(shiftId)}/reschedule`,
        { organizationId: activeOrganizationId, date: form.date, startTime: form.startTime, endTime: form.endTime, reason: form.reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await queryClient.invalidateQueries({ queryKey: ["aws-shifts"] });
      onDone(`This date only was changed: ${formatDuration(r.shift.reservedMinutes)} reserved; ${formatDuration(Number(r.shift.remainingMinutes))} of authorized time left that month. The rest of the series is unchanged.`);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved.") });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-2 grid gap-2 rounded-lg bg-slate-50 p-2 sm:grid-cols-3">
      <div><label htmlFor={`${id}-d`} className="block text-xs font-medium text-slate-600">Date</label><input id={`${id}-d`} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={inputClass} /></div>
      <div><label htmlFor={`${id}-s`} className="block text-xs font-medium text-slate-600">Start time</label><input id={`${id}-s`} type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className={inputClass} /></div>
      <div><label htmlFor={`${id}-e`} className="block text-xs font-medium text-slate-600">End time</label><input id={`${id}-e`} type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className={inputClass} /></div>
      <div className="sm:col-span-3"><label htmlFor={`${id}-r`} className="block text-xs font-medium text-slate-600">Reason</label><input id={`${id}-r`} value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={inputClass} /></div>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-3">{state.error}</p> : null}
      <div className="flex gap-2 sm:col-span-3"><Button type="submit" disabled={state.busy}>Change this date only</Button><button type="button" className="text-sm underline" onClick={onClose}>Close</button></div>
    </form>
  );
}

/** Every date that was not saved, with its reason (0061). Nothing is cut off. */
export function RejectedDates({ items }: { items: RejectedDate[] }) {
  if (items.length === 0) return null;
  return (
    <section data-testid="rejected-dates" aria-label="Dates that were not saved" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      <h3 className="font-semibold">{items.length} {items.length === 1 ? "date was" : "dates were"} not saved</h3>
      <ul className="mt-1 space-y-0.5">
        {items.map((r) => <li key={r.localDate}>{formatDateOnly(r.localDate)} — {OUTCOME_LABEL[r.reason as Occurrence["outcome"]] ?? r.reason}</li>)}
      </ul>
    </section>
  );
}
