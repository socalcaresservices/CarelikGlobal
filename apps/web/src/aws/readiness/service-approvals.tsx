import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { formatDateOnly } from "@/lib/service-verification";
import { useAwsApi } from "../aws-workspace";
import { useServices } from "../client-admin";
import { SERVICE_STATE_LABEL, actionError } from "./format";
import { useGuardedMutate } from "./use-guarded";
import { useServiceApprovals } from "./queries";
import { SummarySection } from "../ui/summary-section";
import { InfoTip } from "../ui/info-tip";

export interface ServiceApproval {
  approvalId: string;
  caregiverRecordId: string;
  caregiverCode: string;
  caregiverName: string;
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  state: "approved" | "revoked" | "expired" | "not_started";
  effectiveFrom: string;
  effectiveUntil: string | null;
  approvalReason: string;
  approvedByName: string | null;
  revokedEffectiveOn: string | null;
  revocationReason: string | null;
}

const inputClass = "mt-1 block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm";
const STATE_BADGE: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-950",
  revoked: "bg-red-100 text-red-950",
  expired: "bg-slate-100 text-slate-800",
  not_started: "bg-sky-100 text-sky-950",
};

function RevokeForm({ approval, onDone }: { approval: ServiceApproval; onDone: (note: string) => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [reason, setReason] = useState("");
  const key = useRef(newIdempotencyKey());
  const revoke = useMutation({
    mutationFn: () => api.post<{ result: { affectedShifts: unknown[]; affectedAssignments: unknown[]; note: string } }>(
      `/v1/caregiver-services/${encodeURIComponent(approval.approvalId)}/revoke`, { organizationId: activeOrganizationId, reason: reason.trim() }, { idempotencyKey: key.current }),
    onSuccess: (r) => onDone(`Revoked. ${r.result.affectedShifts.length} future shift${r.result.affectedShifts.length === 1 ? "" : "s"} and ${r.result.affectedAssignments.length} standing assignment${r.result.affectedAssignments.length === 1 ? "" : "s"} flagged for review. ${r.result.note}`),
  });
  const send = useGuardedMutate(revoke);
  return (
    <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3 && !revoke.isPending) send(); }} aria-label="Revoke approval">
      <label className="block text-sm font-medium text-slate-800">Reason for revoking
        <textarea value={reason} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} rows={2} maxLength={500} className={inputClass} />
      </label>
      <InfoTip label="Help">Past visits, shifts and billing approvals are unchanged. Affected future work is flagged for review.</InfoTip>
      {revoke.isError ? <p role="alert" className="text-sm text-red-700">{actionError(revoke.error, "The approval could not be revoked.")}</p> : null}
      <Button type="submit" variant="danger" disabled={revoke.isPending || reason.trim().length < 3}>{revoke.isPending ? "Revoking…" : "Revoke approval"}</Button>
    </form>
  );
}

function ApproveForm({ caregiverRecordId, onDone }: { caregiverRecordId: string; onDone: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const services = useServices();
  const [serviceId, setServiceId] = useState("");
  const [from, setFrom] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const key = useRef(newIdempotencyKey());
  const touch = () => { key.current = newIdempotencyKey(); };
  const approve = useMutation({
    mutationFn: () => api.post("/v1/caregiver-services", { organizationId: activeOrganizationId, caregiverRecordId, serviceId, effectiveFrom: from, effectiveUntil: until || null, reason: reason.trim() }, { idempotencyKey: key.current }),
    onSuccess: () => { key.current = newIdempotencyKey(); setReason(""); setServiceId(""); onDone(); },
  });
  const send = useGuardedMutate(approve);
  const disabled = approve.isPending || !serviceId || !from || reason.trim().length < 3;
  return (
    <form className="space-y-2" aria-label="Approve a service" onSubmit={(e) => { e.preventDefault(); if (!disabled) send(); }}>
      <label className="block text-sm font-medium text-slate-800">Service
        <select value={serviceId} onChange={(e) => { setServiceId(e.target.value); touch(); }} className={inputClass}>
          <option value="">Choose a service</option>
          {(services.data ?? []).filter((s) => s.isActive).map((s) => <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.code})</option>)}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-800">Starts<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); touch(); }} className={inputClass} /></label>
        <label className="block text-sm font-medium text-slate-800">Ends (optional)<input type="date" value={until} min={from} onChange={(e) => { setUntil(e.target.value); touch(); }} className={inputClass} /></label>
      </div>
      <label className="block text-sm font-medium text-slate-800">Reason
        <textarea value={reason} onChange={(e) => { setReason(e.target.value); touch(); }} rows={2} maxLength={500} className={inputClass} />
      </label>
      {approve.isError ? <p role="alert" className="text-sm text-red-700">{actionError(approve.error, "The approval could not be saved.")}</p> : null}
      <Button type="submit" disabled={disabled}>{approve.isPending ? "Saving…" : "Approve"}</Button>
    </form>
  );
}

