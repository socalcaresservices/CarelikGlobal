import { useQuery, useQueryClient } from "@tanstack/react-query";
import { nameWithCode } from "./name-label";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { caregiverName, useCaregivers } from "./care-team-admin";
import { clientName, useClients, useServices } from "./client-admin";
import { outageNumber } from "./continuity-pack";
import { formatDateOnly } from "@/lib/service-verification";
import { Hint } from "./hint";


/**
 * Outage visit records (0028): after an outage, the office enters each numbered
 * paper record once. The server refuses a number used before, a number not
 * issued to this agency, and any overlap with another visit; the visit lands in
 * administrator review with 0 billable minutes. Reconciliation shows every
 * issued number that is still MISSING.
 */
interface OutageRow {
  outageNumber: number; issuedAt: string; state: "entered" | "not_used" | "missing"; visitId: string | null; visitNumber: string | null;
  clientCode: string | null; caregiverName: string | null; serviceDate: string | null; workedMinutes: number | null;
  visitStatus: string | null; authorizationStatus: string | null; paperConfirmation: string | null; reasonNotUsed: string | null;
}
const CONFIRMATION = [
  { value: "signature_on_form", label: "Signed on the form" },
  { value: "verbal", label: "Verbal confirmation noted" },
  { value: "unable_to_confirm", label: "No confirmation" },
  { value: "declined", label: "Client declined" },
] as const;
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const parseNumber = (v: string) => { const n = Number(v.trim().replace(/^OUT-/i, "")); return Number.isInteger(n) && n > 0 ? n : null; };

function useReconciliation() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-outage-reconciliation", activeOrganizationId],
    enabled: Boolean(activeOrganizationId) && hasPermission("visits.manage"),
    queryFn: async () => (await api.get<{ records: OutageRow[] }>("/v1/outage-visits/reconciliation", { organizationId: activeOrganizationId })).records,
  });
}

