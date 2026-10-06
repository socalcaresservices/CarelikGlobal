import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { formatDuration } from "@/lib/service-verification";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import {
  clientName, dollarsToCents, formatRate, groupByLineage, hoursToMinutes, STATUS_BADGE, STATUS_LABEL,
  useClientAuthorizations, useClients, useMonthlyBalances, useServices,
  type AdminClient, type AuthorizationVersion, type ClientStatus,
} from "./client-admin";
import { AssignmentsCard } from "./assignments-card";
import { ClientTypeField } from "./clients-page";
import { formatDateOnly } from "@/lib/service-verification";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const fmtDate = (d: string | null) => formatDateOnly(d);
const minutesAsHours = (m: number) => (m % 60 === 0 ? String(m / 60) : (m / 60).toFixed(2));
const thisMonth = () => new Date().toISOString().slice(0, 7);

function useRefreshClient() {
  const queryClient = useQueryClient();
  return async () => {
    for (const k of ["aws-clients", "aws-client-directory", "aws-client-authorizations", "aws-client-balances", "service-visit-report", "service-visit-report-calendar"]) {
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
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  useEffect(() => setForm({ first: c.legalFirstName ?? "", last: c.legalLastName ?? "", city: c.city ?? "", type: c.clientTypeId ?? "", label: c.caregiverDisplayCode ?? "" }),
    [c.legalFirstName, c.legalLastName, c.city, c.clientTypeId, c.caregiverDisplayCode]);
  const set = (k: keyof typeof form) => (v: string) => { setForm((f) => ({ ...f, [k]: v })); key.current = newIdempotencyKey(); setState((s) => ({ ...s, done: false })); };
  async function save() {
    if (!form.first.trim() || !form.last.trim()) return setState({ busy: false, error: "Enter the client's first and last name.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/clients/${encodeURIComponent(c.clientId)}/details`, {
        organizationId: activeOrganizationId, firstName: form.first.trim(), lastName: form.last.trim(),
        city: form.city.trim() || null, clientTypeId: form.type || null, caregiverLabel: form.label.trim() || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved."), done: false });
    }
  }
  if (!canManage) {
    return (
      <Card className="p-4 text-sm text-slate-700">
        <p>City: {c.city ?? "—"} · Type: {c.clientTypeName ?? "—"} · Caregivers see: {c.caregiverDisplayCode ?? c.clientCode}</p>
      </Card>
    );
  }
  return (
    <Card className="p-4">
      <h2 className="text-base font-semibold text-slate-950">Details</h2>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-3 grid gap-3 sm:grid-cols-2">
        <div><label htmlFor="edit-first" className="block text-sm font-medium text-slate-700">First name</label><input id="edit-first" value={form.first} maxLength={80} autoComplete="off" onChange={(e) => set("first")(e.target.value)} className={inputClass} /></div>
        <div><label htmlFor="edit-last" className="block text-sm font-medium text-slate-700">Last name</label><input id="edit-last" value={form.last} maxLength={80} autoComplete="off" onChange={(e) => set("last")(e.target.value)} className={inputClass} /></div>
        <div><label htmlFor="edit-city" className="block text-sm font-medium text-slate-700">City (optional)</label><input id="edit-city" value={form.city} maxLength={80} autoComplete="off" onChange={(e) => set("city")(e.target.value)} className={inputClass} /></div>
        <ClientTypeField id="edit-type" value={form.type} onChange={set("type")} />
        <div className="sm:col-span-2"><label htmlFor="edit-label" className="block text-sm font-medium text-slate-700">Label caregivers see instead of {c.clientCode} (optional)</label><input id="edit-label" value={form.label} maxLength={40} autoComplete="off" onChange={(e) => set("label")(e.target.value)} className={inputClass} /></div>
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
        {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">Saved. The change is in the client's history.</p> : null}
        <div className="sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save details"}</Button></div>
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
  return (
    <Card className="p-4">
      <h2 className="text-base font-semibold text-slate-950">Status</h2>
      <p className="mt-1 text-sm text-slate-600">Inactive and discharged clients cannot be scheduled or visited. Their records and history are kept.</p>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="status-new" className="block text-sm font-medium text-slate-700">Change to</label>
          <select id="status-new" value={status} onChange={(e) => { setStatus(e.target.value as ClientStatus); key.current = newIdempotencyKey(); }} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
            {(["active", "inactive", "discharged"] as const).filter((s) => s !== c.status).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="min-w-[220px] flex-1">
          <label htmlFor="status-reason" className="block text-sm font-medium text-slate-700">Reason</label>
          <input id="status-reason" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} />
        </div>
        <Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Change status"}</Button>
      </form>
      {state.error ? <p role="alert" className="mt-2 text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="mt-2 text-sm text-emerald-800">Status changed.</p> : null}
    </Card>
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

interface AmendResult { newVersionNumber: number; affectedVisits: Array<{ visitId: string; status: string; serviceDate: string; workedMinutes: number; billableMinutes: number; impact: string }> }

function AmendForm({ current, onDone }: { current: AuthorizationVersion; onDone: (r: AmendResult) => void }) {
  const api = useAwsApi();
  const refresh = useRefreshClient();
  const [t, setT] = useState<Terms>({
    payer: current.payer, number: current.authorizationNumber ?? "", hours: minutesAsHours(current.monthlyAuthorizedMinutes),
    start: current.periodStart, end: current.periodEnd, received: current.receivedDate ?? "", source: current.sourceReference ?? "",
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
      <p className="text-sm text-slate-700 sm:col-span-2">An amendment creates version {current.versionNumber + 1}. Version {current.versionNumber} is kept unchanged in the history. Visits already billed are not changed automatically.</p>
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
  const [amending, setAmending] = useState(false);
  const [result, setResult] = useState<AmendResult | null>(null);
  const expired = head.periodEnd < new Date().toISOString().slice(0, 10);
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-950">{head.serviceName} <span className="font-normal text-slate-500">({head.serviceCode})</span></p>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${expired ? "bg-slate-200 text-slate-800" : "bg-emerald-100 text-emerald-900"}`}>{expired ? "Ended" : "Current"} · version {head.versionNumber}</span>
      </div>
      <p className="mt-1 text-sm text-slate-800">{formatDuration(head.monthlyAuthorizedMinutes)} per month · {fmtDate(head.periodStart)} to {fmtDate(head.periodEnd)}</p>
      <p className="text-sm text-slate-600">{head.payer}{head.authorizationNumber ? ` · No. ${head.authorizationNumber}` : ""}{showRate && head.hourlyRateCents !== null ? ` · ${formatRate(head.hourlyRateCents)}` : ""}</p>
      {head.versionNumber > 1 && head.changeReason ? <p className="text-xs text-slate-500">Latest change: {head.changeReason}{head.createdByName ? ` (${head.createdByName})` : ""}</p> : null}
      {canUpdate && head.isCurrent && !amending ? <button type="button" className="mt-2 text-sm font-medium text-slate-800 underline" onClick={() => { setAmending(true); setResult(null); }}>Amend</button> : null}
      {amending ? <AmendForm current={head} onDone={(r) => { setAmending(false); setResult(r); }} /> : null}
      {result ? (
        <div role="status" className="mt-2 rounded-lg bg-emerald-50 p-2 text-sm text-emerald-900">
          Saved as version {result.newVersionNumber}.{" "}
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
          <summary className="cursor-pointer text-sm text-slate-700">History ({versions.length - 1} earlier version{versions.length === 2 ? "" : "s"})</summary>
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
  const [month, setMonth] = useState(thisMonth());
  const balances = useMonthlyBalances(clientId, `${month}-01`);
  const [adding, setAdding] = useState(false);
  const lineages = groupByLineage(versions.data ?? []);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-950">Authorized hours</h2>
        {canUpdate ? <Button type="button" variant="secondary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close" : "Add authorization"}</Button> : null}
      </div>
      {adding ? <AddAuthorizationForm clientId={clientId} onDone={() => setAdding(false)} /> : null}
      <div className="mt-3">
        <label htmlFor="balance-month" className="block text-sm font-medium text-slate-700">Balance for month</label>
        <input id="balance-month" type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base" />
      </div>
      {balances.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{(balances.error as Error).message}</p> : null}
      {balances.data && balances.data.length === 0 ? <p className="mt-2 text-sm text-slate-600">No authorization covers this month.</p> : null}
      {balances.data && balances.data.length > 0 ? (
        <div className="mt-2">
          <ul className="space-y-2" aria-label="Authorized, used and remaining time for the month">
            {balances.data.map((b) => (
              <li key={b.authorizationLineageId} className="rounded-lg border border-slate-200 p-3">
                <p className="text-sm font-semibold text-slate-900">{b.serviceName}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                  <div><dt className="text-xs text-slate-600">Authorized</dt><dd>{formatDuration(b.authorizedMinutes)}</dd></div>
                  <div><dt className="text-xs text-slate-600">Billable</dt><dd>{formatDuration(b.billableMinutes)}</dd></div>
                  <div><dt className="text-xs text-slate-600">In review</dt><dd>{formatDuration(b.reviewMinutes)}</dd></div>
                  <div><dt className="text-xs text-slate-600">Hours left</dt><dd className={`font-semibold ${b.remainingMinutes <= 0 ? "text-red-700" : "text-slate-900"}`}>{formatDuration(b.remainingMinutes)}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-slate-500">Hours left = authorized − billable − time already scheduled (same calculation as the reports).</p>
        </div>
      ) : null}
      {versions.isLoading ? <p className="mt-3 text-sm text-slate-500">Loading…</p> : null}
      {versions.isError ? <p role="alert" className="mt-3 text-sm text-red-700">{(versions.error as Error).message}</p> : null}
      {versions.data && lineages.length === 0 ? <p className="mt-3 text-sm font-semibold text-red-700">No authorization yet. Visits cannot be scheduled or verified for this client until one is added.</p> : null}
      <ul className="mt-3 space-y-2">
        {lineages.map((l) => <LineageCard key={l[0]!.lineageId} versions={l} canUpdate={canUpdate} showRate={showRate} />)}
      </ul>
    </Card>
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
    <div className="max-w-4xl space-y-4">
      <Link to="/clients" className="text-sm text-slate-700 underline">← All clients</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-950">{clientName(c) ?? "Name not set"}</h1>
        <span className="text-sm text-slate-500">{c.clientCode}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
      </div>
      <AuthorizationsCard clientId={c.clientId} />
      <AssignmentsCard clientId={c.clientId} />
      <DetailsCard c={c} canManage={canManage} />
      {canManage ? <StatusCard c={c} /> : null}
    </div>
  );
}
