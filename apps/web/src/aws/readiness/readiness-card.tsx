import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { useReadiness } from "./queries";
import { actionError } from "./format";

export interface ReadinessStatus {
  enforcementActive: boolean;
  serviceChecks: { label: string; state: "On" | "Off"; enabled: boolean; offHeadline: string | null; offMessage: string | null; action: string };
  setupGaps: { code: string; requirement: "cpr" | "tb"; gap: "type_not_set" | "policy_not_set" }[];
  setupComplete: boolean;
  caregivers: { readyOrActive: number; withDocumentGaps: number; availabilityNotProvided: number; servicePairsToReview: number };
  futureWork: { scheduledShifts: number; shiftsNeedingDocuments: number; shiftsNeedingServiceApproval: number; shiftsOutsideApprovedHours: number; standingAssignmentsNeedingDocuments: number; standingAssignmentsNeedingServiceApproval: number };
  affectedShiftsCount: number;
}
interface DocType { documentTypeId: string; name: string }
interface SetupRow { requirement: "cpr" | "tb"; documentTypeId: string | null; documentTypeName: string | null; validityBasis: string | null; validityDays: number | null; complete: boolean; gap: string | null }

const inputClass = "mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-base";

/** Choose which document type is the CPR / TB record and how long it stays valid. Ogevia ships no default period. */
function RequiredDocumentsSetup() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const setup = useQuery({
    queryKey: ["document-requirements", activeOrganizationId],
    queryFn: async () => (await api.get<{ setup: { requirements: SetupRow[] } }>("/v1/document-requirements", { organizationId: activeOrganizationId })).setup.requirements,
  });
  const types = useQuery({
    queryKey: ["aws-document-types", activeOrganizationId],
    queryFn: async () => (await api.get<{ types: DocType[] }>("/v1/document-types", { organizationId: activeOrganizationId })).types,
  });
  const [draft, setDraft] = useState<Record<string, { typeId: string; basis: string; days: string }>>({});
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState(false);
  const key = useRef(newIdempotencyKey());
  const rows = setup.data ?? [];
  const value = (r: SetupRow) => draft[r.requirement] ?? { typeId: r.documentTypeId ?? "", basis: r.validityBasis ?? "", days: r.validityDays ? String(r.validityDays) : "" };
  const patch = (r: SetupRow, p: Partial<{ typeId: string; basis: string; days: string }>) => { key.current = newIdempotencyKey(); setSaved(false); setDraft((d) => ({ ...d, [r.requirement]: { ...value(r), ...p } })); };
  const save = useMutation({
    mutationFn: async () => {
      for (const r of rows) {
        const v = value(r);
        if (v.typeId && v.typeId !== (r.documentTypeId ?? "")) {
          await api.post("/v1/document-requirements/type", { organizationId: activeOrganizationId, requirement: r.requirement, documentTypeId: v.typeId, reason: reason.trim() }, { idempotencyKey: newIdempotencyKey() });
        }
        if (v.basis && (v.basis !== (r.validityBasis ?? "") || (v.basis === "issue_plus_days" && Number(v.days) !== (r.validityDays ?? 0)))) {
          await api.post("/v1/document-requirements/policy", { organizationId: activeOrganizationId, requirement: r.requirement, validityBasis: v.basis, validityDays: v.basis === "issue_plus_days" ? Number(v.days) : null, reason: reason.trim() }, { idempotencyKey: newIdempotencyKey() });
        }
      }
    },
    onSuccess: () => { setSaved(true); setReason(""); void qc.invalidateQueries({ queryKey: ["document-requirements"] }); void qc.invalidateQueries({ queryKey: ["readiness"] }); },
  });
  return (
    <form className="space-y-3" aria-label="Required documents" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3 && !save.isPending) save.mutate(); }}>
      <p className="text-sm text-slate-700">Choose which of your document types is the CPR record and which is the TB record, and how long each stays valid. Ogevia does not assume a period; until both are set, the requirement is reported as setup incomplete.</p>
      {rows.map((r) => {
        const v = value(r);
        return (
          <fieldset key={r.requirement} className="space-y-2 rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-sm font-semibold text-slate-900">{r.requirement.toUpperCase()}</legend>
            <label className="block text-sm font-medium text-slate-800">Document type
              <select value={v.typeId} onChange={(e) => patch(r, { typeId: e.target.value })} className={inputClass}>
                <option value="">Not set</option>
                {(types.data ?? []).map((t) => <option key={t.documentTypeId} value={t.documentTypeId}>{t.name}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-800">Valid until
              <select value={v.basis} onChange={(e) => patch(r, { basis: e.target.value })} className={inputClass}>
                <option value="">Not set</option>
                <option value="document_expiry">The expiry date on the record</option>
                <option value="issue_plus_days">A number of days after the issue date</option>
              </select>
            </label>
            {v.basis === "issue_plus_days" ? (
              <label className="block text-sm font-medium text-slate-800">Days after the issue date
                <input type="number" min={1} max={3650} value={v.days} onChange={(e) => patch(r, { days: e.target.value })} className={inputClass} />
              </label>
            ) : null}
          </fieldset>
        );
      })}
      <label className="block text-sm font-medium text-slate-800">Reason for the change
        <textarea value={reason} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} rows={2} maxLength={500} className={inputClass} />
      </label>
      {save.isError ? <p role="alert" className="text-sm text-red-700">{actionError(save.error, "The rules could not be saved.")}</p> : null}
      {saved ? <p role="status" className="text-sm font-medium text-emerald-900">Saved.</p> : null}
      <Button type="submit" disabled={save.isPending || reason.trim().length < 3}>{save.isPending ? "Saving…" : "Save"}</Button>
    </form>
  );
}