function EntryForm({ onDone }: { onDone: (text: string) => void }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const clients = useClients();
  const services = useServices();
  const caregivers = useCaregivers();
  const [f, setF] = useState({ number: "", clientId: "", serviceId: "", caregiverRecordId: "", date: "", timeIn: "", timeOut: "", conf: "", signer: "", notes: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); key.current = newIdempotencyKey(); };
  async function submit() {
    const n = parseNumber(f.number);
    if (!n) return setState({ busy: false, error: "Enter the record number printed on the form (for example OUT-000012)." });
    if (!f.clientId || !f.serviceId || !f.caregiverRecordId) return setState({ busy: false, error: "Choose the client, service and caregiver written on the form." });
    if (!f.date || !f.timeIn || !f.timeOut) return setState({ busy: false, error: "Enter the date, Time In and Time Out written on the form." });
    if (!f.conf) return setState({ busy: false, error: "Choose what the form shows for the client's confirmation." });
    if ((f.conf === "signature_on_form" || f.conf === "verbal") && !f.signer.trim()) return setState({ busy: false, error: "Enter the name of the person who signed or confirmed." });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ visit: { visitNumber: string; workedMinutes: number; authorizationStatus: string } }>("/v1/outage-visits", {
        organizationId: activeOrganizationId, outageNumber: n, clientId: f.clientId, serviceId: f.serviceId, caregiverRecordId: f.caregiverRecordId,
        date: f.date, timeIn: f.timeIn, timeOut: f.timeOut, paperConfirmation: f.conf, signerName: f.signer.trim() || null, notes: f.notes.trim() || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setF({ number: "", clientId: "", serviceId: "", caregiverRecordId: "", date: f.date, timeIn: "", timeOut: "", conf: "", signer: "", notes: "" });
      await qc.invalidateQueries({ queryKey: ["aws-outage-reconciliation"] });
      setState({ busy: false, error: null });
      onDone(`${outageNumber(n)} entered as visit ${r.visit.visitNumber} (${r.visit.workedMinutes} min). It is in administrator review with 0 billable minutes${r.visit.authorizationStatus === "exceeds_authorization" ? " and EXCEEDS the authorization" : ""}.`);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The record was not entered.") });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="grid gap-3 sm:grid-cols-2">
      <div><label htmlFor="ov-number" className="block text-sm font-medium text-slate-700">Record number</label>
        <input id="ov-number" inputMode="numeric" placeholder="OUT-000012" value={f.number} onChange={(e) => set("number", e.target.value)} className={inputClass} /></div>
      <div><label htmlFor="ov-date" className="block text-sm font-medium text-slate-700">Date of the visit</label>
        <input id="ov-date" type="date" value={f.date} onChange={(e) => set("date", e.target.value)} className={inputClass} /></div>
      <div><label htmlFor="ov-client" className="block text-sm font-medium text-slate-700">Client</label>
        <select id="ov-client" value={f.clientId} onChange={(e) => set("clientId", e.target.value)} className={inputClass}>
          <option value="">Choose a client</option>
          {(clients.data ?? []).map((c) => <option key={c.clientId} value={c.clientId}>{nameWithCode(clientName(c), c.clientCode, c.duplicateName)}</option>)}
        </select></div>
      <div><label htmlFor="ov-service" className="block text-sm font-medium text-slate-700">Service</label>
        <select id="ov-service" value={f.serviceId} onChange={(e) => set("serviceId", e.target.value)} className={inputClass}>
          <option value="">Choose a service</option>
          {(services.data ?? []).map((s) => <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.code})</option>)}
        </select></div>
      <div className="sm:col-span-2"><label htmlFor="ov-caregiver" className="block text-sm font-medium text-slate-700">Caregiver</label>
        <select id="ov-caregiver" value={f.caregiverRecordId} onChange={(e) => set("caregiverRecordId", e.target.value)} className={inputClass}>
          <option value="">Choose the caregiver</option>
          {(caregivers.data ?? []).map((c) => <option key={c.caregiverRecordId} value={c.caregiverRecordId}>{nameWithCode(caregiverName(c), c.caregiverCode, c.duplicateName)}</option>)}
        </select></div>
      <div><label htmlFor="ov-in" className="block text-sm font-medium text-slate-700">Time In (as written)</label>
        <input id="ov-in" type="time" value={f.timeIn} onChange={(e) => set("timeIn", e.target.value)} className={inputClass} /></div>
      <div><label htmlFor="ov-out" className="block text-sm font-medium text-slate-700">Time Out (as written)</label>
        <input id="ov-out" type="time" value={f.timeOut} onChange={(e) => set("timeOut", e.target.value)} className={inputClass} /></div>
      <fieldset className="sm:col-span-2"><legend className="text-sm font-medium text-slate-700">Client confirmation on the form</legend>
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          {CONFIRMATION.map((o) => (
            <label key={o.value} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3">
              <input type="radio" name="ov-conf" value={o.value} checked={f.conf === o.value} onChange={() => set("conf", o.value)} />{o.label}
            </label>
          ))}
        </div></fieldset>
      <div><label htmlFor="ov-signer" className="block text-sm font-medium text-slate-700">Name of the person who signed or confirmed</label>
        <input id="ov-signer" value={f.signer} onChange={(e) => set("signer", e.target.value)} className={inputClass} /></div>
      <div><label htmlFor="ov-notes" className="block text-sm font-medium text-slate-700">Notes (optional)</label>
        <input id="ov-notes" value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inputClass} /></div>
      <Hint details="A Time Out earlier than the Time In means the next day. The visit is stored as written on the form, marked as entered by you, in administrator review with 0 billable minutes." className="sm:col-span-2">Enter times in the agency's local time. Review the paper form before any billing.</Hint>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      <div className="sm:col-span-2"><Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={state.busy}>{state.busy ? "Entering…" : "Enter outage record"}</Button></div>
    </form>
  );
}

