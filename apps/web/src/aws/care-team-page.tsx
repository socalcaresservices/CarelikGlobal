import { useQuery, useQueryClient } from "@tanstack/react-query";
import { nameWithCode } from "./name-label";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { AssignmentsCard } from "./assignments-card";
import { useAwsApi } from "./aws-workspace";
import {
  CAREGIVER_STATUS_LABEL, WORK_STATUS_BADGE, WORK_STATUS_LABEL, caregiverName, signInLabel, useCaregivers,
  type Caregiver, type CaregiverStatus, type WorkStatus,
} from "./care-team-admin";
import { formatDateTime } from "@/lib/service-verification";
import type { StaffDocument } from "./document-status";
import { CaregiverReadiness } from "./readiness/caregiver-readiness";
import { ReadinessCard } from "./readiness/readiness-card";
import { AvailabilityReview } from "./readiness/availability-review";
import { ReadinessChecklist } from "./readiness/readiness-checklist";
import { useCaregiverReadiness } from "./readiness/readiness-data";
import { SendSignInLink } from "./readiness/send-signin-link";
import { SummarySection } from "./ui/summary-section";
import { InfoTip } from "./ui/info-tip";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm";
const WORK_STATUSES: readonly WorkStatus[] = ["not_ready", "approved", "active", "inactive"];

function useRefreshCareTeam() {
  const queryClient = useQueryClient();
  return async () => {
    for (const k of ["aws-caregivers", "aws-document-people"]) await queryClient.invalidateQueries({ queryKey: [k] });
  };
}

function NameFields({ v, set, idPrefix }: { v: { first: string; last: string; preferred: string }; set: (k: "first" | "last" | "preferred") => (x: string) => void; idPrefix: string }) {
  return (
    <>
      <div><label htmlFor={`${idPrefix}-first`} className="block text-xs font-medium text-slate-700">First name</label><input id={`${idPrefix}-first`} value={v.first} maxLength={80} autoComplete="off" onChange={(e) => set("first")(e.target.value)} className={inputClass} /></div>
      <div><label htmlFor={`${idPrefix}-last`} className="block text-xs font-medium text-slate-700">Last name</label><input id={`${idPrefix}-last`} value={v.last} maxLength={80} autoComplete="off" onChange={(e) => set("last")(e.target.value)} className={inputClass} /></div>
      <div className="sm:col-span-2"><label htmlFor={`${idPrefix}-preferred`} className="block text-xs font-medium text-slate-700">Preferred name (optional)</label><input id={`${idPrefix}-preferred`} value={v.preferred} maxLength={80} autoComplete="off" onChange={(e) => set("preferred")(e.target.value)} className={inputClass} /></div>
    </>
  );
}

function AddCaregiverForm({ onDone }: { onDone: (id: string) => void }) {
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const { activeOrganizationId } = useOrganization();
  const [v, setV] = useState({ first: "", last: "", preferred: "" });
  const [status, setStatus] = useState<Exclude<CaregiverStatus, "inactive" | "interview" | "offer" | "pending_documents">>("applicant");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const set = (k: "first" | "last" | "preferred") => (x: string) => { setV((o) => ({ ...o, [k]: x })); key.current = newIdempotencyKey(); };
  async function submit() {
    if (!v.first.trim() || !v.last.trim()) return setState({ busy: false, error: "Enter the caregiver's first and last name." });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ caregiver: { caregiverRecordId: string } }>("/v1/caregivers", {
        organizationId: activeOrganizationId, firstName: v.first.trim(), lastName: v.last.trim(), preferredName: v.preferred.trim() || null, status,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null });
      onDone(r.caregiver.caregiverRecordId);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The caregiver was not added.") });
    }
  }
  return (
    <Card>
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-semibold text-slate-950">Add a caregiver</h2>
        <InfoTip>A new person starts as an Applicant or Onboarding. Open their record to see what is left; Approve for work is enabled once background check, training and app sign-in are done.</InfoTip>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-2 grid gap-2 sm:grid-cols-2">
        <NameFields v={v} set={set} idPrefix="new-cg" />
        <div>
          <label htmlFor="new-cg-status" className="block text-xs font-medium text-slate-700">Starting status</label>
          <select id="new-cg-status" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); key.current = newIdempotencyKey(); }} className="mt-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
            {(["applicant", "onboarding"] as const).map((s) => <option key={s} value={s}>{CAREGIVER_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
        <div className="sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Adding…" : "Add caregiver"}</Button></div>
      </form>
    </Card>
  );
}