/**
 * Where readiness is controlled: the "Service checks" switch (On / Off, administrator only), setup gaps, what
 * activating the checks would affect, and the activation itself. Nothing here is turned on automatically.
 */
export function ReadinessCard() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const q = useReadiness();
  const [reason, setReason] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const key = useRef(newIdempotencyKey());
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["readiness"] }); };
  const canManage = hasPermission("readiness.manage");
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post("/v1/readiness/service-checks", { organizationId: activeOrganizationId, enabled, reason: reason.trim() }),
    onSuccess: () => { setReason(""); refresh(); },
  });
  const activate = useMutation({
    mutationFn: () => api.post("/v1/readiness/activate", { organizationId: activeOrganizationId, reason: reason.trim(), expectedAffectedShifts: q.data?.affectedShiftsCount ?? 0 }),
    onSuccess: () => { setReason(""); refresh(); },
  });
  if (!hasPermission("readiness.read")) return null;
  if (q.isLoading) return <Card className="p-4"><p className="text-sm text-slate-500">Loading…</p></Card>;
  if (q.isError || !q.data) return <Card className="p-4"><p role="alert" className="text-sm text-red-700">{actionError(q.error, "Readiness could not be loaded.")}</p></Card>;
  const s = q.data;
  const sc = s.serviceChecks;
  return (
    <Card className="space-y-4 p-4" aria-label="Caregiver readiness">
      <h2 className="text-base font-semibold text-slate-950">Caregiver readiness</h2>

      <section aria-label="Service checks" className="space-y-1">
        <p className="text-sm font-medium text-slate-900">{sc.label}: {sc.state}</p>
        {sc.state === "Off" ? (
          <>
            <p className="text-sm font-semibold text-amber-950">{sc.offHeadline}</p>
            <p className="text-sm text-slate-800">{sc.offMessage}</p>
          </>
        ) : <p className="text-sm text-slate-800">A caregiver needs an approval for a service before being assigned to it.</p>}
        <p className="text-xs text-slate-600">This switch never turns off CPR, TB, availability or any other check.</p>
        <p className="pt-1"><Link to="/care-team/services-review" className="inline-flex min-h-[44px] items-center text-sm font-medium text-[#0F6674] underline">{sc.action}</Link></p>
      </section>

      <section aria-label="Setup" className="space-y-1">
        <p className="text-sm font-medium text-slate-900">Required documents</p>
        {s.setupComplete ? <p className="text-sm text-slate-800">CPR and TB rules are set.</p> : (
          <ul className="list-disc pl-5 text-sm text-amber-950">
            {s.setupGaps.map((g) => <li key={g.code}>{g.requirement.toUpperCase()}: {g.gap === "type_not_set" ? "document type not chosen" : "validity rule not set"} (setup incomplete)</li>)}
          </ul>
        )}
        {canManage || hasPermission("documents.requirements.manage") ? (
          <Button type="button" variant="secondary" aria-expanded={showSetup} onClick={() => setShowSetup((x) => !x)}>{showSetup ? "Close setup" : "Set up required documents"}</Button>
        ) : null}
        {showSetup ? <div className="pt-2"><RequiredDocumentsSetup /></div> : null}
      </section>

      <section aria-label="Checks status" className="space-y-1">
        <p className="text-sm font-medium text-slate-900">{s.enforcementActive ? "Readiness checks are active" : "Readiness checks are not active yet. Nothing is blocked."}</p>
        <ul className="list-disc pl-5 text-sm text-slate-800">
          <li>{s.caregivers.withDocumentGaps} of {s.caregivers.readyOrActive} caregivers do not have current CPR and TB.</li>
          <li>{s.caregivers.availabilityNotProvided} have no availability on file.</li>
          <li>{s.caregivers.servicePairsToReview} caregiver and service pairs have no approval yet.</li>
          <li>{s.futureWork.scheduledShifts} future shifts are booked; {s.affectedShiftsCount} would not meet today's document or hours checks.</li>
          <li>{s.futureWork.standingAssignmentsNeedingDocuments} standing assignments need documents.</li>
        </ul>
      </section>

      {canManage ? (
        <section aria-label="Change settings" className="space-y-2 border-t border-slate-200 pt-3">
          <label className="block text-sm font-medium text-slate-800">Reason (required for any change)
            <textarea value={reason} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} rows={2} maxLength={500} className={inputClass} />
          </label>
          {toggle.isError ? <p role="alert" className="text-sm text-red-700">{actionError(toggle.error, "The change could not be saved.")}</p> : null}
          {activate.isError ? <p role="alert" className="text-sm text-red-700">{actionError(activate.error, "Readiness checks could not be activated.")}</p> : null}
          <div className="flex flex-wrap gap-2">
            {!s.enforcementActive ? (
              <Button type="button" disabled={activate.isPending || reason.trim().length < 3 || !s.setupComplete} onClick={() => activate.mutate()}>
                {activate.isPending ? "Activating…" : "Activate readiness checks"}
              </Button>
            ) : (
              <Button type="button" variant="secondary" disabled={toggle.isPending || reason.trim().length < 3} onClick={() => toggle.mutate(!sc.enabled)}>
                {toggle.isPending ? "Saving…" : sc.enabled ? "Turn Service checks Off" : "Turn Service checks On"}
              </Button>
            )}
          </div>
          {!s.enforcementActive && !s.setupComplete ? <p className="text-xs text-slate-600">Finish the required documents setup before activating.</p> : null}
        </section>
      ) : null}
    </Card>
  );
}
