import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useServices } from "./client-admin";

/**
 * Billing rounding (0029). Default: no rounding. The Administrator records a
 * payer's rule as a dated policy version per payer and service; the server
 * computes each adjustment from approved visit minutes and the policy in effect
 * on the service date, never past the authorization, and a billing approver
 * approves it as a separate line. Clock times, worked minutes (payroll) and
 * confirmed billable minutes are never changed here.
 */
interface Policy {
  policyId: string; payer: string; serviceId: string; serviceName: string; version: number; method: Method; incrementMinutes: number | null;
  basis: Basis | null; payerRuleReference: string | null; payerRuleDate: string | null; effectiveFrom: string; reason: string;
  createdByName: string; createdAt: string; inEffectToday: boolean;
}
type Method = "none" | "nearest" | "up" | "down";
type Basis = "per_visit" | "daily_total";
interface Unit {
  unitKind: "visit" | "day"; unitKey: string; visitId: string | null; visitNumber: string | null; visitCount: number; authorizationLineageId: string;
  clientCode: string; serviceName: string; payer: string; serviceDate: string; workedMinutes: number; billableMinutes: number;
  approvedMinutes: number | null; allApproved: boolean; policyVersion: number | null; method: Method; incrementMinutes: number | null; basis: Basis | null;
  proposedMinutes: number; adjustmentMinutes: number; proposedUnits: string | null; cappedByAuthorization: boolean;
  adjustmentId: string | null; adjustedBaseMinutes: number | null; adjustedProposedMinutes: number | null; adjustedMinutes: number | null;
  adjustedPolicyVersion: number | null; state: State;
}
type State = "no_rounding" | "awaiting_visit_approval" | "day_has_open_visits" | "no_adjustment" | "ready_to_approve" | "approved" | "approved_under_earlier_policy";

const METHOD_LABEL: Record<Method, string> = { none: "No rounding", nearest: "Nearest increment", up: "Round up", down: "Round down" };
const BASIS_LABEL: Record<Basis, string> = { per_visit: "Each visit", daily_total: "Daily total (client, service, day)" };
const STATE_LABEL: Record<State, string> = {
  no_rounding: "No rounding", awaiting_visit_approval: "Approve the visit minutes first", day_has_open_visits: "Day has open or review visits",
  no_adjustment: "Already fits the increment", ready_to_approve: "Adjustment ready for approval", approved: "Adjustment approved",
  approved_under_earlier_policy: "Approved under an earlier policy (not recalculated)",
};
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";

