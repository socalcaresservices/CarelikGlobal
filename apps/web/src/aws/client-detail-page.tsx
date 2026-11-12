import { ClientQrCard } from "./client-qr";
import { HoursBreakdown } from "@/components/hours-breakdown";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { agencyMonth, useAgencyClock } from "./agency-clock";
import { Button, Card } from "@carelik/ui";
import { formatDuration, TIER_LABEL, TIER_SYMBOL } from "@/lib/service-verification";
import { formatHours, hoursLeftLine } from "@/lib/hours-accounting";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import {
  clientName, dollarsToCents, formatRate, groupByLineage, hoursToMinutes, STATUS_BADGE, STATUS_LABEL,
  useClientAuthorizations, useClients, useMonthlyBalances, useServices,
  type AdminClient, type AuthorizationVersion, type ClientStatus,
} from "./client-admin";
import { AssignmentsCard } from "./assignments-card";
import { ClientExperience, MatchingLocation } from "./readiness/matching-inputs";
import { ClientTypeField } from "./clients-page";
import { CaregiverSummary, ClientAlertsCard, ClientDocumentsCard, ClientHistoryCard, ClientQuickActions, DuplicateWarning, NextVisitsCard, ReadinessCard } from "./client-extras";
import { useDuplicateClients } from "./client-data";
import { formatDateOnly } from "@/lib/service-verification";
import { Hint } from "./hint";
import { linkClass } from "./ui-classes";
import { CompactAlert } from "./ui/compact-alert";
import { SummarySection } from "./ui/summary-section";
import { actionBtn, actionBtnPrimary } from "./ui-classes";
import { InfoTip } from "./ui/info-tip";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const fmtDate = (d: string | null) => formatDateOnly(d);
const minutesAsHours = (m: number) => (m % 60 === 0 ? String(m / 60) : (m / 60).toFixed(2));

function useRefreshClient() {
  const queryClient = useQueryClient();
  return async () => {
    for (const k of ["aws-clients", "aws-client-directory", "aws-client-authorizations", "aws-client-balances", "service-visit-report", "service-visit-report-calendar", "client-readiness", "client-issues", "client-audit", "action-issues"]) {
      await queryClient.invalidateQueries({ queryKey: [k] });
    }
  };
}