function NotUsedForm({ onDone }: { onDone: (text: string) => void }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [num, setNum] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  async function submit() {
    const n = parseNumber(num);
    if (!n || !reason.trim()) return setState({ busy: false, error: "Enter the record number and why it was not used." });
    setState({ busy: true, error: null });
    try {
      await api.post("/v1/outage-visits/not-used", { organizationId: activeOrganizationId, outageNumber: n, reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setNum(""); setReason("");
      await qc.invalidateQueries({ queryKey: ["aws-outage-reconciliation"] });
      setState({ busy: false, error: null });
      onDone(`${outageNumber(n)} closed as not used. It can never be entered later.`);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The number was not closed.") });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="grid gap-3 sm:grid-cols-3">
      <div><label htmlFor="nu-number" className="block text-sm font-medium text-slate-700">Unused record number</label>
        <input id="nu-number" value={num} onChange={(e) => { setNum(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      <div className="sm:col-span-2"><label htmlFor="nu-reason" className="block text-sm font-medium text-slate-700">Why it was not used</label>
        <input id="nu-reason" value={reason} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-3">{state.error}</p> : null}
      <div className="sm:col-span-3"><Button type="submit" disabled={state.busy}>Close number as not used</Button></div>
    </form>
  );
}

export function OutageVisitsPage() {
  const { hasPermission } = useOrganization();
  const recon = useReconciliation();
  const [done, setDone] = useState<string | null>(null);
  if (!hasPermission("visits.manage")) {
    return <Card className="p-3"><p className="text-sm">Only a visit manager can enter outage visit records.</p></Card>;
  }
  const rows = recon.data ?? [];
  const missing = rows.filter((r) => r.state === "missing");
  const entered = rows.filter((r) => r.state === "entered");
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Outage records</h1>
      <p className="text-sm text-slate-700">Enter each paper outage record once, after Ogevia is back. <Link to="/continuity" className="underline">Continuity pack</Link></p>
      {done ? <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">{done}</p> : null}
      <Card className="p-3">
        <h2 className="text-base font-semibold">Reconciliation</h2>
        {recon.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {recon.isError ? <p role="alert" className="text-sm text-red-700">Reconciliation could not be loaded.</p> : null}
        {recon.data ? (
          <>
            <p className={`mt-1 text-sm ${missing.length ? "font-bold text-amber-900" : "text-slate-700"}`}>
              {rows.length} numbers issued · {entered.length} entered · {rows.filter((r) => r.state === "not_used").length} not used · {missing.length} MISSING (not yet entered or closed)
            </p>
            {entered.length ? (
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {entered.map((r) => (
                  <li key={r.outageNumber} className="py-2">
                    <span className="font-mono">{outageNumber(r.outageNumber)}</span> → visit {r.visitNumber} · {formatDateOnly(r.serviceDate)} · {r.workedMinutes} min · {r.caregiverName}
                    {r.authorizationStatus === "exceeds_authorization" ? <span className="ml-1 font-bold text-red-700">EXCEEDS AUTHORIZATION</span> : null}
                    <span className="ml-1 text-slate-500">({r.visitStatus === "administrator_review" ? "needs review" : r.visitStatus})</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <details className="mt-2 text-sm"><summary className="inline-flex min-h-6 cursor-pointer items-center [@media(pointer:coarse)]:min-h-[44px]">Show the missing numbers</summary>
              <p className="mt-1 font-mono text-xs leading-6">{missing.map((r) => outageNumber(r.outageNumber)).join(" · ") || "None"}</p>
            </details>
          </>
        ) : null}
      </Card>
      <Card className="p-3"><h2 className="mb-2 text-base font-semibold">Enter a record</h2><EntryForm onDone={setDone} /></Card>
      <details className="rounded-xl border border-slate-200 bg-og-card p-3">
        <summary className="min-h-[44px] md:min-h-[32px] cursor-pointer text-base font-semibold">Close a number that was not used</summary>
        <div className="mt-2"><NotUsedForm onDone={setDone} /></div>
      </details>
    </div>
  );
}