export function RoundingSection({ from, to, refreshKey }: { from: string; to: string; refreshKey: number }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canApprove = hasPermission("billing.approve");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const keyFor = (k: string) => { if (!keys.current.has(k)) keys.current.set(k, newIdempotencyKey()); return keys.current.get(k)!; };
  const preview = useQuery({
    queryKey: ["aws-rounding-preview", activeOrganizationId, from, to, refreshKey],
    enabled: Boolean(activeOrganizationId) && hasPermission("billing.visits.read"),
    // Keep the list on screen while it refreshes after a visit approval (no flicker to "Loading…").
    placeholderData: keepPreviousData,
    queryFn: async () => (await api.get<{ units: Unit[] }>("/v1/billing-rounding/preview", { organizationId: activeOrganizationId, from, to })).units,
  });
  const units = (preview.data ?? []).filter((u) => u.method !== "none" || u.adjustmentId);

  async function approve(u: Unit) {
    setBusy(u.unitKey); setNote(null);
    try {
      const body = u.unitKind === "visit" ? { organizationId: activeOrganizationId, visitId: u.visitId }
        : { organizationId: activeOrganizationId, authorizationLineageId: u.authorizationLineageId, serviceDate: u.serviceDate };
      const r = await api.post<{ adjustment: { adjustmentMinutes: number; proposedMinutes: number; cappedByAuthorization: boolean } }>("/v1/billing-rounding/adjustments", body, { idempotencyKey: keyFor(`a:${u.unitKey}`) });
      keys.current.delete(`a:${u.unitKey}`);
      setNote({ ok: true, text: `Rounding adjustment approved: ${signed(r.adjustment.adjustmentMinutes)} min, ${r.adjustment.proposedMinutes} min proposed for billing${r.adjustment.cappedByAuthorization ? " (limited by the authorization)" : ""}. Visit records are unchanged.` });
      await qc.invalidateQueries({ queryKey: ["aws-rounding-preview"] });
    } catch (cause) { setNote({ ok: false, text: message(cause, "The adjustment was not approved.") }); } finally { setBusy(null); }
  }
  async function voidIt(u: Unit) {
    const reason = window.prompt("Why is this rounding adjustment being voided?");
    if (!reason?.trim()) return;
    setBusy(u.unitKey); setNote(null);
    try {
      await api.post(`/v1/billing-rounding/adjustments/${encodeURIComponent(u.adjustmentId!)}/void`, { reason: reason.trim() }, { idempotencyKey: keyFor(`v:${u.adjustmentId}`) });
      setNote({ ok: true, text: "Rounding adjustment voided. The visit approvals are unchanged." });
      await qc.invalidateQueries({ queryKey: ["aws-rounding-preview"] });
    } catch (cause) { setNote({ ok: false, text: message(cause, "The adjustment was not voided.") }); } finally { setBusy(null); }
  }

  return (
    <section aria-labelledby="rounding-heading" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="rounding-heading" className="text-base font-semibold text-slate-950">Billing rounding</h2>
        {hasPermission("billing.rounding.manage") ? <Link to="/settings/billing-rounding" className="text-sm underline">Rounding policies</Link> : null}
      </div>
      <p className="text-sm text-slate-600">
        Actual times and worked minutes are never changed. A rounding adjustment is a separate line, computed from the approved visit minutes
        under the payer's policy in effect that day, and billed only when approved here.
      </p>
      {preview.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {preview.isError ? <p role="alert" className="text-sm text-red-700">{message(preview.error, "Rounding could not be loaded.")}</p> : null}
      {note ? <p role={note.ok ? "status" : "alert"} className={`text-sm ${note.ok ? "text-emerald-800" : "text-red-700"}`}>{note.text}</p> : null}
      {preview.data && units.length === 0 ? <p className="text-sm text-slate-500">No rounding policy applies to visits in this range (default: no rounding).</p> : null}
      <ul aria-label="Rounding by visit or day" className="space-y-2">
        {units.map((u) => {
          const approved = u.state === "approved" || u.state === "approved_under_earlier_policy";
          return (
            <li key={u.unitKey}>
              <Card className="p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-slate-900">
                    {u.serviceDate} · {u.clientCode} · {u.serviceName} · {u.unitKind === "day" ? `daily total of ${u.visitCount} visit${u.visitCount === 1 ? "" : "s"}` : `visit ${u.visitNumber}`}
                  </p>
                  <span className="text-xs font-medium text-slate-700">{STATE_LABEL[u.state]}</span>
                </div>
                <p className="mt-1 text-xs text-slate-600">{u.payer} · {u.policyVersion ? `policy v${u.policyVersion}: ${METHOD_LABEL[u.method]}${u.incrementMinutes ? `, ${u.incrementMinutes} min` : ""}, ${u.basis ? BASIS_LABEL[u.basis] : ""}` : "no policy"}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                  <div><dt className="text-xs text-slate-500">Actual duration</dt><dd>{u.workedMinutes} min</dd></div>
                  <div><dt className="text-xs text-slate-500">Approved (visit)</dt><dd>{u.approvedMinutes ?? "—"}{u.approvedMinutes !== null ? " min" : ""}</dd></div>
                  <div><dt className="text-xs text-slate-500">Billing adjustment</dt><dd>{approved ? `${signed(u.adjustedMinutes ?? 0)} min` : `${signed(u.adjustmentMinutes)} min`}</dd></div>
                  <div><dt className="text-xs text-slate-500">Proposed billable</dt><dd>{approved ? `${u.adjustedProposedMinutes} min` : `${u.proposedMinutes} min`}{!approved && u.proposedUnits ? ` · ${u.proposedUnits} units` : ""}</dd></div>
                </dl>
                {u.cappedByAuthorization && !approved ? <p className="mt-1 text-xs font-medium text-amber-800">Limited by the authorization: rounding may not exceed the authorized minutes.</p> : null}
                {u.state === "approved_under_earlier_policy" ? <p className="mt-1 text-xs text-slate-600">Approved under policy v{u.adjustedPolicyVersion}. It is not recalculated; void it to apply the current policy.</p> : null}
                {canApprove ? (
                  <div className="mt-2">
                    {u.state === "ready_to_approve" ? <Button className="min-h-11" disabled={busy === u.unitKey} onClick={() => void approve(u)}>Approve adjustment</Button> : null}
                    {approved ? <Button className="min-h-11" variant="secondary" disabled={busy === u.unitKey} onClick={() => void voidIt(u)}>Void adjustment</Button> : null}
                  </div>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function BillingRoundingSettingsPage() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const services = useServices();
  const canManage = hasPermission("billing.rounding.manage");
  const policies = useQuery({
    queryKey: ["aws-rounding-policies", activeOrganizationId],
    enabled: Boolean(activeOrganizationId) && (canManage || hasPermission("billing.visits.read")),
    queryFn: async () => (await api.get<{ policies: Policy[] }>("/v1/billing-rounding/policies", { organizationId: activeOrganizationId })).policies,
  });
  const [f, setF] = useState({ payer: "", serviceId: "", method: "none" as Method, increment: "15", basis: "" as Basis | "", ref: "", refDate: "", from: "", reason: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); key.current = newIdempotencyKey(); };

  if (!canManage && !hasPermission("billing.visits.read")) return <Card className="p-4"><p className="text-sm">You do not have access to billing rounding.</p></Card>;

  async function submit() {
    if (!f.payer.trim() || !f.serviceId) return setState({ busy: false, error: "Enter the payer and choose the service.", done: null });
    if (f.method !== "none" && (!f.basis || !f.increment)) return setState({ busy: false, error: "Choose the increment and whether rounding applies to each visit or to the daily total.", done: null });
    if (f.method !== "none" && (!f.ref.trim() || !f.refDate)) return setState({ busy: false, error: "Record the payer rule (document reference and date) before enabling rounding.", done: null });
    if (!f.from || !f.reason.trim()) return setState({ busy: false, error: "Enter the effective date and the reason for the change.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      const r = await api.post<{ policy: { version: number } }>("/v1/billing-rounding/policies", {
        organizationId: activeOrganizationId, payer: f.payer.trim(), serviceId: f.serviceId, method: f.method,
        incrementMinutes: f.method === "none" ? null : Number(f.increment), basis: f.method === "none" ? null : f.basis,
        payerRuleReference: f.ref.trim() || null, payerRuleDate: f.refDate || null, effectiveFrom: f.from, reason: f.reason.trim(),
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await qc.invalidateQueries({ queryKey: ["aws-rounding-policies"] });
      await qc.invalidateQueries({ queryKey: ["aws-rounding-preview"] });
      setState({ busy: false, error: null, done: `Saved as version ${r.policy.version}, effective ${f.from}. Earlier versions and approved adjustments are unchanged.` });
    } catch (cause) { setState({ busy: false, error: message(cause, "The policy was not saved."), done: null }); }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Billing rounding policies</h1>
      <p className="text-sm text-slate-700">
        Default: no rounding. Set rounding only as the payer's own rules allow: your choice configures Ogevia; it does not change what the payer accepts.
        Rounding never changes clock times, worked minutes or payroll, and never exceeds authorized minutes.
      </p>
      {canManage ? (
        <Card className="p-4">
          <h2 className="mb-2 text-base font-semibold">New policy version</h2>
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="grid gap-3 sm:grid-cols-2">
            <div><label htmlFor="rp-payer" className="block text-sm font-medium text-slate-700">Payer (as on the authorizations)</label>
              <input id="rp-payer" value={f.payer} onChange={(e) => set("payer", e.target.value)} className={inputClass} /></div>
            <div><label htmlFor="rp-service" className="block text-sm font-medium text-slate-700">Service</label>
              <select id="rp-service" value={f.serviceId} onChange={(e) => set("serviceId", e.target.value)} className={inputClass}>
                <option value="">Choose a service</option>
                {(services.data ?? []).map((s) => <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.code})</option>)}
              </select></div>
            <fieldset className="sm:col-span-2"><legend className="text-sm font-medium text-slate-700">Rounding</legend>
              <div className="mt-1 grid gap-1 sm:grid-cols-4">
                {(Object.keys(METHOD_LABEL) as Method[]).map((m) => (
                  <label key={m} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3">
                    <input type="radio" name="rp-method" checked={f.method === m} onChange={() => set("method", m)} />{METHOD_LABEL[m]}
                  </label>
                ))}
              </div></fieldset>
            {f.method !== "none" ? (
              <>
                <div><label htmlFor="rp-inc" className="block text-sm font-medium text-slate-700">Increment (minutes)</label>
                  <input id="rp-inc" type="number" min={1} max={240} value={f.increment} onChange={(e) => set("increment", e.target.value)} className={inputClass} /></div>
                <fieldset><legend className="text-sm font-medium text-slate-700">Applies to (one only)</legend>
                  {(Object.keys(BASIS_LABEL) as Basis[]).map((b) => (
                    <label key={b} className="mt-1 flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3">
                      <input type="radio" name="rp-basis" checked={f.basis === b} onChange={() => set("basis", b)} />{BASIS_LABEL[b]}
                    </label>
                  ))}</fieldset>
                <div><label htmlFor="rp-ref" className="block text-sm font-medium text-slate-700">Payer rule (document and section)</label>
                  <input id="rp-ref" value={f.ref} onChange={(e) => set("ref", e.target.value)} className={inputClass} /></div>
                <div><label htmlFor="rp-refdate" className="block text-sm font-medium text-slate-700">Date of that payer document</label>
                  <input id="rp-refdate" type="date" value={f.refDate} onChange={(e) => set("refDate", e.target.value)} className={inputClass} /></div>
              </>
            ) : null}
            <div><label htmlFor="rp-from" className="block text-sm font-medium text-slate-700">Effective from (service date)</label>
              <input id="rp-from" type="date" value={f.from} onChange={(e) => set("from", e.target.value)} className={inputClass} /></div>
            <div><label htmlFor="rp-reason" className="block text-sm font-medium text-slate-700">Reason for the change</label>
              <input id="rp-reason" value={f.reason} onChange={(e) => set("reason", e.target.value)} className={inputClass} /></div>
            {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
            {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">{state.done}</p> : null}
            <div className="sm:col-span-2"><Button type="submit" className="min-h-11" disabled={state.busy}>{state.busy ? "Saving…" : "Save new version"}</Button></div>
          </form>
        </Card>
      ) : null}
      <Card className="p-4">
        <h2 className="text-base font-semibold">History</h2>
        {policies.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {policies.isError ? <p role="alert" className="text-sm text-red-700">{message(policies.error, "Policies could not be loaded.")}</p> : null}
        {policies.data && policies.data.length === 0 ? <p className="text-sm text-slate-500">No policies: no rounding anywhere.</p> : null}
        <ul aria-label="Rounding policy versions" className="mt-2 divide-y divide-slate-100 text-sm">
          {(policies.data ?? []).map((p) => (
            <li key={p.policyId} className="py-2">
              <p className="font-medium">{p.payer} · {p.serviceName} · v{p.version}{p.inEffectToday ? <span className="ml-1 rounded bg-emerald-100 px-1 text-xs text-emerald-900">in effect today</span> : null}</p>
              <p className="text-slate-700">{METHOD_LABEL[p.method]}{p.incrementMinutes ? `, ${p.incrementMinutes} min` : ""}{p.basis ? `, ${BASIS_LABEL[p.basis]}` : ""} · effective {p.effectiveFrom}</p>
              {p.payerRuleReference ? <p className="text-xs text-slate-600">Payer rule: {p.payerRuleReference} ({p.payerRuleDate})</p> : null}
              <p className="text-xs text-slate-500">{p.reason} · {p.createdByName}, {new Date(p.createdAt).toLocaleString()}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