/** Care Team (0023): caregiver records, their status and whether they can sign in. */
export function CareTeamPage() {
  const { hasPermission } = useOrganization();
  const canManage = hasPermission("caregivers.manage");
  const caregivers = useCaregivers();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<WorkStatus | "current" | "all">("current");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (caregivers.data ?? []).filter((c) => (status === "all" || (status === "current" ? c.workStatus !== "inactive" : c.workStatus === status))
      && (!s || [caregiverName(c), c.caregiverCode].some((x) => x.toLowerCase().includes(s))));
  }, [caregivers.data, search, status]);
  if (!hasPermission("caregivers.manage") && !hasPermission("visits.manage")) return <p className="text-sm text-slate-600">You do not have access to the Care Team.</p>;
  const counts = (caregivers.data ?? []).reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.workStatus]: (acc[c.workStatus] ?? 0) + 1 }), {});
  return (
    <div className="max-w-4xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold tracking-tight text-slate-950">Care Team</h1>
        {canManage ? <Button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close" : "Add caregiver"}</Button> : null}
      </div>
      {adding ? <AddCaregiverForm onDone={(id) => { setAdding(false); setAdded(id); }} /> : null}
      {added ? <p role="status" className="text-sm text-emerald-800">Caregiver added. <Link className="underline" to={`/care-team/${added}`}>Open the record</Link>.</p> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-[220px] flex-1 items-center gap-1.5">
          <label htmlFor="cg-search" className="text-xs font-medium text-slate-700">Search</label>
          <input id="cg-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or code" className="block w-full rounded-lg border border-slate-200 px-2.5 py-1 text-sm md:min-h-8" />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="cg-status" className="text-xs font-medium text-slate-700">Status</label>
          <select id="cg-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="rounded-lg border border-slate-200 px-2 py-1 text-sm md:min-h-8">
            <option value="current">Current ({(caregivers.data ?? []).filter((c) => c.workStatus !== "inactive").length})</option>
            {WORK_STATUSES.map((s) => <option key={s} value={s}>{WORK_STATUS_LABEL[s]} ({counts[s] ?? 0})</option>)}
            <option value="all">All ({caregivers.data?.length ?? 0})</option>
          </select>
        </div>
      </div>
      {caregivers.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {caregivers.isError ? <p role="alert" className="text-sm text-red-700">{(caregivers.error as Error).message}</p> : null}
      {caregivers.data && shown.length === 0 ? <p className="text-sm text-slate-600">No caregivers match.</p> : null}
      {shown.length > 0 ? (
        <div className="rounded-lg border border-slate-200 bg-og-card">
          <table className="w-full text-left text-sm" aria-label="Caregivers">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
                <th scope="col" className="px-3 py-1 font-semibold">Caregiver</th>
                <th scope="col" className="px-3 py-1 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.caregiverRecordId} className="border-b border-slate-100 last:border-0">
                  <th scope="row" className="px-3 py-1 font-normal">
                    <Link to={`/care-team/${c.caregiverRecordId}`} className="inline-flex min-h-[44px] flex-wrap items-baseline gap-x-3 gap-y-0 py-0.5 md:min-h-[30px]">
                      <span className="font-semibold text-slate-950 underline">{nameWithCode(caregiverName(c), c.caregiverCode, c.duplicateName)}</span>
                      <span className={`text-xs font-normal ${c.hasSignIn ? "text-slate-700" : "text-amber-900"}`}>
                        {signInLabel(c)} · {c.activeAssignments} active assignment{c.activeAssignments === 1 ? "" : "s"}{c.openVisits > 0 ? ` · ${c.openVisits} visit in progress` : ""}
                      </span>
                    </Link>
                  </th>
                  <td className="px-3 py-1 align-middle">
                    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${WORK_STATUS_BADGE[c.workStatus]}`}>{WORK_STATUS_LABEL[c.workStatus]}</span>
                    {c.workStatus === "not_ready" && c.readinessTotal ? <span className="ml-2 text-xs text-slate-700">{c.readinessMet ?? 0} of {c.readinessTotal} done</span> : null}
                    {!c.signedIn && c.workStatus !== "inactive" ? <SendSignInLink caregiverRecordId={c.caregiverRecordId} hasContact={!!c.hasContact} canManage={canManage} lastSentAt={c.invitationLastSentAt ?? null} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {/* Status first, then the list, then the control rows: readiness and availability requests are collapsed one-line summaries below the list. */}
      <ReadinessCard />
      <AvailabilityReview />
    </div>
  );
}

function CaregiverDetails({ c }: { c: Caregiver }) {
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const { activeOrganizationId } = useOrganization();
  const [v, setV] = useState({ first: c.firstName, last: c.lastName, preferred: c.preferredName ?? "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  useEffect(() => setV({ first: c.firstName, last: c.lastName, preferred: c.preferredName ?? "" }), [c.firstName, c.lastName, c.preferredName]);
  const set = (k: "first" | "last" | "preferred") => (x: string) => { setV((o) => ({ ...o, [k]: x })); key.current = newIdempotencyKey(); setState((s) => ({ ...s, done: false })); };
  async function save() {
    if (!v.first.trim() || !v.last.trim()) return setState({ busy: false, error: "Enter the caregiver's first and last name.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/details`, {
        organizationId: activeOrganizationId, firstName: v.first.trim(), lastName: v.last.trim(), preferredName: v.preferred.trim() || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved."), done: false });
    }
  }
  return (
    <SummarySection title="Name" summary={caregiverName(c)}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-2 sm:grid-cols-2">
        <NameFields v={v} set={set} idPrefix="edit-cg" />
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
        {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">Saved. The change is in the record's history.</p> : null}
        <div className="flex items-center gap-2 sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save name"}</Button><InfoTip>Past visits keep the name they were recorded with.</InfoTip></div>
      </form>
    </SummarySection>
  );
}

/** One caregiver record (0023). */
const HIRE_LABEL = { direct_hire: "Direct Hire", eor: "EOR (employer of record)" } as const;
const SCHEDULING_LABEL = { fixed: "Fixed — works scheduled shifts", flexible: "Flexible — authorized visits without a scheduled shift" } as const;

/** 0030: hire type and scheduling arrangement are separate facts; neither implies a family relationship. */
function EmploymentCard({ c, canManage }: { c: Caregiver; canManage: boolean }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [hire, setHire] = useState<string>(c.hireType ?? "");
  const [mode, setMode] = useState<string>(c.schedulingMode ?? "fixed");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  async function save() {
    setState({ busy: true, error: null, done: null });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/employment`, { organizationId: activeOrganizationId, hireType: hire || null, schedulingMode: mode },
        { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await qc.invalidateQueries({ queryKey: ["aws-caregivers"] });
      setState({ busy: false, error: null, done: "Saved. Visit rules are unchanged: sign-in, assignment, authorization, confirmation and hour limits still apply." });
    } catch (cause) { setState({ busy: false, error: cause instanceof Error ? cause.message : "Not saved.", done: null }); }
  }
  return (
    <SummarySection title="Hire type and scheduling" summary={`${c.hireType ? HIRE_LABEL[c.hireType] : "Hire type not recorded"} · ${c.schedulingMode === "flexible" ? "Flexible" : "Fixed"}`}>
      {!canManage ? (
        <p className="mt-1 text-sm text-slate-700">{c.hireType ? HIRE_LABEL[c.hireType] : "Hire type not recorded"} · {SCHEDULING_LABEL[c.schedulingMode ?? "fixed"]}</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-2 sm:grid-cols-2">
          <div><label htmlFor="emp-hire" className="block text-xs font-medium text-slate-700">Hire type</label>
            <select id="emp-hire" value={hire} onChange={(e) => { setHire(e.target.value); key.current = newIdempotencyKey(); }} className="mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
              <option value="">Not recorded</option><option value="direct_hire">{HIRE_LABEL.direct_hire}</option><option value="eor">{HIRE_LABEL.eor}</option>
            </select></div>
          <div><label htmlFor="emp-mode" className="block text-xs font-medium text-slate-700">Scheduling</label>
            <select id="emp-mode" value={mode} onChange={(e) => { setMode(e.target.value); key.current = newIdempotencyKey(); }} className="mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
              <option value="fixed">{SCHEDULING_LABEL.fixed}</option><option value="flexible">{SCHEDULING_LABEL.flexible}</option>
            </select></div>
          <p className="flex items-center gap-1.5 text-xs text-slate-600 sm:col-span-2">Family relationship is recorded per client on each assignment.<InfoTip>EOR does not mean family, and Direct Hire does not require fixed shifts.</InfoTip></p>
          {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
          {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">{state.done}</p> : null}
          <div className="sm:col-span-2"><Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Save hire type and scheduling"}</Button></div>
        </form>
      )}
    </SummarySection>
  );
}

/** Hire date (0055): the office may enter one that is not recorded; changing a recorded one is an administrator action, audited with a reason. */
function HireDateForm({ c }: { c: Caregiver }) {
  const readiness = useCaregiverReadiness(c.caregiverRecordId);
  const hireDate = readiness.data?.hireDate ?? null;
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [v, setV] = useState({ date: "", reason: "" });
  useEffect(() => setV((o) => ({ ...o, date: hireDate ?? "" })), [hireDate]);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  async function save() {
    if (!v.date) return setState({ busy: false, error: "Choose the hire date.", done: false });
    if (v.reason.trim().length < 3) return setState({ busy: false, error: "Give a reason for the hire date.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/hire-date`, { organizationId: activeOrganizationId, hireDate: v.date, reason: v.reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      await qc.invalidateQueries({ queryKey: ["caregiver-readiness"] });
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved."), done: false });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-end" aria-label="Hire date">
      <div><label htmlFor="hire-date" className="block text-xs font-medium text-slate-700">Hire date</label><input id="hire-date" type="date" value={v.date} onChange={(e) => { setV((o) => ({ ...o, date: e.target.value })); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      <div><label htmlFor="hire-reason" className="block text-xs font-medium text-slate-700">Reason</label><input id="hire-reason" value={v.reason} maxLength={500} onChange={(e) => { setV((o) => ({ ...o, reason: e.target.value })); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      <Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Save hire date"}</Button>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-3">{state.error}</p> : null}
      {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-3">Saved. The change is in the audit history.</p> : null}
    </form>
  );
}

/** Deactivate is the one manual status. Re-approval (Approve for work) reactivates. Ends assignments and suspends sign-in; refused during a visit. */
function DeactivateForm({ c }: { c: Caregiver }) {
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  async function save() {
    if (reason.trim().length < 3) return setState({ busy: false, error: "Give a reason.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      const r = await api.post<{ result: { endedAssignments: number } }>(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/status`,
        { organizationId: activeOrganizationId, status: "inactive", reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setReason("");
      await refresh();
      await qc.invalidateQueries({ queryKey: ["caregiver-readiness"] });
      setState({ busy: false, error: null, done: `Deactivated.${r.result.endedAssignments > 0 ? ` ${r.result.endedAssignments} assignment${r.result.endedAssignments === 1 ? "" : "s"} ended.` : ""} Their sign-in is suspended for this agency.` });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not deactivated."), done: null });
    }
  }
  // Stays mounted after a successful deactivation so the result (assignments ended, sign-in suspended) is still shown.
  if (c.workStatus === "inactive" && !state.done) return null;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end" aria-label="Deactivate caregiver">
      <div><label htmlFor="deactivate-reason" className="block text-xs font-medium text-slate-700">Deactivate: ends assignments and suspends sign-in. Reason</label>
        <input id="deactivate-reason" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      <Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Deactivate"}</Button>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">{state.done}</p> : null}
    </form>
  );
}

/** Documents are uploaded and reviewed on the Documents page. This is a plain file list: no review or status labels. */
function CaregiverFiles({ caregiverRecordId }: { caregiverRecordId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const docs = useQuery({
    queryKey: ["aws-documents", activeOrganizationId],
    queryFn: async () => (await api.get<{ documents: StaffDocument[] }>("/v1/documents", { organizationId: activeOrganizationId })).documents,
    enabled: !!activeOrganizationId && hasPermission("documents.read"),
  });
  if (!hasPermission("documents.read")) return null;
  const mine = (docs.data ?? []).filter((d) => d.caregiverRecordId === caregiverRecordId && d.latestVersionId);
  return (
    <SummarySection title="Documents" summary={docs.data ? `${mine.length} file${mine.length === 1 ? "" : "s"}` : undefined}>
      {docs.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {docs.isError ? <p role="alert" className="text-sm text-red-700">{message(docs.error, "Documents could not be loaded.")}</p> : null}
      {docs.data && mine.length === 0 ? <p className="text-sm text-slate-700">No files uploaded.</p> : null}
      <ul className="divide-y divide-slate-100">
        {mine.map((d) => <li key={d.documentId} className="py-1 text-sm text-slate-900">{d.documentTypeName}<span className="text-slate-600"> · version {d.latestVersionNumber}{d.latestUploadedAt ? `, uploaded ${formatDateTime(d.latestUploadedAt)}` : ""}</span></li>)}
      </ul>
      <p className="mt-1 text-sm"><Link to="/documents" className="inline-flex min-h-[44px] items-center font-semibold text-slate-900 underline md:min-h-[28px]">Open the Documents page</Link></p>
    </SummarySection>
  );
}

export function CaregiverDetailPage() {
  const { caregiverRecordId } = useParams<{ caregiverRecordId: string }>();
  const { hasPermission } = useOrganization();
  const caregivers = useCaregivers();
  if (!hasPermission("caregivers.manage") && !hasPermission("visits.manage")) return <p className="text-sm text-slate-600">You do not have access to the Care Team.</p>;
  if (caregivers.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (caregivers.isError) return <p role="alert" className="text-sm text-red-700">{(caregivers.error as Error).message}</p>;
  const c = caregivers.data?.find((x) => x.caregiverRecordId === caregiverRecordId);
  if (!c) return <p className="text-sm text-slate-600">Caregiver not found. <Link to="/care-team" className="underline">Back to the Care Team</Link></p>;
  const canManage = hasPermission("caregivers.manage");
  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to="/care-team" className="inline-flex min-h-[44px] items-center text-sm text-slate-700 underline md:min-h-0">← Care Team</Link>
        <h1 className="text-xl font-bold tracking-tight text-slate-950">{caregiverName(c)}</h1>
        <span className="text-xs text-slate-500">{c.caregiverCode}</span>
      </div>
      <ReadinessChecklist caregiverRecordId={c.caregiverRecordId} canManage={canManage} hasContact={!!c.hasContact} />
      <AssignmentsCard caregiverRecordId={c.caregiverRecordId} />
      <CaregiverReadiness caregiverRecordId={c.caregiverRecordId} />
      <CaregiverFiles caregiverRecordId={c.caregiverRecordId} />
      {canManage ? (
        <SummarySection title="Details" summary={`${caregiverName(c)} · ${c.hireType ? HIRE_LABEL[c.hireType] : "Hire type not recorded"}`}>
          <div className="space-y-3">
            <CaregiverDetails c={c} />
            <HireDateForm c={c} />
            <EmploymentCard c={c} canManage={canManage} />
            <DeactivateForm c={c} />
          </div>
        </SummarySection>
      ) : null}
    </div>
  );
}