function DetailsCard({ c, canManage }: { c: AdminClient; canManage: boolean }) {
  const api = useAwsApi();
  const refresh = useRefreshClient();
  const { activeOrganizationId } = useOrganization();
  const initial = { first: c.legalFirstName ?? "", last: c.legalLastName ?? "", city: c.city ?? "", type: c.clientTypeId ?? "", label: c.caregiverDisplayCode ?? "" };
  const [form, setForm] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [dupConfirmed, setDupConfirmed] = useState(false);
  const nameChanged = form.first.trim().toLowerCase() !== (c.legalFirstName ?? "").trim().toLowerCase() || form.last.trim().toLowerCase() !== (c.legalLastName ?? "").trim().toLowerCase();
  const dupes = useDuplicateClients(nameChanged && editing ? form.first : "", nameChanged && editing ? form.last : "", c.clientId);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  useEffect(() => setForm({ first: c.legalFirstName ?? "", last: c.legalLastName ?? "", city: c.city ?? "", type: c.clientTypeId ?? "", label: c.caregiverDisplayCode ?? "" }),
    [c.legalFirstName, c.legalLastName, c.city, c.clientTypeId, c.caregiverDisplayCode]);
  const set = (k: keyof typeof form) => (v: string) => { setForm((f) => ({ ...f, [k]: v })); key.current = newIdempotencyKey(); setState((s) => ({ ...s, done: false })); };
  async function save() {
    if (!form.first.trim() || !form.last.trim()) return setState({ busy: false, error: "Enter the client's first and last name.", done: false });
    if (nameChanged && (dupes.data ?? []).some((m) => m.match === "same_name") && !dupConfirmed) return setState({ busy: false, error: "A client with this name already exists. Confirm it is a different person, or change the name.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/clients/${encodeURIComponent(c.clientId)}/details`, {
        organizationId: activeOrganizationId, firstName: form.first.trim(), lastName: form.last.trim(),
        city: form.city.trim() || null, clientTypeId: form.type || null, caregiverLabel: form.label.trim() || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setEditing(false);
      setDupConfirmed(false);
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved."), done: false });
    }
  }
  if (!canManage) {
    return (
      <SummarySection title="Details" summary={`City: ${c.city ?? "—"} · Type: ${c.clientTypeName ?? "—"} · Code: ${c.clientCode} · Caregivers see: ${c.caregiverDisplayCode ?? c.clientCode}`}>
        <p className="text-sm text-slate-700">Name and contact changes are made by the office.</p>
      </SummarySection>
    );
  }
  if (!editing) {
    return (
      <SummarySection title="Details" id="details" testId="details-readonly" summary={[c.city, c.clientTypeName].filter(Boolean).join(" · ") || "No city or type"}>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-slate-600">Name</dt><dd>{clientName(c) ?? "Not set"}</dd></div>
          <div><dt className="text-xs text-slate-600">City</dt><dd>{c.city ?? "—"}</dd></div>
          <div><dt className="text-xs text-slate-600">Type</dt><dd>{c.clientTypeName ?? "—"}</dd></div>
          <div><dt className="text-xs text-slate-600">Client code</dt><dd>{c.clientCode}</dd></div>
          <div><dt className="text-xs text-slate-600">Caregivers see</dt><dd>{c.caregiverDisplayCode ?? c.clientCode}</dd></div>
        </dl>
        <button type="button" className={`mt-2 ${actionBtn}`} onClick={() => { setEditing(true); setState({ busy: false, error: null, done: false }); }}>Edit details</button>
        {state.done ? <p role="status" className="mt-2 text-sm text-emerald-800">Saved. The change is in the client&apos;s history.</p> : null}
      </SummarySection>
    );
  }
  return (
    <Card className="p-3" id="details">
      <h2 className="text-base font-semibold text-slate-950">Edit details</h2>
      <span data-testid="edit-impact"><InfoTip label="Help">Changes are recorded in the client&apos;s history. Changing the type can change which caregivers match a care request.</InfoTip></span>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-3 grid gap-3 sm:grid-cols-2">
        <div><label htmlFor="edit-first" className="block text-sm font-medium text-slate-700">First name</label><input id="edit-first" value={form.first} maxLength={80} autoComplete="off" onChange={(e) => set("first")(e.target.value)} className={inputClass} /></div>
        <div><label htmlFor="edit-last" className="block text-sm font-medium text-slate-700">Last name</label><input id="edit-last" value={form.last} maxLength={80} autoComplete="off" onChange={(e) => set("last")(e.target.value)} className={inputClass} /></div>
        <div><label htmlFor="edit-city" className="block text-sm font-medium text-slate-700">City (optional)</label><input id="edit-city" value={form.city} maxLength={80} autoComplete="off" onChange={(e) => set("city")(e.target.value)} className={inputClass} /></div>
        <ClientTypeField id="edit-type" value={form.type} onChange={set("type")} />
        <div className="sm:col-span-2"><label htmlFor="edit-label" className="block text-sm font-medium text-slate-700">Label caregivers see instead of {c.clientCode} (optional)</label><input id="edit-label" value={form.label} maxLength={40} autoComplete="off" onChange={(e) => set("label")(e.target.value)} className={inputClass} /></div>
        {nameChanged ? <DuplicateWarning matches={dupes.data} confirmed={dupConfirmed} onConfirm={setDupConfirmed} /> : null}
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
        <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save details"}</Button><Button type="button" variant="secondary" disabled={state.busy} onClick={() => { setEditing(false); setForm(initial); setDupConfirmed(false); setState({ busy: false, error: null, done: false }); }}>Cancel</Button></div>
      </form>
    </Card>
  );
}

function StatusCard({ c }: { c: AdminClient }) {
  const api = useAwsApi();
  const refresh = useRefreshClient();
  const { activeOrganizationId } = useOrganization();
  const [status, setStatus] = useState<ClientStatus>(c.status === "active" ? "inactive" : "active");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  useEffect(() => setStatus(c.status === "active" ? "inactive" : "active"), [c.status]);
  async function save() {
    if (reason.trim().length < 3) return setState({ busy: false, error: "Give a reason for the change.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/clients/${encodeURIComponent(c.clientId)}/status`, { organizationId: activeOrganizationId, status, reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setReason("");
      await refresh();
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Status not changed."), done: false });
    }
  }
  const options = (["active", "inactive", "discharged"] as const).filter((x) => x !== c.status);
  return (
    <SummarySection title="Status" status={<span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span>}>
      <Hint details="Their records and history are kept." show>Inactive and discharged clients cannot be scheduled or visited.</Hint>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-3 space-y-3">
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Change to</legend>
          <div className="flex flex-wrap gap-x-5">
            {options.map((o) => (
              <label key={o} className="flex min-h-[44px] items-center gap-2 text-sm"><input type="radio" name="status-new" className="h-5 w-5" checked={status === o} onChange={() => { setStatus(o); key.current = newIdempotencyKey(); }} />{STATUS_LABEL[o]}</label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="status-reason" className="block text-sm font-medium text-slate-700">Reason</label>
          <input id="status-reason" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} />
        </div>
        <Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Change status"}</Button>
      </form>
      {state.error ? <p role="alert" className="mt-2 text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="mt-2 text-sm text-emerald-800">Status changed.</p> : null}
    </SummarySection>
  );
}

interface Terms { payer: string; number: string; hours: string; start: string; end: string; received: string; source: string }
const emptyTerms: Terms = { payer: "", number: "", hours: "", start: "", end: "", received: "", source: "" };

function termsError(t: Terms): string | null {
  if (!t.payer.trim()) return "Enter the payer.";
  if (hoursToMinutes(t.hours) === null) return "Enter hours per month, for example 30, 30.5 or 30:30 (at most 744).";
  if (!t.start || !t.end) return "Enter the start and end dates.";
  if (t.end <= t.start) return "The end date must be after the start date.";
  return null;
}

function TermsFields({ t, set, idPrefix }: { t: Terms; set: (k: keyof Terms) => (v: string) => void; idPrefix: string }) {
  const minutes = hoursToMinutes(t.hours);
  return (
    <>
      <div><label htmlFor={`${idPrefix}-payer`} className="block text-sm font-medium text-slate-700">Payer</label><input id={`${idPrefix}-payer`} value={t.payer} maxLength={120} onChange={(e) => set("payer")(e.target.value)} className={inputClass} /></div>
      <div><label htmlFor={`${idPrefix}-number`} className="block text-sm font-medium text-slate-700">Authorization number (optional)</label><input id={`${idPrefix}-number`} value={t.number} maxLength={80} autoComplete="off" onChange={(e) => set("number")(e.target.value)} className={inputClass} /></div>
      <div>
        <label htmlFor={`${idPrefix}-hours`} className="block text-sm font-medium text-slate-700">Authorized hours per month</label>
        <input id={`${idPrefix}-hours`} inputMode="decimal" value={t.hours} onChange={(e) => set("hours")(e.target.value)} className={inputClass} aria-describedby={`${idPrefix}-hours-help`} />
        <p id={`${idPrefix}-hours-help`} className="mt-1 text-xs text-slate-600">{minutes !== null ? `= ${formatDuration(minutes)} each month` : "For example 30, 30.5 or 30:30"}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div><label htmlFor={`${idPrefix}-start`} className="block text-sm font-medium text-slate-700">Start date</label><input id={`${idPrefix}-start`} type="date" value={t.start} onChange={(e) => set("start")(e.target.value)} className={inputClass} /></div>
        <div><label htmlFor={`${idPrefix}-end`} className="block text-sm font-medium text-slate-700">End date</label><input id={`${idPrefix}-end`} type="date" value={t.end} onChange={(e) => set("end")(e.target.value)} className={inputClass} /></div>
      </div>
      <div><label htmlFor={`${idPrefix}-received`} className="block text-sm font-medium text-slate-700">Date received (optional)</label><input id={`${idPrefix}-received`} type="date" value={t.received} onChange={(e) => set("received")(e.target.value)} className={inputClass} /></div>
      <div><label htmlFor={`${idPrefix}-source`} className="block text-sm font-medium text-slate-700">Source reference (optional)</label><input id={`${idPrefix}-source`} value={t.source} maxLength={200} onChange={(e) => set("source")(e.target.value)} className={inputClass} /></div>
    </>
  );
}

const termsBody = (t: Terms) => ({
  payer: t.payer.trim(), authorizationNumber: t.number.trim() || null, monthlyAuthorizedMinutes: hoursToMinutes(t.hours),
  periodStart: t.start, periodEnd: t.end, receivedDate: t.received || null, sourceReference: t.source.trim() || null,
});

function AddAuthorizationForm({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const api = useAwsApi();
  const refresh = useRefreshClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const services = useServices();
  const canRate = hasPermission("authorizations.rates.manage");
  const [service, setService] = useState("");
  const [rate, setRate] = useState("");
  const [t, setT] = useState<Terms>(emptyTerms);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const set = (k: keyof Terms) => (v: string) => { setT((x) => ({ ...x, [k]: v })); key.current = newIdempotencyKey(); };
  async function submit() {
    const err = !service ? "Choose the service." : termsError(t);
    const cents = canRate ? dollarsToCents(rate) : null;
    if (err) return setState({ busy: false, error: err });
    if (cents !== null && Number.isNaN(cents)) return setState({ busy: false, error: "Enter the rate in dollars per hour, for example 25.50 (up to $1,000)." });
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/clients/${encodeURIComponent(clientId)}/authorizations`, {
        organizationId: activeOrganizationId, serviceId: service, ...termsBody(t), ...(cents !== null ? { hourlyRateCents: cents } : {}),
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null });
      onDone();
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The authorization was not added.") });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label htmlFor="auth-service" className="block text-sm font-medium text-slate-700">Service</label>
        <select id="auth-service" value={service} onChange={(e) => { setService(e.target.value); key.current = newIdempotencyKey(); }} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
          <option value="">Choose a service</option>
          {(services.data ?? []).filter((s) => s.isActive).map((s) => <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.code})</option>)}
        </select>
      </div>
      <TermsFields t={t} set={set} idPrefix="auth" />
      {canRate ? (
        <div>
          <label htmlFor="auth-rate" className="block text-sm font-medium text-slate-700">Billing rate per hour (optional, Administrator only)</label>
          <input id="auth-rate" inputMode="decimal" value={rate} onChange={(e) => { setRate(e.target.value); key.current = newIdempotencyKey(); }} placeholder="25.50" className={inputClass} />
        </div>
      ) : null}
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      <div className="sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Adding…" : "Add authorization"}</Button></div>
    </form>
  );
}

interface AmendResult { newVersionNumber: number; affectedVisits: Array<{ visitId: string; status: string; serviceDate: string; workedMinutes: number; billableMinutes: number; impact: string }>; affectedShifts?: Array<{ impactId: string; shiftId: string; serviceDate: string; reservedMinutes: number; impact: string }> }

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

function AmendForm({ current, onDone, renewal = false }: { current: AuthorizationVersion; onDone: (r: AmendResult) => void; renewal?: boolean }) {
  const api = useAwsApi();
  const refresh = useRefreshClient();
  const [t, setT] = useState<Terms>({
    payer: current.payer, number: current.authorizationNumber ?? "", hours: minutesAsHours(current.monthlyAuthorizedMinutes),
    start: renewal ? addDays(current.periodEnd, 1) : current.periodStart, end: renewal ? addDays(current.periodEnd, 365) : current.periodEnd, received: renewal ? "" : (current.receivedDate ?? ""), source: renewal ? "" : (current.sourceReference ?? ""),
  });
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const set = (k: keyof Terms) => (v: string) => { setT((x) => ({ ...x, [k]: v })); key.current = newIdempotencyKey(); };
  const idp = `amend-${current.authorizationId.slice(0, 8)}`;
  async function submit() {
    const err = termsError(t) ?? (reason.trim().length < 3 ? "Give the reason for the amendment." : null);
    if (err) return setState({ busy: false, error: err });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<AmendResult>(`/v1/authorizations/${encodeURIComponent(current.authorizationId)}/amend`, { ...termsBody(t), reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null });
      onDone(r);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The amendment was not saved.") });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
      {renewal ? <p data-testid="renewal-steps" className="text-sm text-slate-700 sm:col-span-2"><strong>Renewal.</strong> Step 1: enter the new terms (the dates start the day after this authorization ends). Step 2: after you save, review every reserved shift and visit it affects on Authorization changes. Nothing that was held or scheduled is restored or released automatically; a person decides each one.</p> : null}
      <p className="text-sm text-slate-700 sm:col-span-2">Saves version {current.versionNumber + 1}; version {current.versionNumber} stays in the history. Visits already billed are not changed.</p>
      <TermsFields t={t} set={set} idPrefix={idp} />
      <div className="sm:col-span-2"><label htmlFor={`${idp}-reason`} className="block text-sm font-medium text-slate-700">Reason for the amendment</label><input id={`${idp}-reason`} value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      <div className="sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : `Save version ${current.versionNumber + 1}`}</Button></div>
    </form>
  );
}

const IMPACT_LABEL: Record<string, string> = {
  increase_may_allow_more: "was over the old limit; may now be within it (review it)",
  decrease_now_exceeds: "may now exceed the new limit (review it)",
};

function LineageCard({ versions, canUpdate, showRate }: { versions: AuthorizationVersion[]; canUpdate: boolean; showRate: boolean }) {
  const head = versions[0]!;
  const [amending, setAmending] = useState<false | "amend" | "renew">(false);
  const [result, setResult] = useState<AmendResult | null>(null);
  const todayIso = new Date().toISOString().slice(0, 10);
  const expired = head.periodEnd < todayIso;
  const endingSoon = !expired && head.periodEnd <= addDays(todayIso, 30);
  return (
    <li className="rounded-lg border border-slate-200 bg-og-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="font-semibold text-slate-950">{head.serviceName} <span className="font-normal text-slate-500">({head.serviceCode})</span></p>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${expired ? "bg-slate-200 text-slate-800" : "bg-emerald-100 text-emerald-900"}`}>{expired ? "Ended" : "Current"} · version {head.versionNumber}</span>
        <span className="flex-1" />
        {canUpdate && head.isCurrent && !amending ? <button type="button" className={`${actionBtn} md:min-h-7 md:py-0`} onClick={() => { setAmending("amend"); setResult(null); }}>Amend</button> : null}
        {canUpdate && head.isCurrent && !amending && (expired || endingSoon) ? <button type="button" data-testid="renew-authorization" className={`${actionBtnPrimary} md:min-h-7 md:py-0`} onClick={() => { setAmending("renew"); setResult(null); }}>Renew</button> : null}
      </div>
      <p className="text-sm text-slate-800">{formatDuration(head.monthlyAuthorizedMinutes)} per month · {fmtDate(head.periodStart)} to {fmtDate(head.periodEnd)} <span className="text-slate-600">· {head.payer}{head.authorizationNumber ? ` · No. ${head.authorizationNumber}` : ""}{showRate && head.hourlyRateCents !== null ? ` · ${formatRate(head.hourlyRateCents)}` : ""}</span></p>
      {head.versionNumber > 1 && head.changeReason ? <p className="text-xs text-slate-500">Latest change: {head.changeReason}{head.createdByName ? ` (${head.createdByName})` : ""}</p> : null}
      {amending ? <AmendForm current={head} renewal={amending === "renew"} onDone={(r) => { setAmending(false); setResult(r); }} /> : null}
      {result ? (
        <div role="status" className="mt-2 rounded-lg bg-emerald-50 p-2 text-sm text-emerald-900">
          Saved as version {result.newVersionNumber}.{" "}
          {(result.affectedShifts?.length ?? 0) > 0 ? (
            <span data-testid="amend-affected-shifts" className="block">
              {result.affectedShifts!.length} reserved shift{result.affectedShifts!.length === 1 ? "" : "s"} no longer fit the new terms ({result.affectedShifts!.map((x) => `${fmtDate(x.serviceDate)} · ${formatDuration(x.reservedMinutes)}${x.impact === "reserved_shift_outside_period" ? " (outside the period)" : ""}`).join("; ")}).
              Nothing was cancelled or released. <Link className="underline" to="/authorization-impacts">Review and acknowledge</Link>.
            </span>
          ) : null}
          {result.affectedVisits.length === 0 ? "No existing visits need review." : (
            <>
              {result.affectedVisits.length} visit{result.affectedVisits.length === 1 ? "" : "s"} to review:
              <ul className="mt-1 list-disc pl-5">{result.affectedVisits.map((v) => <li key={v.visitId}>{fmtDate(v.serviceDate)}: {formatDuration(v.workedMinutes)} worked, {IMPACT_LABEL[v.impact] ?? v.impact}</li>)}</ul>
            </>
          )}
        </div>
      ) : null}
      {versions.length > 1 ? (
        <details className="mt-2">
          <summary className="inline-flex min-h-6 cursor-pointer items-center [@media(pointer:coarse)]:min-h-[44px] text-sm text-slate-700">History ({versions.length - 1} earlier version{versions.length === 2 ? "" : "s"})</summary>
          <ul className="mt-1 space-y-1">
            {versions.slice(1).map((v) => (
              <li key={v.authorizationId} className="text-sm text-slate-600">
                Version {v.versionNumber}: {formatDuration(v.monthlyAuthorizedMinutes)} per month, {fmtDate(v.periodStart)} to {fmtDate(v.periodEnd)}
                {v.changeReason ? ` · ${v.changeReason}` : ""}{v.createdByName ? ` · ${v.createdByName}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function AuthorizationsCard({ clientId }: { clientId: string }) {
  const { hasPermission } = useOrganization();
  const canUpdate = hasPermission("authorizations.update");
  const showRate = hasPermission("billing.read");
  const versions = useClientAuthorizations(clientId);
  const { tz } = useAgencyClock();
  const [month, setMonth] = useState(() => agencyMonth(tz));
  const balances = useMonthlyBalances(clientId, `${month}-01`);
  const [adding, setAdding] = useState(false);
  const lineages = groupByLineage(versions.data ?? []);
  const rows = balances.data ?? [];
  // 0079: Hours left is per authorization and signed (negative = Over limit); the server's figure, with the older field as the fallback.
  const leftOf = (b: (typeof rows)[number]) => b.hoursLeftMinutes ?? b.remainingMinutes;
  const worst = rows.some((b) => b.authorizationTier === "critical" || leftOf(b) < 0) ? "critical" : rows.some((b) => b.authorizationTier === "near_limit") ? "near_limit" : null;
  const none = versions.data !== undefined && lineages.length === 0;
  const attention = none || worst !== null || rows.some((b) => b.expiringSoon);
  const left = (b: (typeof rows)[number]) => hoursLeftLine(leftOf(b)).text;
  return (
    <SummarySection title="Authorizations" defaultOpen hideSummaryWhenOpen
      status={none ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">None</span> : worst ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${worst === "critical" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"}`}>{worst === "critical" ? "Critical" : "Near limit"}</span> : rows.length > 0 && attention ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">Ending soon</span> : undefined}
      summary={rows.length > 0 ? rows.map((b) => `${b.serviceName}: ${left(b)}`).join(" · ") : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label htmlFor="balance-month" className="text-sm font-medium text-slate-700">Hours for month</label>
          <input id="balance-month" type="month" value={month} onChange={(e) => setMonth(e.target.value || agencyMonth(tz))} className="rounded-lg border border-slate-200 px-2 py-1 text-sm md:min-h-8" />
        </div>
        {canUpdate ? <Button type="button" variant="secondary" className="md:min-h-8 md:py-0" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close" : "Add authorization"}</Button> : null}
      </div>
      {adding ? <AddAuthorizationForm clientId={clientId} onDone={() => setAdding(false)} /> : null}
      {balances.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{(balances.error as Error).message}</p> : null}
      {balances.data && balances.data.length === 0 ? <p className="mt-2 text-sm text-slate-600">No authorization covers this month.</p> : null}
      {balances.data && balances.data.length > 0 ? (
        <div className="mt-1.5">
          <ul className="space-y-1" aria-label="Authorized, used and remaining time for the month">
            {balances.data.map((b) => (
              <li key={b.authorizationLineageId} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 rounded-lg border border-slate-200 px-3 py-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <p className="text-sm font-semibold text-slate-900">{b.serviceName}</p>
                  {b.authorizationTier ? (
                    <span data-testid="authorization-tier" className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${b.authorizationTier === "critical" ? "bg-red-100 text-red-800" : b.authorizationTier === "near_limit" ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-900"}`}>
                      <span aria-hidden="true">{TIER_SYMBOL[b.authorizationTier]}</span>
                      {TIER_LABEL[b.authorizationTier]}
                    </span>
                  ) : null}
                  {b.expiringSoon ? (
                    <span data-testid="authorization-expiry" className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                      <span aria-hidden="true">▲</span>Ends in {b.daysUntilExpiry} {b.daysUntilExpiry === 1 ? "day" : "days"}
                    </span>
                  ) : null}
                </div>
                <p className="flex flex-wrap gap-x-4 gap-y-0 text-sm">
                  <span>Authorized: {formatHours(b.authorizedMinutes)}</span>
                  <span data-testid="hours-left-figure" className={`font-semibold ${leftOf(b) <= 0 ? "text-red-700" : "text-slate-900"}`}>{hoursLeftLine(leftOf(b)).label}: {hoursLeftLine(leftOf(b)).value}</span>
                </p>
                <div className="ml-auto"><HoursBreakdown row={b} /></div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {versions.isLoading ? <p className="mt-3 text-sm text-slate-500">Loading…</p> : null}
      {versions.isError ? <p role="alert" className="mt-3 text-sm text-red-700">{(versions.error as Error).message}</p> : null}
      {none ? <CompactAlert tone="danger" className="mt-2" summary="No authorization yet">Visits cannot be scheduled or verified until one is added.</CompactAlert> : null}
      <ul className="mt-3 space-y-2">
        {lineages.map((l) => <LineageCard key={l[0]!.lineageId} versions={l} canUpdate={canUpdate} showRate={showRate} />)}
      </ul>
    </SummarySection>
  );
}

/** One client: details, status and authorized hours (0022). */
export function ClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const { hasPermission } = useOrganization();
  const clients = useClients();
  if (!hasPermission("clients.names.read")) return <p className="text-sm text-slate-600">You do not have access to client records.</p>;
  if (clients.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (clients.isError) return <p role="alert" className="text-sm text-red-700">{(clients.error as Error).message}</p>;
  const c = clients.data?.find((x) => x.clientId === clientId);
  if (!c) return <p className="text-sm text-slate-600">Client not found. <Link to="/clients" className="underline">Back to clients</Link></p>;
  const canManage = hasPermission("clients.manage") && hasPermission("clients.names.manage");
  return (
    <div className="max-w-4xl space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to="/clients" className={linkClass}>← All clients</Link>
        <h1 className="text-xl font-bold text-slate-950">{clientName(c) ?? "Name not set"}</h1>
        {c.duplicateName ? <span className="text-sm text-slate-500" data-testid="client-code-shared-name">{c.clientCode}</span> : null}
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
        <span className="flex-1" />
        {hasPermission("care_requests.read") ? <Link to="/schedule/shift-requests" className={linkClass}>Care requests</Link> : null}
        <ClientQuickActions clientId={c.clientId} canEdit={canManage} />
      </div>
      <ClientAlertsCard clientId={c.clientId} />
      <div id="authorizations"><AuthorizationsCard clientId={c.clientId} /></div>
      <NextVisitsCard clientId={c.clientId} />
      <CaregiverSummary clientId={c.clientId}><AssignmentsCard clientId={c.clientId} /></CaregiverSummary>
      <div id="readiness"><ReadinessCard clientId={c.clientId} /></div>
      <div id="documents"><ClientDocumentsCard clientId={c.clientId} /></div>
      <DetailsCard c={c} canManage={canManage} />
      {hasPermission("matching.read") ? <ClientExperience clientId={c.clientId} /> : null}
      {hasPermission("matching.manage") ? <MatchingLocation clientId={c.clientId} /> : null}
      {canManage ? <><StatusCard c={c} /><ClientQrCard key={c.clientId} clientId={c.clientId} /></> : null}
      <div id="history"><ClientHistoryCard clientId={c.clientId} /></div>
    </div>
  );
}
