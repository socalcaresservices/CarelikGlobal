import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { useReadiness } from "./queries";
import { actionError } from "./format";
import { ShortHelp } from "../help-text";
import { SummarySection } from "../ui/summary-section";


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
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
      <ShortHelp className="text-sm text-slate-700" details="Ogevia does not assume a period; until both are set, the requirement is reported as setup incomplete.">Choose which document type is the CPR record and which is TB, and how long each stays valid.</ShortHelp>
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

type Tone = "ok" | "warn" | "bad" | "neutral";
const TONE: Record<Tone, string> = {
  ok: "bg-emerald-100 text-emerald-950",
  warn: "bg-amber-100 text-amber-950",
  bad: "bg-red-100 text-red-900",
  neutral: "bg-slate-200 text-slate-900",
};
/** One readiness issue: what it is, how many are affected, whether it is active, and the one next step. Detail sits in "Details". */
function ReadinessRow({ issue, affected, status, action, help }: { issue: string; affected: string; status: { label: string; tone: Tone }; action: React.ReactNode; help?: React.ReactNode }) {
  return (
    <tr className="border-t border-slate-200 align-top max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:py-1.5">
      <th scope="row" className="py-1.5 pr-3 font-medium text-slate-900 max-md:w-full max-md:pb-0">
        {issue}
        {help ? <details className="mt-1 text-xs font-normal text-slate-700"><summary className="cursor-pointer text-og-accent underline [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:items-center">Details</summary><div className="mt-1">{help}</div></details> : null}
      </th>
      <td className="py-2 pr-3 text-slate-900 max-md:py-1">{affected}</td>
      <td className="py-2 pr-3 max-md:py-1"><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[status.tone]}`}>{status.label}</span></td>
      <td className="py-2 max-md:py-0">{action}</td>
    </tr>
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
    <SummarySection title="Caregiver readiness" hideSummaryWhenOpen defaultOpen={!s.setupComplete || s.affectedShiftsCount > 0}
      status={<span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.enforcementActive ? "bg-emerald-100 text-emerald-950" : "bg-amber-100 text-amber-950"}`}>{s.enforcementActive ? "Checks active" : "Report only"}</span>}
      summary={!s.setupComplete ? `Setup incomplete: ${plural(s.setupGaps.length, "rule", "rules")}` : `${s.caregivers.withDocumentGaps} of ${plural(s.caregivers.readyOrActive, "caregiver", "caregivers")} with document gaps`}>
    <div className="space-y-4">

      <section aria-label="Service checks" className="space-y-1">
        <p className={`text-sm font-semibold ${sc.state === "Off" ? "text-amber-950" : "text-slate-900"}`}>{sc.state === "Off" ? sc.offHeadline : `${sc.label}: ${sc.state}`}</p>
        {sc.state === "Off"
          ? <p className="text-sm text-slate-800">{sc.offMessage}</p>
          : <p className="text-sm text-slate-800">A caregiver needs an approval for a service before being assigned to it.</p>}
        <p className="text-xs text-slate-600">This switch never turns off CPR, TB, availability or any other check.</p>
      </section>

      <section aria-label="Checks status" className="space-y-3">
        {!s.enforcementActive ? (
          <>
            <p className="inline-block rounded-md bg-amber-100 px-3 py-1.5 text-sm font-semibold text-amber-950">Report-only. Readiness checks are NOT active.</p>
            <p className="text-sm text-slate-800">Nothing is blocked yet. Caregivers can still be assigned and can still start visits.</p>
          </>
        ) : null}
        <div>
          <table className="w-full text-left text-sm max-md:block">
            <caption className="sr-only">Readiness by issue: affected count, status and next action</caption>
            <thead className="max-md:hidden">
              <tr className="text-xs uppercase tracking-wide text-slate-600">
                <th scope="col" className="py-2 pr-3 font-semibold">Issue</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Affected</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Status</th>
                <th scope="col" className="py-2 font-semibold">Next action</th>
              </tr>
            </thead>
            <tbody className="max-md:block">
              <ReadinessRow
                issue="Document setup (CPR and TB rules)"
                affected={s.setupComplete ? "None" : plural(s.setupGaps.length, "rule", "rules")}
                status={s.setupComplete ? { label: "Set", tone: "ok" } : { label: "Setup incomplete", tone: "bad" }}
                action={canManage || hasPermission("documents.requirements.manage")
                  ? <button type="button" className="min-h-[44px] text-left font-medium text-og-accent underline" aria-expanded={showSetup} onClick={() => setShowSetup((x) => !x)}>{showSetup ? "Close setup" : "Set up required documents"}</button>
                  : <span className="text-slate-600">Ask an administrator</span>}
                help={s.setupComplete ? "CPR and TB rules are set." : (
                  <ul className="list-disc pl-5">
                    {s.setupGaps.map((g) => <li key={g.code}>{g.requirement.toUpperCase()}: {g.gap === "type_not_set" ? "document type not chosen" : "validity rule not set"} (setup incomplete)</li>)}
                  </ul>
                )}
              />
              <ReadinessRow
                issue="CPR or TB missing or expired"
                affected={`${s.caregivers.withDocumentGaps} of ${plural(s.caregivers.readyOrActive, "caregiver", "caregivers")}`}
                status={s.enforcementActive ? { label: "Active", tone: "ok" } : { label: "Report only", tone: "warn" }}
                action={<Link to="/documents" className="inline-flex min-h-[44px] items-center font-medium text-og-accent underline">Review documents</Link>}
                help={s.enforcementActive ? "A caregiver without current CPR and TB cannot be newly assigned or start a visit." : "Current verified CPR and TB are not being required yet. A caregiver without them can still be assigned and can still start visits until the checks are activated."}
              />
              <ReadinessRow
                issue="Availability not provided"
                affected={plural(s.caregivers.availabilityNotProvided, "caregiver", "caregivers")}
                status={s.enforcementActive ? { label: "Active", tone: "ok" } : { label: "Report only", tone: "warn" }}
                action={<Link to="/care-team" className="inline-flex min-h-[44px] items-center font-medium text-og-accent underline">Ask for hours</Link>}
              />
              <ReadinessRow
                issue="Service approvals to review"
                affected={plural(s.caregivers.servicePairsToReview, "caregiver and service pair", "caregiver and service pairs")}
                status={sc.state === "On" ? { label: "On", tone: "ok" } : { label: "Off", tone: "neutral" }}
                action={<Link to="/care-team/services-review" className="inline-flex min-h-[44px] items-center font-medium text-og-accent underline">{sc.action}</Link>}
              />
              <ReadinessRow
                issue="Booked shifts that would not pass today's document or hours checks"
                affected={`${s.affectedShiftsCount} of ${plural(s.futureWork.scheduledShifts, "future shift", "future shifts")}`}
                status={s.enforcementActive ? { label: "Needs attention", tone: "bad" } : { label: "Would block if activated", tone: "warn" }}
                action={<Link to="/schedule" className="inline-flex min-h-[44px] items-center font-medium text-og-accent underline">Open schedule</Link>}
              />
              <ReadinessRow
                issue="Standing assignments that need documents"
                affected={plural(s.futureWork.standingAssignmentsNeedingDocuments, "assignment", "assignments")}
                status={s.enforcementActive ? { label: "Needs attention", tone: "bad" } : { label: "Report only", tone: "warn" }}
                action={<Link to="/care-team" className="inline-flex min-h-[44px] items-center font-medium text-og-accent underline">Open Care Team</Link>}
              />
            </tbody>
          </table>
        </div>
        {showSetup ? <div className="pt-1"><RequiredDocumentsSetup /></div> : null}
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
    </div>
    </SummarySection>
  );
}