/**
 * "Approved services" for one caregiver. Staff see every approval and its history; an administrator can approve or
 * revoke; a caregiver sees only their own and cannot approve. An approval is NOT a client authorization, an assignment
 * or an employment fact, and nothing here is inferred from them.
 */
export function CaregiverServices({ caregiverRecordId, own = false }: { caregiverRecordId?: string; own?: boolean }) {
  const qc = useQueryClient();
  const { hasPermission } = useOrganization();
  const q = useServiceApprovals(own ? undefined : caregiverRecordId);
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canApprove = !own && hasPermission("caregiver_services.approve");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["caregiver-services"] });
  const list = q.data ?? [];
  const current = list.filter((a) => a.state === "approved").length;
  return (
    <SummarySection title="Approved services" defaultOpen={own}
      status={q.data ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${current > 0 ? STATE_BADGE.approved : STATE_BADGE.not_started}`}>{current > 0 ? `${current} approved` : "None approved"}</span> : undefined}
      summary={q.data && list.length > current ? `${list.length} on record` : undefined}>
      {canApprove ? <div className="mb-2 text-right"><Button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close" : "Approve a service"}</Button></div> : null}
      {message ? <p role="status" className="text-sm text-emerald-900">{message}</p> : null}
      {q.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">{actionError(q.error, "Approvals could not be loaded.")}</p> : null}
      {q.data && q.data.length === 0 ? <p className="text-sm text-slate-600">{own ? "You have no approved services yet." : "No approved services. With Service checks on, a caregiver cannot be committed to a service until it is approved."}</p> : null}
      <ul className="mt-1 divide-y divide-slate-100">
        {list.map((a) => (
          <li key={a.approvalId} className="py-1 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium text-slate-900">{a.serviceName} <span className="font-normal text-slate-600">({a.serviceCode})</span></p>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATE_BADGE[a.state]}`}>{SERVICE_STATE_LABEL[a.state]}</span>
            </div>
            <p className="text-slate-700">From {formatDateOnly(a.effectiveFrom)}{a.effectiveUntil ? ` to ${formatDateOnly(a.effectiveUntil)}` : ""}{a.approvedByName ? ` · approved by ${a.approvedByName}` : ""}</p>
            {a.state === "revoked" ? <p className="text-slate-800">Revoked from {formatDateOnly(a.revokedEffectiveOn)}{a.revocationReason ? `: ${a.revocationReason}` : ""}. Visits before that date keep their approval.</p> : null}
            {canApprove && (a.state === "approved" || a.state === "not_started") ? (
              revoking === a.approvalId
                ? <RevokeForm approval={a} onDone={(m) => { setRevoking(null); setMessage(m); refresh(); }} />
                : <Button type="button" variant="secondary" className="mt-2" onClick={() => setRevoking(a.approvalId)}>Revoke</Button>
            ) : null}
          </li>
        ))}
      </ul>
      {adding && caregiverRecordId ? <div className="mt-2 border-t border-slate-200 pt-2"><ApproveForm caregiverRecordId={caregiverRecordId} onDone={() => { setAdding(false); setMessage("Service approved."); refresh(); }} /></div> : null}
    </SummarySection>
  );
}

interface ReviewPair {
  caregiverRecordId: string;
  caregiverCode: string;
  caregiverName: string;
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  activeAssignments: number;
  futureShifts: number;
  pastVisits: number;
  lastVisitOn: string | null;
  approvalState: string;
}

/** The review list for the move to approved services: pairs that already work together, none selected by default. */
export function ServicesReviewPage() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canApprove = hasPermission("caregiver_services.approve");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());
  const q = useQuery({
    queryKey: ["service-review", activeOrganizationId],
    queryFn: async () => (await api.get<{ pairs: ReviewPair[] }>("/v1/caregiver-services/review", { organizationId: activeOrganizationId })).pairs,
    enabled: !!activeOrganizationId && hasPermission("caregiver_services.read"),
  });
  const pairKey = (p: ReviewPair) => `${p.caregiverRecordId}|${p.serviceId}`;
  const approve = useMutation({
    mutationFn: () => api.post<{ result: { approved: number; alreadyApproved: number } }>("/v1/caregiver-services/bulk-approve", {
      organizationId: activeOrganizationId,
      pairs: (q.data ?? []).filter((p) => picked.has(pairKey(p))).map((p) => ({ caregiverRecordId: p.caregiverRecordId, serviceId: p.serviceId })),
      expectedCount: picked.size, effectiveFrom: from, reason: reason.trim(),
    }, { idempotencyKey: key.current }),
    onSuccess: (r) => {
      key.current = newIdempotencyKey(); setDone(`${r.result.approved} approved${r.result.alreadyApproved ? `, ${r.result.alreadyApproved} already approved` : ""}.`);
      setPicked(new Set()); setConfirming(false); setReason("");
      void qc.invalidateQueries({ queryKey: ["service-review"] }); void qc.invalidateQueries({ queryKey: ["caregiver-services"] }); void qc.invalidateQueries({ queryKey: ["readiness"] });
    },
  });
  if (!hasPermission("caregiver_services.read")) return <p className="text-sm text-slate-600">You do not have access to service approvals.</p>;
  const toggle = (p: ReviewPair) => { key.current = newIdempotencyKey(); setConfirming(false); setPicked((s) => { const n = new Set(s); if (n.has(pairKey(p))) n.delete(pairKey(p)); else n.add(pairKey(p)); return n; }); };
  return (
    <div className="max-w-4xl space-y-3">
      <Link to="/care-team" className="text-sm text-slate-700 underline">← Care Team</Link>
      <div className="flex items-center gap-1.5">
        <h1 className="text-xl font-bold tracking-tight text-slate-950">Review services</h1>
        <InfoTip label="About Review services">Being on this list is not an approval. Nothing is approved unless you tick it. These pairs already have an assignment, a booked shift or past visits, but no current approval.</InfoTip>
      </div>
      {done ? <p role="status" className="text-sm font-medium text-emerald-900">{done}</p> : null}
      {q.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">{actionError(q.error, "The list could not be loaded.")}</p> : null}
      {q.data && q.data.length === 0 ? <p className="text-sm text-slate-600">Nothing to review. Every caregiver and service pair in use has a current approval.</p> : null}
      <ul className="space-y-1">
        {(q.data ?? []).map((p) => (
          <li key={pairKey(p)} className="rounded-lg border border-slate-200 bg-og-card px-3 py-1">
            <label className="flex min-h-[44px] items-start gap-3 text-sm">
              {canApprove ? <input type="checkbox" className="mt-1 h-5 w-5" checked={picked.has(pairKey(p))} onChange={() => toggle(p)} aria-label={`Select ${p.caregiverName} for ${p.serviceName}`} /> : null}
              <span>
                <span className="font-medium text-slate-900">{p.caregiverName} ({p.caregiverCode}) · {p.serviceName}</span>
                <span className="block text-slate-700">{p.activeAssignments} assignment{p.activeAssignments === 1 ? "" : "s"} · {p.futureShifts} future shift{p.futureShifts === 1 ? "" : "s"} · {p.pastVisits} past visit{p.pastVisits === 1 ? "" : "s"}{p.lastVisitOn ? ` (last ${formatDateOnly(p.lastVisitOn)})` : ""}</span>
                {p.approvalState === "revoked" || p.approvalState === "expired" ? <span className="block font-medium text-amber-900">{SERVICE_STATE_LABEL[p.approvalState]}</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {canApprove && picked.size > 0 ? (
        <Card className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-950">Approve {picked.size} selected</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-800">Starts<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></label>
          </div>
          <label className="block text-sm font-medium text-slate-800">Reason
            <textarea value={reason} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} rows={2} className={inputClass} placeholder="For example: reviewed against training records" />
          </label>
          {confirming ? <p role="alert" className="text-sm font-medium text-amber-950">You are approving exactly {picked.size} caregiver and service pair{picked.size === 1 ? "" : "s"}. Nothing else is approved.</p> : null}
          {approve.isError ? <p role="alert" className="text-sm text-red-700">{actionError(approve.error, "The approvals could not be saved.")}</p> : null}
          {confirming
            ? <Button type="button" disabled={approve.isPending || reason.trim().length < 3} onClick={() => approve.mutate()}>{approve.isPending ? "Saving…" : `Confirm ${picked.size}`}</Button>
            : <Button type="button" disabled={reason.trim().length < 3 || !from} onClick={() => setConfirming(true)}>Approve</Button>}
        </Card>
      ) : null}
    </div>
  );
}
